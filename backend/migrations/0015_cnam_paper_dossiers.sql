-- Fictional manual-office CNAM preparation only. No clinic receivable or money-ledger write.
CREATE TABLE cnam_dossiers (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 clinic_id uuid NOT NULL REFERENCES clinics(id),
 patient_id uuid NOT NULL,
 creation_hash text NOT NULL CHECK (creation_hash ~ '^[0-9a-f]{64}$'),
 created_by uuid NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE (clinic_id,id),
 UNIQUE (clinic_id,patient_id,creation_hash),
 FOREIGN KEY (clinic_id,patient_id) REFERENCES patients(clinic_id,id),
 FOREIGN KEY (clinic_id,created_by) REFERENCES staff(clinic_id,id)
);
CREATE TABLE cnam_versions (
 clinic_id uuid NOT NULL,
 dossier_id uuid NOT NULL,
 version integer NOT NULL CHECK (version > 0),
 snapshot jsonb NOT NULL CHECK (jsonb_typeof(snapshot) = 'object'),
 snapshot_hash text NOT NULL CHECK (snapshot_hash ~ '^[0-9a-f]{64}$'),
 correction_reason text,
 created_by uuid NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY (clinic_id,dossier_id,version),
 CHECK ((version = 1 AND correction_reason IS NULL) OR (version > 1 AND correction_reason IS NOT NULL AND length(btrim(correction_reason)) >= 3)),
 FOREIGN KEY (clinic_id,dossier_id) REFERENCES cnam_dossiers(clinic_id,id),
 FOREIGN KEY (clinic_id,created_by) REFERENCES staff(clinic_id,id)
);
CREATE TABLE cnam_events (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 clinic_id uuid NOT NULL,
 dossier_id uuid NOT NULL,
 version integer NOT NULL,
 sequence integer NOT NULL CHECK (sequence > 0),
 kind text NOT NULL CHECK (kind IN ('ISSUED','COPY_PREPARED','HANDOFF_REPORTED','OUTCOME_REPORTED')),
 payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
 actor_staff_id uuid NOT NULL,
 occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE (clinic_id,dossier_id,version,sequence),
 FOREIGN KEY (clinic_id,dossier_id,version) REFERENCES cnam_versions(clinic_id,dossier_id,version),
 FOREIGN KEY (clinic_id,actor_staff_id) REFERENCES staff(clinic_id,id)
);
CREATE UNIQUE INDEX cnam_one_issue ON cnam_events(clinic_id,dossier_id,version) WHERE kind = 'ISSUED';
CREATE UNIQUE INDEX cnam_one_handoff ON cnam_events(clinic_id,dossier_id,version) WHERE kind = 'HANDOFF_REPORTED';
-- A care act stays reserved to its original dossier, including superseded versions. Release/override
-- requires a separately reviewed policy; staff cannot evade duplicate control by removing a line.
CREATE TABLE cnam_issued_care (
 clinic_id uuid NOT NULL,
 care_item_id uuid NOT NULL,
 dossier_id uuid NOT NULL,
 PRIMARY KEY (clinic_id,care_item_id),
 FOREIGN KEY (clinic_id,care_item_id) REFERENCES care_items(clinic_id,id),
 FOREIGN KEY (clinic_id,dossier_id) REFERENCES cnam_dossiers(clinic_id,id)
);
SELECT ezz_make_append_only('cnam_dossiers');
SELECT ezz_make_append_only('cnam_versions');
SELECT ezz_make_append_only('cnam_events');
SELECT ezz_make_append_only('cnam_issued_care');
SELECT ezz_enable_tenant_rls('cnam_dossiers');
SELECT ezz_enable_tenant_rls('cnam_versions');
SELECT ezz_enable_tenant_rls('cnam_events');
SELECT ezz_enable_tenant_rls('cnam_issued_care');
GRANT SELECT,INSERT ON cnam_dossiers,cnam_versions,cnam_events,cnam_issued_care TO ezz_app;
