-- EZZ Clinic v0.2 — 0001 platform, identity, tenant isolation, tamper-evident audit chain.
-- FICTIONAL / SYNTHETIC DATA ONLY. Runs as the schema-owner role (ezz_owner); the API runs as ezz_app.
-- Conventions: every tenant table carries clinic_id; composite (clinic_id, id) keys make cross-clinic
-- references impossible at the database level; row-level security (RLS) filters on app.clinic_id.

-- Hard guard: this build only ever holds fictional clinics. Removing this CHECK is a founder-gated change.
CREATE TABLE clinics (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code         text NOT NULL UNIQUE CHECK (code ~ '^[a-z0-9-]{3,40}$'),
  name         text NOT NULL CHECK (length(name) BETWEEN 2 AND 120),
  is_fictional boolean NOT NULL DEFAULT true CHECK (is_fictional),
  settings     jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at   timestamptz NOT NULL DEFAULT now()
);

-- Generic append-only guard used by every financial / evidence table.
CREATE FUNCTION ezz_forbid_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'append-only table %: % is forbidden', TG_TABLE_NAME, TG_OP USING ERRCODE = 'EZ001';
END $$;

-- Helper: enable + FORCE tenant RLS on a table that has a clinic_id column.
CREATE FUNCTION ezz_enable_tenant_rls(t regclass) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', t);
  EXECUTE format('ALTER TABLE %s FORCE ROW LEVEL SECURITY', t);
  EXECUTE format($p$CREATE POLICY tenant_isolation ON %s
      USING (clinic_id = NULLIF(current_setting('app.clinic_id', true), '')::uuid)
      WITH CHECK (clinic_id = NULLIF(current_setting('app.clinic_id', true), '')::uuid)$p$, t);
END $$;

-- Helper: attach the append-only triggers (row UPDATE/DELETE and statement TRUNCATE).
CREATE FUNCTION ezz_make_append_only(t regclass) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON %s FOR EACH ROW EXECUTE FUNCTION ezz_forbid_mutation()', 'append_only_row', t);
  EXECUTE format('CREATE TRIGGER %I BEFORE TRUNCATE ON %s FOR EACH STATEMENT EXECUTE FUNCTION ezz_forbid_mutation()', 'append_only_truncate', t);
END $$;

CREATE TABLE staff (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id      uuid NOT NULL REFERENCES clinics(id),
  username       text NOT NULL CHECK (username ~ '^[a-z0-9._-]{3,40}$'),
  display_name   text NOT NULL CHECK (length(display_name) BETWEEN 2 AND 120),
  password_hash  text NOT NULL,
  active         boolean NOT NULL DEFAULT true,
  created_at     timestamptz NOT NULL DEFAULT now(),
  deactivated_at timestamptz,
  UNIQUE (clinic_id, username),
  UNIQUE (clinic_id, id)
);

CREATE TABLE staff_roles (
  clinic_id  uuid NOT NULL,
  staff_id   uuid NOT NULL,
  role       text NOT NULL CHECK (role IN ('OWNER', 'DENTIST', 'RECEPTIONIST', 'ASSISTANT')),
  granted_at timestamptz NOT NULL DEFAULT now(),
  granted_by uuid,
  PRIMARY KEY (clinic_id, staff_id, role),
  FOREIGN KEY (clinic_id, staff_id) REFERENCES staff (clinic_id, id)
);

-- Sessions are looked up by token hash before the clinic is known, so they are NOT under RLS;
-- the raw bearer token is never stored (sha256 only).
CREATE TABLE sessions (
  token_hash   text PRIMARY KEY CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  clinic_id    uuid NOT NULL,
  staff_id     uuid NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL,
  reauth_at    timestamptz,
  revoked_at   timestamptz,
  FOREIGN KEY (clinic_id, staff_id) REFERENCES staff (clinic_id, id)
);
CREATE INDEX sessions_staff ON sessions (clinic_id, staff_id);

