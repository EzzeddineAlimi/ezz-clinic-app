-- EZZ Clinic v0.2 — 0007 owner exception resolutions (MF17, CH-018, C-148 "no bulk clear").
-- FICTIONAL / SYNTHETIC DATA ONLY. Exceptions themselves are COMPUTED on read from evidence tables (never stored,
-- so they cannot be deleted); only the owner's per-item resolution (reason code + note) is stored, append-only.
CREATE TABLE exception_resolutions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id     uuid NOT NULL REFERENCES clinics(id),
  exception_key text NOT NULL CHECK (exception_key ~ '^[a-z_]+:[0-9a-zA-Z_-]+:[a-z_]+$'),
  reason_code   text NOT NULL CHECK (reason_code ~ '^[A-Z_]{3,40}$'),
  note          text CHECK (note IS NULL OR length(note) <= 300),
  resolved_by   uuid NOT NULL,
  resolved_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (clinic_id, exception_key),
  FOREIGN KEY (clinic_id, resolved_by) REFERENCES staff (clinic_id, id)
);
SELECT ezz_make_append_only('exception_resolutions');
SELECT ezz_enable_tenant_rls('exception_resolutions');
GRANT SELECT, INSERT ON exception_resolutions TO ezz_app;
