-- U014: add an audited clinic calendar snapshot to the existing append-only, tenant-isolated setting ledger.
-- Existing 0011/0013 migrations are immutable; no automatic holiday data or production configuration.
ALTER TABLE clinic_setting_changes DROP CONSTRAINT clinic_setting_changes_key_check;
ALTER TABLE clinic_setting_changes ADD CONSTRAINT clinic_setting_changes_key_check
  CHECK (key IN ('timezone', 'checkpoint_due_days', 'not_arrived_grace_minutes', 'lab_unbilled_days', 'clinic_calendar'));
