-- EZZ Clinic v0.2 — 0008 dentist clinical core (B07): site amendments, medical alerts and history reviews,
-- alert acknowledgement, signed clinical notes, chart findings, treatment plan items.
-- FICTIONAL / SYNTHETIC DATA ONLY. Follows docs/clinical-domain/clinical-requirements.md §16 conventions:
-- clinic_id + composite FKs, tenant RLS, append-only rows, corrections are new linked rows with a reason,
-- authors carry a *_role CHECK. Clinical rules marked PROVISIONAL need a Tunisian dentist's confirmation.
-- No money column exists in any clinical table: a clinical correction cannot change a fee or balance.

-- Composite keys so clinical rows can prove (by FK) that they belong to the same visit/patient as the
-- care item they reference. Additive; existing rows untouched.
ALTER TABLE care_items ADD CONSTRAINT care_items_visit_patient_key UNIQUE (clinic_id, id, visit_id, patient_id);
ALTER TABLE care_items ADD CONSTRAINT care_items_patient_key UNIQUE (clinic_id, id, patient_id);
ALTER TABLE visits ADD CONSTRAINT visits_patient_key UNIQUE (clinic_id, id, patient_id);

-- CH-032 structural site rule for NEW care rows: surfaces need a tooth and never repeat a letter.
-- NOT VALID: legacy rows written by the old loose route are kept as evidence (they can be amended below).
-- Anatomical letter rules stay in the application validator (provisional, clinician-reviewable).
ALTER TABLE care_items ADD CONSTRAINT care_items_site_shape
  CHECK (kind <> 'CARE' OR surfaces IS NULL OR (tooth_fdi IS NOT NULL AND surfaces !~ '(.).*\1')) NOT VALID;

-- Site amendments (C-172, CH-032): a dentist-signed correction of the tooth/surfaces of a confirmed CARE item.
-- The original row is never changed. Amendments form ONE linear chain per care item (unique parent), and
-- the trigger below proves previous_* equals the site being replaced, so history cannot be rewritten.
CREATE TABLE care_site_amendments (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id          uuid NOT NULL REFERENCES clinics(id),
  care_item_id       uuid NOT NULL,
  visit_id           uuid NOT NULL,
  patient_id         uuid NOT NULL,
  supersedes_id      uuid,
  previous_tooth_fdi smallint,
  previous_surfaces  text,
  tooth_fdi          smallint CHECK (tooth_fdi IS NULL
                       OR ((tooth_fdi / 10) BETWEEN 1 AND 4 AND (tooth_fdi % 10) BETWEEN 1 AND 8)
                       OR ((tooth_fdi / 10) BETWEEN 5 AND 8 AND (tooth_fdi % 10) BETWEEN 1 AND 5)),
  surfaces           text CHECK (surfaces IS NULL OR (surfaces ~ '^[MOIDBFLP]{1,5}$' AND surfaces !~ '(.).*\1')),
  reason_code        text NOT NULL CHECK (reason_code IN ('WRONG_TOOTH', 'WRONG_SURFACE', 'WRONG_TOOTH_AND_SURFACE', 'TRANSCRIPTION', 'OTHER')),
  reason_note        text CHECK (reason_note IS NULL OR length(reason_note) BETWEEN 3 AND 300),
  amended_by         uuid NOT NULL,
  amended_by_role    text NOT NULL CHECK (amended_by_role = 'DENTIST'),
  amended_at         timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (surfaces IS NULL OR tooth_fdi IS NOT NULL),
  CHECK (reason_code <> 'OTHER' OR reason_note IS NOT NULL),
  CHECK (tooth_fdi IS DISTINCT FROM previous_tooth_fdi OR surfaces IS DISTINCT FROM previous_surfaces),
  UNIQUE (clinic_id, id),
  UNIQUE (clinic_id, care_item_id, id),
  FOREIGN KEY (clinic_id, care_item_id, visit_id, patient_id) REFERENCES care_items (clinic_id, id, visit_id, patient_id),
  FOREIGN KEY (clinic_id, care_item_id, supersedes_id) REFERENCES care_site_amendments (clinic_id, care_item_id, id),
  FOREIGN KEY (clinic_id, amended_by) REFERENCES staff (clinic_id, id)
);
-- Exactly one first amendment and at most one successor per amendment => a linear chain, never a fork.
CREATE UNIQUE INDEX care_site_amendments_one_head ON care_site_amendments
  (clinic_id, care_item_id, coalesce(supersedes_id, '00000000-0000-0000-0000-000000000000'::uuid));
