-- EZZ Clinic v0.2 — 0009 paper slip patient reference (B13, CH-030). FICTIONAL / SYNTHETIC DATA ONLY.
-- The patient file number written on the paper slip, when the desk copies it during re-entry. When present it must
-- match the visit's patient (checked by the API); when absent the slip is listed for a human check against the
-- patient copy. Additive and nullable: existing entries and their content hashes are unchanged.
-- Numbered 0009 so it never collides with 0008 (PR #12 clinical core); the runner applies files in sorted order.
ALTER TABLE paper_slip_entries ADD COLUMN patient_file_no integer CHECK (patient_file_no IS NULL OR patient_file_no > 0);