CREATE TABLE login_attempts (
  id        bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  clinic_id uuid,
  username  text NOT NULL,
  succeeded boolean NOT NULL,
  at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX login_attempts_recent ON login_attempts (clinic_id, username, at);

-- Rate-limited counter of denied privileged attempts (CH-012 T-CARE-1/2: visible to owner, no log flooding).
CREATE TABLE security_denials (
  clinic_id uuid NOT NULL REFERENCES clinics(id),
  staff_id  uuid NOT NULL,
  action    text NOT NULL,
  day       date NOT NULL,
  count     integer NOT NULL DEFAULT 1 CHECK (count > 0),
  last_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (clinic_id, staff_id, action, day)
);

-- Tamper-evident audit chain (CH-008 / CH-017). One chain per clinic:
--   hash(n) = sha256(prev_hash(n) || canonical(n)); canonical is the exact JSON text that was hashed.
-- Internal hashes alone do NOT stop a DB superuser from rebuilding the chain: the independent control
-- is the owner-held checkpoint (seq + hash) exported OUTSIDE this database (see audit module).
CREATE TABLE audit_heads (
  clinic_id uuid PRIMARY KEY REFERENCES clinics(id),
  last_seq  bigint NOT NULL DEFAULT 0 CHECK (last_seq >= 0),
  last_hash text NOT NULL DEFAULT repeat('0', 64)
);

CREATE TABLE audit_events (
  clinic_id      uuid NOT NULL REFERENCES clinics(id),
  seq            bigint NOT NULL CHECK (seq > 0),
  id             uuid NOT NULL DEFAULT gen_random_uuid() UNIQUE,
  occurred_at    timestamptz NOT NULL,
  actor_staff_id uuid,
  actor_roles    text NOT NULL,
  action         text NOT NULL CHECK (action ~ '^[a-z_]+\.[a-z_]+$'),
  entity_type    text NOT NULL,
  entity_id      text NOT NULL,
  payload        jsonb NOT NULL,
  canonical      text NOT NULL,
  prev_hash      text NOT NULL CHECK (prev_hash ~ '^[0-9a-f]{64}$'),
  hash           text NOT NULL CHECK (hash ~ '^[0-9a-f]{64}$'),
  PRIMARY KEY (clinic_id, seq)
);
CREATE INDEX audit_events_entity ON audit_events (clinic_id, entity_type, entity_id);
SELECT ezz_make_append_only('audit_events');

-- Convenience copy of owner checkpoints. NOT independent evidence (same database);
-- the independent copy is what the owner prints/exports and keeps away from the desk.
CREATE TABLE audit_checkpoints (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id  uuid NOT NULL REFERENCES clinics(id),
  seq        bigint NOT NULL,
  hash       text NOT NULL,
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  note       text
);
SELECT ezz_make_append_only('audit_checkpoints');

-- Idempotency (CH-015): one logical operation per (clinic, key). Written in the SAME transaction as the
-- business effect, so a rolled-back operation leaves no record and a retry re-executes; a concurrent
-- duplicate blocks on the primary key until the first commits, then replays the stored response.
CREATE TABLE idempotency_records (
  clinic_id       uuid NOT NULL REFERENCES clinics(id),
  key             text NOT NULL CHECK (key ~ '^[A-Za-z0-9_-]{16,100}$'),
  actor_staff_id  uuid NOT NULL,
  route           text NOT NULL,
  request_hash    text NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  response_status integer,
  response_body   jsonb,
  created_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (clinic_id, key)
);

SELECT ezz_enable_tenant_rls('staff');
SELECT ezz_enable_tenant_rls('idempotency_records');
SELECT ezz_enable_tenant_rls('staff_roles');
SELECT ezz_enable_tenant_rls('security_denials');
SELECT ezz_enable_tenant_rls('audit_heads');
SELECT ezz_enable_tenant_rls('audit_events');
SELECT ezz_enable_tenant_rls('audit_checkpoints');

-- Least-privilege grants for the API role. No UPDATE/DELETE on evidence tables.
GRANT USAGE ON SCHEMA public TO ezz_app;
GRANT SELECT ON clinics TO ezz_app;
GRANT SELECT, INSERT ON staff TO ezz_app;
GRANT UPDATE (active, deactivated_at, password_hash, display_name) ON staff TO ezz_app;
GRANT SELECT, INSERT, DELETE ON staff_roles TO ezz_app;
GRANT SELECT, INSERT ON sessions TO ezz_app;
GRANT UPDATE (last_seen_at, reauth_at, revoked_at) ON sessions TO ezz_app;
GRANT SELECT, INSERT ON login_attempts TO ezz_app;
GRANT SELECT, INSERT, UPDATE ON security_denials TO ezz_app;
GRANT SELECT, INSERT ON audit_heads TO ezz_app;
GRANT UPDATE (last_seq, last_hash) ON audit_heads TO ezz_app;
GRANT SELECT, INSERT ON audit_events TO ezz_app;
GRANT SELECT, INSERT ON audit_checkpoints TO ezz_app;
GRANT SELECT, INSERT ON idempotency_records TO ezz_app;
GRANT UPDATE (response_status, response_body) ON idempotency_records TO ezz_app;