CREATE INDEX care_site_amendments_visit ON care_site_amendments (clinic_id, visit_id);

CREATE FUNCTION ezz_check_site_amendment() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE prev_t smallint; prev_s text; kind_ text;
BEGIN
  IF NEW.supersedes_id IS NULL THEN
    SELECT tooth_fdi, surfaces, kind INTO prev_t, prev_s, kind_ FROM care_items WHERE clinic_id = NEW.clinic_id AND id = NEW.care_item_id;
    IF kind_ IS DISTINCT FROM 'CARE' THEN
      RAISE EXCEPTION 'site amendments apply to CARE items only' USING ERRCODE = '23514';
    END IF;
  ELSE
    SELECT tooth_fdi, surfaces INTO prev_t, prev_s FROM care_site_amendments WHERE clinic_id = NEW.clinic_id AND id = NEW.supersedes_id;
  END IF;
  IF NEW.previous_tooth_fdi IS DISTINCT FROM prev_t OR NEW.previous_surfaces IS DISTINCT FROM prev_s THEN
    RAISE EXCEPTION 'previous site does not match the site being amended' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER care_site_amendments_previous BEFORE INSERT ON care_site_amendments FOR EACH ROW EXECUTE FUNCTION ezz_check_site_amendment();
SELECT ezz_make_append_only('care_site_amendments');

-- Effective site of every CARE item = site of the amendment chain head (the amendment nobody supersedes),
-- else the original site. A head may set the tooth to NULL, so this is a CASE, not a coalesce.
-- security_invoker => the caller's RLS applies, as for visit_balances.
CREATE VIEW care_effective_sites WITH (security_invoker = true) AS
SELECT c.clinic_id, c.id AS care_item_id, c.visit_id, c.patient_id,
  CASE WHEN h.id IS NULL THEN c.tooth_fdi ELSE h.tooth_fdi END AS tooth_fdi,
  CASE WHEN h.id IS NULL THEN c.surfaces ELSE h.surfaces END AS surfaces,
  h.id AS head_amendment_id,
  (SELECT count(*) FROM care_site_amendments x WHERE x.clinic_id = c.clinic_id AND x.care_item_id = c.id)::int AS amendment_count
FROM care_items c
LEFT JOIN care_site_amendments h ON h.clinic_id = c.clinic_id AND h.care_item_id = c.id
  AND NOT EXISTS (SELECT 1 FROM care_site_amendments s WHERE s.clinic_id = h.clinic_id AND s.supersedes_id = h.id)
WHERE c.kind = 'CARE';

