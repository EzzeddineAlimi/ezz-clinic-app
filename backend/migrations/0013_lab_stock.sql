-- EZZ Clinic v0.2 — 0013 (R73-E): dental lab cases and basic stock control. FICTIONAL / SYNTHETIC DATA ONLY.
-- Lab: a dentist's order to a lab and its round trips (clinical-requirements §9); no automatic prescription, no
-- supplier integration. A case that is RECEIVED or FITTED without a linked confirmed care item for longer than the
-- clinic's lab_unbilled_days feeds the owner exception list (MF19). Lab invoices are clinic EXPENSES, never patient
-- billing. Stock: an append-only movement ledger per item; on-hand = sum of movements and never negative.

ALTER TABLE clinic_setting_changes DROP CONSTRAINT clinic_setting_changes_key_check;
ALTER TABLE clinic_setting_changes ADD CONSTRAINT clinic_setting_changes_key_check
  CHECK (key IN ('timezone', 'checkpoint_due_days', 'not_arrived_grace_minutes', 'lab_unbilled_days'));

CREATE TABLE lab_suppliers (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id   uuid NOT NULL REFERENCES clinics(id),
  name        text NOT NULL CHECK (length(btrim(name)) BETWEEN 2 AND 120),
  contact     text CHECK (contact IS NULL OR length(contact) <= 200),
  created_by  uuid NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (clinic_id, id),
  FOREIGN KEY (clinic_id, created_by) REFERENCES staff (clinic_id, id)
);
CREATE UNIQUE INDEX lab_suppliers_name ON lab_suppliers (clinic_id, lower(btrim(name)));

CREATE TABLE lab_cases (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id          uuid NOT NULL REFERENCES clinics(id),
  patient_id         uuid NOT NULL,
  visit_id           uuid,
  supplier_id        uuid NOT NULL,
  case_type          text NOT NULL CHECK (case_type IN ('CROWN', 'BRIDGE', 'INLAY_ONLAY', 'VENEER', 'PARTIAL_DENTURE', 'COMPLETE_DENTURE',
                       'NIGHT_GUARD', 'ALIGNER', 'REPAIR', 'OTHER')),
  teeth              smallint[] NOT NULL DEFAULT '{}' CHECK (cardinality(teeth) <= 32),
  area_code          smallint CHECK (area_code IN (0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 20, 30, 40)),
  material           text CHECK (material IS NULL OR length(btrim(material)) BETWEEN 1 AND 80),
  shade              text CHECK (shade IS NULL OR length(btrim(shade)) BETWEEN 1 AND 40),
  impression         text NOT NULL CHECK (impression IN ('PHYSICAL', 'DIGITAL_SCAN')),
  instructions       text CHECK (instructions IS NULL OR length(instructions) <= 1000),
  due_on             date,
  remake_of_id       uuid,
  remake_responsibility text CHECK (remake_responsibility IN ('LAB', 'CLINIC', 'PATIENT')),
  created_by         uuid NOT NULL,
  created_role       text NOT NULL CHECK (created_role IN ('DENTIST', 'ASSISTANT')),
  created_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (clinic_id, id),
  CHECK ((remake_of_id IS NULL) = (remake_responsibility IS NULL)),
  FOREIGN KEY (clinic_id, patient_id) REFERENCES patients (clinic_id, id),
  FOREIGN KEY (clinic_id, visit_id, patient_id) REFERENCES visits (clinic_id, id, patient_id),
  FOREIGN KEY (clinic_id, supplier_id) REFERENCES lab_suppliers (clinic_id, id),
  FOREIGN KEY (clinic_id, remake_of_id) REFERENCES lab_cases (clinic_id, id),
  FOREIGN KEY (clinic_id, created_by) REFERENCES staff (clinic_id, id)
);
CREATE INDEX lab_cases_patient ON lab_cases (clinic_id, patient_id, created_at DESC);

-- Lifecycle; the current status is the highest seq (none = CREATED). Transitions are enforced by the application
-- under a per-case lock; UNIQUE (case_id, seq) makes two concurrent transitions impossible.
CREATE TABLE lab_case_events (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id    uuid NOT NULL REFERENCES clinics(id),
  case_id      uuid NOT NULL,
  seq          integer NOT NULL CHECK (seq >= 1),
  status       text NOT NULL CHECK (status IN ('SENT', 'TRY_IN_RETURNED', 'RESENT', 'RECEIVED', 'FITTED', 'REMAKE_REQUESTED', 'CANCELLED')),
  reason       text CHECK (reason IS NULL OR length(btrim(reason)) BETWEEN 3 AND 300),
  by_staff_id  uuid NOT NULL,
  by_role      text NOT NULL CHECK (by_role IN ('DENTIST', 'ASSISTANT')),
  at           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (clinic_id, id),
  UNIQUE (case_id, seq),
  CHECK (status NOT IN ('REMAKE_REQUESTED', 'CANCELLED') OR reason IS NOT NULL),
  CHECK (status NOT IN ('FITTED', 'REMAKE_REQUESTED', 'CANCELLED') OR by_role = 'DENTIST'),
  FOREIGN KEY (clinic_id, case_id) REFERENCES lab_cases (clinic_id, id),
  FOREIGN KEY (clinic_id, by_staff_id) REFERENCES staff (clinic_id, id)
);

