-- EZZ Clinic v0.2 — 0012 (R73-D): patient documents and dental imaging ATTACHMENTS (storage + metadata only).
-- No interpretation, measurement or diagnosis of any image. FICTIONAL / SYNTHETIC DATA ONLY.
--   document_blobs            bytes of the PostgreSQL blob store (a replaceable foundation, NOT a production storage
--                             decision); append-only, no DELETE for the application role.
--   patient_documents         immutable metadata, declared by the uploader before the bytes arrive.
--   patient_document_events   append-only lifecycle: CONTENT_STORED (QUARANTINE) -> SCREEN_PASSED (ACTIVE) |
--                             SCREEN_REJECTED (REJECTED); ENTERED_IN_ERROR from any state (dentist, reason).
--                             The current state is the event with the highest seq; none = AWAITING_CONTENT.
--   document_deletion_requests  owner requests that WAIT for an approved retention policy; nothing executes them.

-- Lets a document reference (visit, patient) as a pair so a visit of another patient can never be attached.
ALTER TABLE visits ADD CONSTRAINT visits_clinic_id_patient UNIQUE (clinic_id, id, patient_id);

CREATE TABLE document_blobs (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id   uuid NOT NULL REFERENCES clinics(id),
  sha256      text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  size_bytes  integer NOT NULL CHECK (size_bytes BETWEEN 1 AND 20971520),
  content     bytea NOT NULL,
  stored_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (clinic_id, id),
  CHECK (octet_length(content) = size_bytes)
);
ALTER TABLE document_blobs ALTER COLUMN content SET STORAGE EXTERNAL; -- images/PDFs are already compressed
SELECT ezz_make_append_only('document_blobs');
SELECT ezz_enable_tenant_rls('document_blobs');
GRANT SELECT, INSERT ON document_blobs TO ezz_app;

CREATE TABLE patient_documents (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id          uuid NOT NULL REFERENCES clinics(id),
  patient_id         uuid NOT NULL,
  visit_id           uuid,
  modality           text NOT NULL CHECK (modality IN ('INTRAORAL_PERIAPICAL', 'BITEWING', 'OCCLUSAL', 'PANORAMIC_OPG', 'CEPHALOMETRIC',
                       'CBCT', 'INTRAORAL_PHOTO', 'EXTRAORAL_PHOTO', 'SCAN_3D', 'DOCUMENT_SCAN')),
  title              text NOT NULL CHECK (length(btrim(title)) BETWEEN 1 AND 120),
  teeth              smallint[] NOT NULL DEFAULT '{}' CHECK (cardinality(teeth) <= 32),
  area_code          smallint CHECK (area_code IN (0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 20, 30, 40)),
  acquired_on        date,
  source             text NOT NULL CHECK (source IN ('IN_CLINIC_SENSOR', 'EXTERNAL_RADIOLOGY', 'PATIENT_BROUGHT')),
  declared_type      text NOT NULL CHECK (declared_type IN ('image/jpeg', 'image/png', 'application/pdf', 'application/dicom')),
  declared_size      integer NOT NULL CHECK (declared_size BETWEEN 1 AND 20971520),
  declared_sha256    text NOT NULL CHECK (declared_sha256 ~ '^[0-9a-f]{64}$'),
  reassigned_from_id uuid,
  created_by         uuid NOT NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (clinic_id, id),
  FOREIGN KEY (clinic_id, patient_id) REFERENCES patients (clinic_id, id),
  FOREIGN KEY (clinic_id, visit_id, patient_id) REFERENCES visits (clinic_id, id, patient_id),
  FOREIGN KEY (clinic_id, reassigned_from_id) REFERENCES patient_documents (clinic_id, id),
  FOREIGN KEY (clinic_id, created_by) REFERENCES staff (clinic_id, id)
);
CREATE INDEX patient_documents_patient ON patient_documents (clinic_id, patient_id, created_at DESC);
SELECT ezz_make_append_only('patient_documents');
SELECT ezz_enable_tenant_rls('patient_documents');
GRANT SELECT, INSERT ON patient_documents TO ezz_app;