-- Medical alerts (clinical-requirements §5.1/5.2). Each alert is a chain of immutable revisions
-- (chain_id, revision 1..n); the current state is the highest revision. PATIENT_DECLARED alerts may be
-- entered at the desk; DENTIST_VERIFIED only by a dentist. Codes are PROVISIONAL (dentist review, Q5).
CREATE TABLE medical_alerts (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id     uuid NOT NULL REFERENCES clinics(id),
  patient_id    uuid NOT NULL,
  chain_id      uuid NOT NULL,
  revision      integer NOT NULL CHECK (revision BETWEEN 1 AND 1000),
  code          text NOT NULL CHECK (code ~ '^[A-Z][A-Z0-9_]{2,40}$'),
  severity      text NOT NULL CHECK (severity IN ('CRITICAL', 'CAUTION')),
  detail        text CHECK (detail IS NULL OR length(detail) BETWEEN 1 AND 300),
  source        text NOT NULL CHECK (source IN ('PATIENT_DECLARED', 'DENTIST_VERIFIED')),
  status        text NOT NULL CHECK (status IN ('ACTIVE', 'RESOLVED', 'ENTERED_IN_ERROR')),
  reason        text CHECK (reason IS NULL OR length(reason) BETWEEN 3 AND 300),
  recorded_by   uuid NOT NULL,
  recorded_role text NOT NULL CHECK (recorded_role IN ('DENTIST', 'RECEPTIONIST', 'ASSISTANT')),
  recorded_at   timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (source <> 'DENTIST_VERIFIED' OR recorded_role = 'DENTIST'),
  CHECK (revision = 1 OR recorded_role = 'DENTIST'),
  CHECK (revision > 1 OR status = 'ACTIVE'),
  CHECK (status = 'ACTIVE' OR reason IS NOT NULL),
  CHECK (code <> 'OTHER' OR detail IS NOT NULL),
  UNIQUE (clinic_id, id),
  UNIQUE (clinic_id, chain_id, revision),
  FOREIGN KEY (clinic_id, patient_id) REFERENCES patients (clinic_id, id),
  FOREIGN KEY (clinic_id, recorded_by) REFERENCES staff (clinic_id, id)
);
CREATE INDEX medical_alerts_patient ON medical_alerts (clinic_id, patient_id, chain_id, revision DESC);
SELECT ezz_make_append_only('medical_alerts');

-- Dated medical-history review by the dentist (§5.2). "No known allergies" is an explicit, dated assertion;
-- no review row at all means "never asked". alert_set_sha256 pins exactly which alert revisions were seen.
CREATE TABLE medical_history_reviews (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id          uuid NOT NULL REFERENCES clinics(id),
  patient_id         uuid NOT NULL,
  visit_id           uuid,
  method             text NOT NULL CHECK (method IN ('INTERVIEW', 'PAPER_FORM')),
  no_known_allergies boolean NOT NULL,
  alert_set_sha256   text NOT NULL CHECK (alert_set_sha256 ~ '^[0-9a-f]{64}$'),
  next_review_due    date NOT NULL,
  note               text CHECK (note IS NULL OR length(note) BETWEEN 1 AND 500),
  reviewed_by        uuid NOT NULL,
  reviewed_role      text NOT NULL CHECK (reviewed_role = 'DENTIST'),
  reviewed_at        timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (clinic_id, id),
  FOREIGN KEY (clinic_id, patient_id) REFERENCES patients (clinic_id, id),
  FOREIGN KEY (clinic_id, visit_id, patient_id) REFERENCES visits (clinic_id, id, patient_id),
  FOREIGN KEY (clinic_id, reviewed_by) REFERENCES staff (clinic_id, id)
);
CREATE INDEX medical_history_reviews_patient ON medical_history_reviews (clinic_id, patient_id, reviewed_at DESC);
SELECT ezz_make_append_only('medical_history_reviews');

-- Display-before-treatment acknowledgement (§5.3): the dentist saw this exact alert set for this visit.
-- Written explicitly, or implicitly when care is confirmed with the alertSetHash the dentist was shown.
CREATE TABLE alert_acknowledgements (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id          uuid NOT NULL REFERENCES clinics(id),
  visit_id           uuid NOT NULL,
  patient_id         uuid NOT NULL,
  alert_set_sha256   text NOT NULL CHECK (alert_set_sha256 ~ '^[0-9a-f]{64}$'),
  active_alert_count integer NOT NULL CHECK (active_alert_count >= 0),
  via                text NOT NULL CHECK (via IN ('EXPLICIT', 'CARE_CONFIRMATION', 'PLAN_PERFORM')),
  acknowledged_by    uuid NOT NULL,
  acknowledged_role  text NOT NULL CHECK (acknowledged_role = 'DENTIST'),
  acknowledged_at    timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (clinic_id, id),
  FOREIGN KEY (clinic_id, visit_id, patient_id) REFERENCES visits (clinic_id, id, patient_id),
  FOREIGN KEY (clinic_id, acknowledged_by) REFERENCES staff (clinic_id, id)
);
CREATE INDEX alert_acknowledgements_visit ON alert_acknowledgements (clinic_id, visit_id, acknowledged_at DESC);
SELECT ezz_make_append_only('alert_acknowledgements');

