-- Fictional pre-booking queue. Deliberately no patient/visit reference or file-number allocation.
CREATE TABLE enquiries (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 clinic_id uuid NOT NULL REFERENCES clinics(id),
 name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 160),
 reason text NOT NULL CHECK (length(btrim(reason)) BETWEEN 1 AND 240),
 callback text CHECK (callback IS NULL OR length(btrim(callback)) BETWEEN 1 AND 40),
 is_synthetic boolean NOT NULL CHECK (is_synthetic = true),
 status text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','CLOSED')),
 version integer NOT NULL DEFAULT 1 CHECK (version > 0),
 duplicate_key text NOT NULL CHECK (duplicate_key ~ '^[0-9a-f]{64}$'),
 created_by uuid NOT NULL,
 updated_by uuid NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 FOREIGN KEY (clinic_id,created_by) REFERENCES staff(clinic_id,id),
 FOREIGN KEY (clinic_id,updated_by) REFERENCES staff(clinic_id,id)
);
CREATE UNIQUE INDEX enquiries_open_duplicate ON enquiries(clinic_id,duplicate_key) WHERE status='OPEN';
CREATE INDEX enquiries_queue ON enquiries(clinic_id,status,created_at DESC,id DESC);
SELECT ezz_enable_tenant_rls('enquiries');
GRANT SELECT,INSERT ON enquiries TO ezz_app;
GRANT UPDATE(name,reason,callback,status,version,duplicate_key,updated_by,updated_at) ON enquiries TO ezz_app;
