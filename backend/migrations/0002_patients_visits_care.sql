-- EZZ Clinic v0.2 — 0002 patients, visits (appointments), dentist-confirmed care (MF12 / CH-012 / CH-018).
-- FICTIONAL / SYNTHETIC DATA ONLY.

CREATE TABLE patient_file_counters (
  clinic_id uuid PRIMARY KEY REFERENCES clinics(id),
  next_no   integer NOT NULL DEFAULT 1 CHECK (next_no > 0)
);

CREATE TABLE patients (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id          uuid NOT NULL REFERENCES clinics(id),
  file_no            integer NOT NULL CHECK (file_no > 0),
  family_name        text NOT NULL CHECK (length(btrim(family_name)) BETWEEN 1 AND 80),
  given_name         text NOT NULL CHECK (length(btrim(given_name)) BETWEEN 1 AND 80),
  name_ar            text CHECK (name_ar IS NULL OR length(name_ar) <= 160),
  date_of_birth      date CHECK (date_of_birth IS NULL OR date_of_birth > DATE '1900-01-01'),
  sex                text CHECK (sex IS NULL OR sex IN ('F', 'M', 'X')),
  phone              text CHECK (phone IS NULL OR phone ~ '^\+?[0-9 ]{6,20}$'),
  -- Elderly / no-phone patients are first-class: IN_PERSON is the default channel (R24 addendum).
  contact_preference text NOT NULL DEFAULT 'IN_PERSON'
                     CHECK (contact_preference IN ('IN_PERSON', 'BASIC_PHONE_CALL', 'SMS', 'NONE')),
  preferred_language text NOT NULL DEFAULT 'fr' CHECK (preferred_language IN ('fr', 'ar')),
  is_synthetic       boolean NOT NULL DEFAULT true CHECK (is_synthetic),
  created_by         uuid NOT NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (clinic_id, file_no),
  UNIQUE (clinic_id, id),
  FOREIGN KEY (clinic_id, created_by) REFERENCES staff (clinic_id, id)
);
CREATE INDEX patients_name ON patients (clinic_id, lower(family_name), lower(given_name));

CREATE TABLE visits (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id         uuid NOT NULL REFERENCES clinics(id),
  patient_id        uuid NOT NULL,
  dentist_id        uuid,
  scheduled_at      timestamptz NOT NULL,
  duration_min      integer NOT NULL DEFAULT 30 CHECK (duration_min BETWEEN 5 AND 480),
  status            text NOT NULL DEFAULT 'SCHEDULED'
                    CHECK (status IN ('SCHEDULED', 'ARRIVED', 'IN_CHAIR', 'COMPLETED', 'NO_SHOW', 'CANCELLED')),
  status_changed_at timestamptz NOT NULL DEFAULT now(),
  status_changed_by uuid NOT NULL,
  status_reason     text,
  created_by        uuid NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (clinic_id, id),
  FOREIGN KEY (clinic_id, patient_id) REFERENCES patients (clinic_id, id),
  FOREIGN KEY (clinic_id, dentist_id) REFERENCES staff (clinic_id, id),
  FOREIGN KEY (clinic_id, created_by) REFERENCES staff (clinic_id, id)
);
CREATE INDEX visits_day ON visits (clinic_id, scheduled_at);
CREATE INDEX visits_patient ON visits (clinic_id, patient_id);

-- Dentist-confirmed care. Immutable. A fee change is a CORRECTION row (delta + reason + link), never an edit.
-- Free care is explicit (fee 0 + reason) so zero-fee visits are not pushed off-book (C-138 T-CARE-5).
CREATE TABLE care_items (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id         uuid NOT NULL REFERENCES clinics(id),
  visit_id          uuid NOT NULL,
  patient_id        uuid NOT NULL,
  kind              text NOT NULL CHECK (kind IN ('CARE', 'CORRECTION')),
  corrects_id       uuid,
  procedure_code    text NOT NULL CHECK (procedure_code ~ '^[A-Z0-9_.-]{2,32}$'),
  procedure_label   text NOT NULL CHECK (length(procedure_label) BETWEEN 2 AND 160),
  -- FDI / ISO 3950 two-digit notation: permanent 11-48 (quadrants 1-4, teeth 1-8), primary 51-85 (quadrants 5-8, teeth 1-5).
  tooth_fdi         smallint CHECK (tooth_fdi IS NULL
                      OR ((tooth_fdi / 10) BETWEEN 1 AND 4 AND (tooth_fdi % 10) BETWEEN 1 AND 8)
                      OR ((tooth_fdi / 10) BETWEEN 5 AND 8 AND (tooth_fdi % 10) BETWEEN 1 AND 5)),
  surfaces          text CHECK (surfaces IS NULL OR surfaces ~ '^[MODBLIFP]{1,5}$'),
  fee_millimes      bigint NOT NULL CHECK (fee_millimes BETWEEN -100000000 AND 100000000),
  reason            text,
  confirmed_by      uuid NOT NULL,
  confirmed_by_role text NOT NULL CHECK (confirmed_by_role = 'DENTIST'),
  confirmed_at      timestamptz NOT NULL DEFAULT now(),
  CHECK (
    (kind = 'CARE' AND corrects_id IS NULL AND fee_millimes >= 0
       AND (fee_millimes > 0 OR length(coalesce(reason, '')) >= 3))
    OR
    (kind = 'CORRECTION' AND corrects_id IS NOT NULL AND fee_millimes <> 0 AND length(coalesce(reason, '')) >= 3)
  ),
  UNIQUE (clinic_id, id),
  FOREIGN KEY (clinic_id, visit_id) REFERENCES visits (clinic_id, id),
  FOREIGN KEY (clinic_id, patient_id) REFERENCES patients (clinic_id, id),
  FOREIGN KEY (clinic_id, corrects_id) REFERENCES care_items (clinic_id, id),
  FOREIGN KEY (clinic_id, confirmed_by) REFERENCES staff (clinic_id, id)
);
CREATE INDEX care_items_visit ON care_items (clinic_id, visit_id);
SELECT ezz_make_append_only('care_items');

SELECT ezz_enable_tenant_rls('patient_file_counters');
SELECT ezz_enable_tenant_rls('patients');
SELECT ezz_enable_tenant_rls('visits');
SELECT ezz_enable_tenant_rls('care_items');

GRANT SELECT, INSERT ON patient_file_counters TO ezz_app;
GRANT UPDATE (next_no) ON patient_file_counters TO ezz_app;
GRANT SELECT, INSERT ON patients TO ezz_app;
-- Contact/name corrections are allowed but always audited with old and new values (MF: no silent phone change).
GRANT UPDATE (phone, contact_preference, preferred_language, family_name, given_name, name_ar) ON patients TO ezz_app;
GRANT SELECT, INSERT ON visits TO ezz_app;
GRANT UPDATE (status, status_changed_at, status_changed_by, status_reason, dentist_id, scheduled_at) ON visits TO ezz_app;
GRANT SELECT, INSERT ON care_items TO ezz_app;