-- Signed clinical notes (§4). Signed at creation by the authenticated dentist; never edited. ADDENDUM adds
-- information, LATE_ENTRY documents an earlier moment (reason required), ENTERED_IN_ERROR strikes a note
-- (reason required, no new text). content_sha256 is the hash written to the audit chain instead of the text.
CREATE TABLE clinical_notes (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id      uuid NOT NULL REFERENCES clinics(id),
  patient_id     uuid NOT NULL,
  visit_id       uuid NOT NULL,
  kind           text NOT NULL CHECK (kind IN ('NOTE', 'ADDENDUM', 'LATE_ENTRY', 'ENTERED_IN_ERROR')),
  parent_note_id uuid,
  subjective     text CHECK (subjective IS NULL OR length(subjective) BETWEEN 1 AND 4000),
  objective      text CHECK (objective IS NULL OR length(objective) BETWEEN 1 AND 4000),
  assessment     text CHECK (assessment IS NULL OR length(assessment) BETWEEN 1 AND 4000),
  plan           text CHECK (plan IS NULL OR length(plan) BETWEEN 1 AND 4000),
  effective_at   timestamptz NOT NULL,
  reason         text CHECK (reason IS NULL OR length(reason) BETWEEN 3 AND 300),
  content_sha256 text NOT NULL CHECK (content_sha256 ~ '^[0-9a-f]{64}$'),
  signed_by      uuid NOT NULL,
  signed_role    text NOT NULL CHECK (signed_role = 'DENTIST'),
  signed_at      timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK ((kind IN ('NOTE', 'LATE_ENTRY')) = (parent_note_id IS NULL)),
  CHECK (kind = 'ENTERED_IN_ERROR' OR num_nonnulls(subjective, objective, assessment, plan) >= 1),
  CHECK (kind <> 'ENTERED_IN_ERROR' OR num_nonnulls(subjective, objective, assessment, plan) = 0),
  CHECK (kind NOT IN ('LATE_ENTRY', 'ENTERED_IN_ERROR') OR reason IS NOT NULL),
  CHECK (kind <> 'LATE_ENTRY' OR effective_at < signed_at),
  UNIQUE (clinic_id, id),
  UNIQUE (clinic_id, id, patient_id),
  FOREIGN KEY (clinic_id, visit_id, patient_id) REFERENCES visits (clinic_id, id, patient_id),
  FOREIGN KEY (clinic_id, parent_note_id, patient_id) REFERENCES clinical_notes (clinic_id, id, patient_id),
  FOREIGN KEY (clinic_id, signed_by) REFERENCES staff (clinic_id, id)
);
CREATE UNIQUE INDEX clinical_notes_one_strike ON clinical_notes (clinic_id, parent_note_id) WHERE kind = 'ENTERED_IN_ERROR';
CREATE INDEX clinical_notes_visit ON clinical_notes (clinic_id, visit_id, signed_at);
CREATE INDEX clinical_notes_patient ON clinical_notes (clinic_id, patient_id, signed_at);
SELECT ezz_make_append_only('clinical_notes');