-- A dentist links the confirmed (billable) care item(s) the lab work belongs to; same patient enforced by the app.
CREATE TABLE lab_case_care_links (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id     uuid NOT NULL REFERENCES clinics(id),
  case_id       uuid NOT NULL,
  care_item_id  uuid NOT NULL,
  linked_by     uuid NOT NULL,
  linked_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (clinic_id, id),
  UNIQUE (case_id, care_item_id),
  FOREIGN KEY (clinic_id, case_id) REFERENCES lab_cases (clinic_id, id),
  FOREIGN KEY (clinic_id, care_item_id) REFERENCES care_items (clinic_id, id),
  FOREIGN KEY (clinic_id, linked_by) REFERENCES staff (clinic_id, id)
);

CREATE TABLE lab_invoices (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id       uuid NOT NULL REFERENCES clinics(id),
  supplier_id     uuid NOT NULL,
  invoice_number  text NOT NULL CHECK (length(btrim(invoice_number)) BETWEEN 1 AND 60),
  invoice_date    date NOT NULL,
  amount_millimes bigint NOT NULL CHECK (amount_millimes > 0 AND amount_millimes <= 100000000),
  recorded_by     uuid NOT NULL,
  recorded_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (clinic_id, id),
  UNIQUE (clinic_id, supplier_id, invoice_number),
  FOREIGN KEY (clinic_id, supplier_id) REFERENCES lab_suppliers (clinic_id, id),
  FOREIGN KEY (clinic_id, recorded_by) REFERENCES staff (clinic_id, id)
);
CREATE TABLE lab_invoice_cases (
  clinic_id   uuid NOT NULL REFERENCES clinics(id),
  invoice_id  uuid NOT NULL,
  case_id     uuid NOT NULL,
  PRIMARY KEY (invoice_id, case_id),
  FOREIGN KEY (clinic_id, invoice_id) REFERENCES lab_invoices (clinic_id, id),
  FOREIGN KEY (clinic_id, case_id) REFERENCES lab_cases (clinic_id, id)
);

CREATE TABLE stock_items (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id      uuid NOT NULL REFERENCES clinics(id),
  name           text NOT NULL CHECK (length(btrim(name)) BETWEEN 2 AND 120),
  unit           text NOT NULL CHECK (length(btrim(unit)) BETWEEN 1 AND 20),
  reorder_level  integer CHECK (reorder_level IS NULL OR reorder_level BETWEEN 0 AND 1000000),
  created_by     uuid NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (clinic_id, id),
  FOREIGN KEY (clinic_id, created_by) REFERENCES staff (clinic_id, id)
);
CREATE UNIQUE INDEX stock_items_name ON stock_items (clinic_id, lower(btrim(name)));

CREATE TABLE stock_movements (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id   uuid NOT NULL REFERENCES clinics(id),
  item_id     uuid NOT NULL,
  seq         integer NOT NULL CHECK (seq >= 1), -- per item; NOT the timestamp, which is the transaction start time
  kind        text NOT NULL CHECK (kind IN ('RECEIVED', 'USED', 'ADJUSTED', 'DISCARDED')),
  quantity    integer NOT NULL CHECK (quantity <> 0 AND abs(quantity) <= 1000000),
  lot         text CHECK (lot IS NULL OR length(btrim(lot)) BETWEEN 1 AND 60),
  expires_on  date,
  reason      text CHECK (reason IS NULL OR length(btrim(reason)) BETWEEN 3 AND 300),
  on_hand_after integer NOT NULL CHECK (on_hand_after >= 0),
  by_staff_id uuid NOT NULL,
  at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (clinic_id, id),
  UNIQUE (item_id, seq),
  CHECK (kind <> 'RECEIVED' OR quantity > 0),
  CHECK (kind NOT IN ('USED', 'DISCARDED') OR quantity < 0),
  CHECK (kind NOT IN ('ADJUSTED', 'DISCARDED') OR reason IS NOT NULL),
  CHECK (kind = 'RECEIVED' OR (lot IS NULL AND expires_on IS NULL)),
  FOREIGN KEY (clinic_id, item_id) REFERENCES stock_items (clinic_id, id),
  FOREIGN KEY (clinic_id, by_staff_id) REFERENCES staff (clinic_id, id)
);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['lab_suppliers', 'lab_cases', 'lab_case_events', 'lab_case_care_links', 'lab_invoices', 'lab_invoice_cases', 'stock_items', 'stock_movements'] LOOP
    PERFORM ezz_make_append_only(t);
    PERFORM ezz_enable_tenant_rls(t);
    EXECUTE format('GRANT SELECT, INSERT ON %I TO ezz_app', t);
  END LOOP;
END $$;
