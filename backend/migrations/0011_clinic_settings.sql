-- EZZ Clinic v0.2 — 0011 (R73-C): clinic settings as an append-only, tenant-isolated, audited change log.
-- Only policies the code ALREADY relies on are configurable (a new key needs a new migration and a reviewed reason):
--   timezone                   clinic-local days everywhere (default Africa/Tunis; was clinics.settings at bootstrap)
--   checkpoint_due_days        owner checkpoint reminder (default 7)
--   not_arrived_grace_minutes  day-board NOT_ARRIVED_PAST_START grace (default 15)
-- The effective value of a key is its latest change; without one, the bootstrap value or the code default applies.
-- FICTIONAL / SYNTHETIC DATA ONLY.
CREATE TABLE clinic_setting_changes (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id   uuid NOT NULL REFERENCES clinics(id),
  key         text NOT NULL CHECK (key IN ('timezone', 'checkpoint_due_days', 'not_arrived_grace_minutes')),
  value       jsonb NOT NULL,
  previous    jsonb,
  reason      text NOT NULL CHECK (length(btrim(reason)) BETWEEN 3 AND 300),
  changed_by  uuid NOT NULL,
  changed_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (clinic_id, id),
  FOREIGN KEY (clinic_id, changed_by) REFERENCES staff (clinic_id, id)
);
CREATE INDEX clinic_setting_changes_latest ON clinic_setting_changes (clinic_id, key, changed_at DESC, id DESC);
SELECT ezz_make_append_only('clinic_setting_changes');
SELECT ezz_enable_tenant_rls('clinic_setting_changes');
GRANT SELECT, INSERT ON clinic_setting_changes TO ezz_app;