-- Odontogram data layer (§2): EXISTING work / FINDING observations on a tooth (+surfaces) or an ISO 3950
-- area. Never billable. A wrong entry is struck by an ENTERED_IN_ERROR row (once), never edited.
CREATE TABLE chart_findings (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id              uuid NOT NULL REFERENCES clinics(id),
  patient_id             uuid NOT NULL,
  visit_id               uuid NOT NULL,
  kind                   text NOT NULL CHECK (kind IN ('EXISTING', 'FINDING', 'ENTERED_IN_ERROR')),
  entered_in_error_of_id uuid,
  tooth_fdi              smallint CHECK (tooth_fdi IS NULL
                           OR ((tooth_fdi / 10) BETWEEN 1 AND 4 AND (tooth_fdi % 10) BETWEEN 1 AND 8)
                           OR ((tooth_fdi / 10) BETWEEN 5 AND 8 AND (tooth_fdi % 10) BETWEEN 1 AND 5)),
  area_code              smallint CHECK (area_code IS NULL OR area_code IN (0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 20, 30, 40)),
  surfaces               text CHECK (surfaces IS NULL OR (surfaces ~ '^[MOIDBFLP]{1,5}$' AND surfaces !~ '(.).*\1')),
  condition_code         text CHECK (condition_code IS NULL OR condition_code ~ '^[A-Z][A-Z0-9_]{1,40}$'),
  note                   text CHECK (note IS NULL OR length(note) BETWEEN 1 AND 500),
  reason                 text CHECK (reason IS NULL OR length(reason) BETWEEN 3 AND 300),
  recorded_by            uuid NOT NULL,
  recorded_role          text NOT NULL CHECK (recorded_role = 'DENTIST'),
  recorded_at            timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (num_nonnulls(tooth_fdi, area_code) <= 1),
  CHECK (surfaces IS NULL OR tooth_fdi IS NOT NULL),
  CHECK ((kind = 'ENTERED_IN_ERROR') = (entered_in_error_of_id IS NOT NULL)),
  CHECK (kind <> 'ENTERED_IN_ERROR' OR (reason IS NOT NULL AND num_nonnulls(tooth_fdi, area_code, surfaces, condition_code, note) = 0)),
  CHECK (kind = 'ENTERED_IN_ERROR' OR (condition_code IS NOT NULL AND num_nonnulls(tooth_fdi, area_code) = 1)),
  UNIQUE (clinic_id, id),
  UNIQUE (clinic_id, id, patient_id),
  FOREIGN KEY (clinic_id, visit_id, patient_id) REFERENCES visits (clinic_id, id, patient_id),
  FOREIGN KEY (clinic_id, entered_in_error_of_id, patient_id) REFERENCES chart_findings (clinic_id, id, patient_id),
  FOREIGN KEY (clinic_id, recorded_by) REFERENCES staff (clinic_id, id)
);
CREATE UNIQUE INDEX chart_findings_one_strike ON chart_findings (clinic_id, entered_in_error_of_id) WHERE kind = 'ENTERED_IN_ERROR';
CREATE INDEX chart_findings_patient ON chart_findings (clinic_id, patient_id, recorded_at);
CREATE INDEX chart_findings_visit ON chart_findings (clinic_id, visit_id, recorded_at);
SELECT ezz_make_append_only('chart_findings');

-- Treatment plan items (§3, first slice: unversioned items; versions/quotes/consent come later and can wrap
-- these rows additively). estimated_fee_millimes is a QUOTE, never a charge: only a confirmed care item bills.
CREATE TABLE treatment_plan_items (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id              uuid NOT NULL REFERENCES clinics(id),
  patient_id             uuid NOT NULL,
  created_in_visit_id    uuid,
  procedure_code         text NOT NULL CHECK (procedure_code ~ '^[A-Z0-9_.-]{2,32}$'),
  procedure_label        text NOT NULL CHECK (length(procedure_label) BETWEEN 2 AND 160),
  tooth_fdi              smallint CHECK (tooth_fdi IS NULL
                           OR ((tooth_fdi / 10) BETWEEN 1 AND 4 AND (tooth_fdi % 10) BETWEEN 1 AND 8)
                           OR ((tooth_fdi / 10) BETWEEN 5 AND 8 AND (tooth_fdi % 10) BETWEEN 1 AND 5)),
  surfaces               text CHECK (surfaces IS NULL OR (surfaces ~ '^[MOIDBFLP]{1,5}$' AND surfaces !~ '(.).*\1')),
  phase_no               smallint NOT NULL DEFAULT 2 CHECK (phase_no BETWEEN 1 AND 4),
  estimated_fee_millimes bigint CHECK (estimated_fee_millimes IS NULL OR estimated_fee_millimes BETWEEN 0 AND 100000000),
  note                   text CHECK (note IS NULL OR length(note) BETWEEN 1 AND 500),
  created_by             uuid NOT NULL,
  created_role           text NOT NULL CHECK (created_role = 'DENTIST'),
  created_at             timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (surfaces IS NULL OR tooth_fdi IS NOT NULL),
  UNIQUE (clinic_id, id),
  UNIQUE (clinic_id, id, patient_id),
  FOREIGN KEY (clinic_id, patient_id) REFERENCES patients (clinic_id, id),
  FOREIGN KEY (clinic_id, created_in_visit_id, patient_id) REFERENCES visits (clinic_id, id, patient_id),
  FOREIGN KEY (clinic_id, created_by) REFERENCES staff (clinic_id, id)
);
CREATE INDEX treatment_plan_items_patient ON treatment_plan_items (clinic_id, patient_id, created_at);
SELECT ezz_make_append_only('treatment_plan_items');

