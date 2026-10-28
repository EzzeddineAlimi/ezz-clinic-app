-- EZZ Clinic v0.2 — 0005 card-payment evidence tiers (MF06, CH-013, CH-022, C-148, M-248, M-249, G-31).
-- FICTIONAL / SYNTHETIC DATA ONLY. No PSP / bank integration exists or is implied.
--
-- Evidence vocabulary (G-31, adopted by C-148 and M-249):
--   DESK_CLAIM               : a card payment recorded at the desk (payments.tender = 'CARD'), unverified.
--   OWNER_REVIEWED_STATEMENT : the OWNER imported a statement/terminal file and explicitly linked one line to one
--                              claim. File origin is NOT independently verified (a plain CSV carries no signature).
--   PROVIDER_VERIFIED        : requires an independently authenticated provider/bank event. No such source exists
--                              in v0.2, so this tier is UNREACHABLE: the app role cannot insert provider events.

CREATE TABLE clinic_card_settings (
  clinic_id                uuid PRIMARY KEY REFERENCES clinics(id),
  account_last4            text NOT NULL CHECK (account_last4 ~ '^[0-9]{4}$'),
  settlement_lag_days      integer NOT NULL DEFAULT 2 CHECK (settlement_lag_days BETWEEN 0 AND 30),   -- ASSUMPTION (Tunisian timing UNVERIFIED)
  match_window_days        integer NOT NULL DEFAULT 7 CHECK (match_window_days BETWEEN 1 AND 60),
  import_stale_after_days  integer NOT NULL DEFAULT 7 CHECK (import_stale_after_days BETWEEN 1 AND 60), -- ASSUMPTION (C-148 T-STMT-6)
  updated_by               uuid NOT NULL,
  updated_at               timestamptz NOT NULL DEFAULT now()
);

-- Placeholder for a FUTURE authenticated provider feed. Deliberately no INSERT grant to ezz_app.
CREATE TABLE provider_settlement_events (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id          uuid NOT NULL REFERENCES clinics(id),
  provider_name      text NOT NULL,
  provider_event_ref text NOT NULL,
  signature_verified boolean NOT NULL CHECK (signature_verified),
  amount_millimes    bigint NOT NULL,
  received_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (clinic_id, id),
  UNIQUE (clinic_id, provider_name, provider_event_ref)
);

CREATE TABLE statement_imports (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id               uuid NOT NULL REFERENCES clinics(id),
  imported_by             uuid NOT NULL,
  imported_at             timestamptz NOT NULL DEFAULT now(),
  file_name               text NOT NULL CHECK (length(file_name) BETWEEN 1 AND 120),
  file_sha256             text NOT NULL CHECK (file_sha256 ~ '^[0-9a-f]{64}$'),
  account_last4           text NOT NULL CHECK (account_last4 ~ '^[0-9]{4}$'),
  period_start            date NOT NULL,
  period_end              date NOT NULL CHECK (period_end >= period_start),
  card_line_count         integer NOT NULL CHECK (card_line_count >= 0),
  discarded_non_card      integer NOT NULL DEFAULT 0,
  file_net_total_millimes bigint NOT NULL,
  declared_total_millimes bigint,
  total_source            text NOT NULL CHECK (total_source IN ('OWNER_READ_TERMINAL', 'OWNER_READ_BANK_PORTAL', 'DESK_HANDLED_SLIP', 'NOT_PROVIDED')),
  status                  text NOT NULL CHECK (status IN ('ACCEPTED_TOTAL_CHECKED', 'ACCEPTED_TOTAL_NOT_INDEPENDENT', 'ACCEPTED_NO_TOTAL',
                                                          'ACCEPTED_OVERLAP_FORCED', 'BLOCKED_TOTAL_MISMATCH', 'BLOCKED_OVERLAP_CONFLICT', 'REJECTED_SCOPE')),
  lines_new               integer NOT NULL DEFAULT 0,
  lines_already_known     integer NOT NULL DEFAULT 0,
  detail                  jsonb NOT NULL DEFAULT '{}'::jsonb,
  forced_reason           text,
  UNIQUE (clinic_id, id),
  FOREIGN KEY (clinic_id, imported_by) REFERENCES staff (clinic_id, id)
);
SELECT ezz_make_append_only('statement_imports');

-- Privacy (C-148 T-STMT-8): only key, date, amount, terminal/batch ref and last-4 are stored; descriptions and
-- non-card lines are discarded at import and never persisted.
CREATE TABLE statement_lines (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id       uuid NOT NULL REFERENCES clinics(id),
  import_id       uuid NOT NULL,
  line_key        text NOT NULL,
  txn_date        date NOT NULL,
  amount_millimes bigint NOT NULL CHECK (amount_millimes > 0),
  is_reversal     boolean NOT NULL,
  terminal_ref    text CHECK (terminal_ref IS NULL OR terminal_ref ~ '^[A-Za-z0-9-]{1,40}$'),
  card_last4      text CHECK (card_last4 IS NULL OR card_last4 ~ '^[0-9]{4}$'),
  occurrence      integer NOT NULL CHECK (occurrence > 0),
  UNIQUE (clinic_id, line_key),
  UNIQUE (clinic_id, id),
  FOREIGN KEY (clinic_id, import_id) REFERENCES statement_imports (clinic_id, id)
);
CREATE INDEX statement_lines_match ON statement_lines (clinic_id, amount_millimes, txn_date);
SELECT ezz_make_append_only('statement_lines');

-- One claim <-> at most one line, one line <-> at most one claim (no double consumption).
CREATE TABLE card_matches (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id         uuid NOT NULL REFERENCES clinics(id),
  payment_id        uuid NOT NULL,
  statement_line_id uuid NOT NULL,
  evidence_tier     text NOT NULL CHECK (evidence_tier IN ('OWNER_REVIEWED_STATEMENT', 'PROVIDER_VERIFIED')),
  provider_event_id uuid,
  basis             text NOT NULL,
  note              text,
  confirmed_by      uuid NOT NULL,
  confirmed_at      timestamptz NOT NULL DEFAULT now(),
  CHECK (evidence_tier <> 'PROVIDER_VERIFIED' OR provider_event_id IS NOT NULL),
  UNIQUE (clinic_id, payment_id),
  UNIQUE (clinic_id, statement_line_id),
  FOREIGN KEY (clinic_id, payment_id) REFERENCES payments (clinic_id, id),
  FOREIGN KEY (clinic_id, statement_line_id) REFERENCES statement_lines (clinic_id, id),
  FOREIGN KEY (clinic_id, provider_event_id) REFERENCES provider_settlement_events (clinic_id, id),
  FOREIGN KEY (clinic_id, confirmed_by) REFERENCES staff (clinic_id, id)
);
SELECT ezz_make_append_only('card_matches');

SELECT ezz_enable_tenant_rls('clinic_card_settings');
SELECT ezz_enable_tenant_rls('provider_settlement_events');
SELECT ezz_enable_tenant_rls('statement_imports');
SELECT ezz_enable_tenant_rls('statement_lines');
SELECT ezz_enable_tenant_rls('card_matches');

GRANT SELECT, INSERT ON clinic_card_settings TO ezz_app;
GRANT UPDATE (account_last4, settlement_lag_days, match_window_days, import_stale_after_days, updated_by, updated_at) ON clinic_card_settings TO ezz_app;
GRANT SELECT ON provider_settlement_events TO ezz_app;   -- read-only: tier 3 unreachable in v0.2
GRANT SELECT, INSERT ON statement_imports, statement_lines, card_matches TO ezz_app;
