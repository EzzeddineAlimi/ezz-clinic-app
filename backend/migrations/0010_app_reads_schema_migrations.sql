-- EZZ Clinic v0.2 — 0010 (R73-B): let the API role READ the migration ledger so the running server can refuse to
-- start, and report "not ready", when the schema is not exactly what this code expects. Read-only; versions and
-- checksums only. FICTIONAL / SYNTHETIC DATA ONLY.
GRANT SELECT ON schema_migrations TO ezz_app;