-- Plan item status history. PROPOSED is implicit (no event). seq makes concurrent status changes collide;
-- at most one terminal event per item; COMPLETED only by linking a confirmed care item of the SAME patient,
-- and one care item completes at most one plan item.
CREATE TABLE plan_item_events (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id    uuid NOT NULL REFERENCES clinics(id),
  plan_item_id uuid NOT NULL,
  patient_id   uuid NOT NULL,
  seq          integer NOT NULL CHECK (seq BETWEEN 1 AND 100),
  status       text NOT NULL CHECK (status IN ('ACCEPTED', 'DECLINED', 'CANCELLED', 'COMPLETED')),
  care_item_id uuid,
  reason       text CHECK (reason IS NULL OR length(reason) BETWEEN 3 AND 300),
  by_staff_id  uuid NOT NULL,
  by_role      text NOT NULL CHECK (by_role = 'DENTIST'),
  at           timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK ((status = 'COMPLETED') = (care_item_id IS NOT NULL)),
  CHECK (status NOT IN ('DECLINED', 'CANCELLED') OR reason IS NOT NULL),
  UNIQUE (clinic_id, id),
  UNIQUE (clinic_id, plan_item_id, seq),
  FOREIGN KEY (clinic_id, plan_item_id, patient_id) REFERENCES treatment_plan_items (clinic_id, id, patient_id),
  FOREIGN KEY (clinic_id, care_item_id, patient_id) REFERENCES care_items (clinic_id, id, patient_id),
  FOREIGN KEY (clinic_id, by_staff_id) REFERENCES staff (clinic_id, id)
);
CREATE UNIQUE INDEX plan_item_events_one_terminal ON plan_item_events (clinic_id, plan_item_id) WHERE status IN ('DECLINED', 'CANCELLED', 'COMPLETED');
CREATE UNIQUE INDEX plan_item_events_one_care ON plan_item_events (clinic_id, care_item_id) WHERE care_item_id IS NOT NULL;
SELECT ezz_make_append_only('plan_item_events');

SELECT ezz_enable_tenant_rls('care_site_amendments');
SELECT ezz_enable_tenant_rls('medical_alerts');
SELECT ezz_enable_tenant_rls('medical_history_reviews');
SELECT ezz_enable_tenant_rls('alert_acknowledgements');
SELECT ezz_enable_tenant_rls('clinical_notes');
SELECT ezz_enable_tenant_rls('chart_findings');
SELECT ezz_enable_tenant_rls('treatment_plan_items');
SELECT ezz_enable_tenant_rls('plan_item_events');

GRANT SELECT, INSERT ON care_site_amendments, medical_alerts, medical_history_reviews, alert_acknowledgements,
  clinical_notes, chart_findings, treatment_plan_items, plan_item_events TO ezz_app;
GRANT SELECT ON care_effective_sites TO ezz_app;