CREATE TABLE patient_document_events (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id       uuid NOT NULL REFERENCES clinics(id),
  document_id     uuid NOT NULL,
  seq             integer NOT NULL CHECK (seq >= 1),
  kind            text NOT NULL CHECK (kind IN ('CONTENT_STORED', 'SCREEN_PASSED', 'SCREEN_REJECTED', 'ENTERED_IN_ERROR')),
  status_after    text NOT NULL CHECK (status_after IN ('QUARANTINE', 'ACTIVE', 'REJECTED', 'ENTERED_IN_ERROR')),
  blob_ref        text CHECK (blob_ref IS NULL OR length(blob_ref) BETWEEN 3 AND 200),
  store_kind      text CHECK (store_kind IS NULL OR length(store_kind) BETWEEN 1 AND 60),
  detected_type   text CHECK (detected_type IS NULL OR detected_type IN ('image/jpeg', 'image/png', 'application/pdf', 'application/dicom')),
  received_sha256 text CHECK (received_sha256 IS NULL OR received_sha256 ~ '^[0-9a-f]{64}$'),
  stored_sha256   text CHECK (stored_sha256 IS NULL OR stored_sha256 ~ '^[0-9a-f]{64}$'),
  stored_size     integer CHECK (stored_size IS NULL OR stored_size BETWEEN 1 AND 20971520),
  metadata_removed text[],
  screener        text CHECK (screener IS NULL OR length(screener) BETWEEN 1 AND 120),
  reason          text CHECK (reason IS NULL OR length(btrim(reason)) BETWEEN 3 AND 300),
  by_staff_id     uuid NOT NULL,
  at              timestamptz NOT NULL DEFAULT now(),
  UNIQUE (clinic_id, id),
  UNIQUE (document_id, seq), -- two concurrent transitions of one document cannot both win
  FOREIGN KEY (clinic_id, document_id) REFERENCES patient_documents (clinic_id, id),
  FOREIGN KEY (clinic_id, by_staff_id) REFERENCES staff (clinic_id, id),
  CHECK ((kind = 'CONTENT_STORED') = (blob_ref IS NOT NULL AND stored_sha256 IS NOT NULL AND stored_size IS NOT NULL AND detected_type IS NOT NULL AND received_sha256 IS NOT NULL)),
  CHECK (kind <> 'ENTERED_IN_ERROR' OR reason IS NOT NULL),
  CHECK (status_after = CASE kind WHEN 'CONTENT_STORED' THEN 'QUARANTINE' WHEN 'SCREEN_PASSED' THEN 'ACTIVE'
                                  WHEN 'SCREEN_REJECTED' THEN 'REJECTED' ELSE 'ENTERED_IN_ERROR' END)
);
SELECT ezz_make_append_only('patient_document_events');
SELECT ezz_enable_tenant_rls('patient_document_events');
GRANT SELECT, INSERT ON patient_document_events TO ezz_app;

CREATE TABLE document_deletion_requests (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id    uuid NOT NULL REFERENCES clinics(id),
  document_id  uuid NOT NULL,
  basis        text NOT NULL CHECK (basis IN ('PATIENT_REQUEST', 'DUPLICATE', 'WRONG_PATIENT_CONFIRMED', 'RETENTION_EXPIRED', 'OTHER')),
  reason       text NOT NULL CHECK (length(btrim(reason)) BETWEEN 3 AND 300),
  requested_by uuid NOT NULL,
  requested_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (clinic_id, id),
  FOREIGN KEY (clinic_id, document_id) REFERENCES patient_documents (clinic_id, id),
  FOREIGN KEY (clinic_id, requested_by) REFERENCES staff (clinic_id, id)
);
SELECT ezz_make_append_only('document_deletion_requests');
SELECT ezz_enable_tenant_rls('document_deletion_requests');
GRANT SELECT, INSERT ON document_deletion_requests TO ezz_app;
