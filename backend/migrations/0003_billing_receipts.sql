-- EZZ Clinic v0.2 — 0003 billing core: payments, allocations, gap-free receipts, adjustments (MF06/MF09/MF16).
-- FICTIONAL / SYNTHETIC DATA ONLY. All money is bigint millimes (1 TND = 1,000 millimes). No floats anywhere.

-- Gap-free receipt numbering (CH-016). PostgreSQL sequences are NOT gap-free (nextval is never rolled back),
-- so numbering uses a per-clinic counter row locked FOR UPDATE inside the payment transaction: a rolled-back
-- payment rolls back its number too. Series 'R' = electronic desk receipts. Paper outage slips use a
-- separate namespace (paper_books, 0006) and never consume R numbers.
CREATE TABLE receipt_counters (
  clinic_id   uuid NOT NULL REFERENCES clinics(id),
  series      text NOT NULL CHECK (series IN ('R')),
  next_number integer NOT NULL DEFAULT 1 CHECK (next_number > 0),
  PRIMARY KEY (clinic_id, series)
);

CREATE TABLE payments (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id         uuid NOT NULL REFERENCES clinics(id),
  patient_id        uuid NOT NULL,
  visit_id          uuid NOT NULL,
  amount_millimes   bigint NOT NULL CHECK (amount_millimes > 0 AND amount_millimes <= 100000000),
  tender            text NOT NULL CHECK (tender IN ('CASH', 'CARD')),
  source            text NOT NULL CHECK (source IN ('DESK', 'PAPER_OUTAGE')),
  card_terminal_ref text CHECK (card_terminal_ref IS NULL OR card_terminal_ref ~ '^[A-Za-z0-9-]{1,40}$'),
  card_last4        text CHECK (card_last4 IS NULL OR card_last4 ~ '^[0-9]{4}$'),
  cash_period_id    uuid,
  recorded_by       uuid NOT NULL,
  recorded_at       timestamptz NOT NULL DEFAULT now(),
  CHECK (tender = 'CARD' OR (card_terminal_ref IS NULL AND card_last4 IS NULL)),
  UNIQUE (clinic_id, id),
  FOREIGN KEY (clinic_id, patient_id) REFERENCES patients (clinic_id, id),
  FOREIGN KEY (clinic_id, visit_id) REFERENCES visits (clinic_id, id),
  FOREIGN KEY (clinic_id, recorded_by) REFERENCES staff (clinic_id, id)
);
CREATE INDEX payments_visit ON payments (clinic_id, visit_id);
CREATE INDEX payments_time ON payments (clinic_id, recorded_at);
SELECT ezz_make_append_only('payments');

-- One row per (payment, visit). v0.2 allocates a payment to exactly one visit; the table allows a later
-- split-across-visits feature without changing the payment record.
CREATE TABLE payment_allocations (
  clinic_id       uuid NOT NULL,
  payment_id      uuid NOT NULL,
  visit_id        uuid NOT NULL,
  amount_millimes bigint NOT NULL CHECK (amount_millimes > 0),
  PRIMARY KEY (clinic_id, payment_id, visit_id),
  FOREIGN KEY (clinic_id, payment_id) REFERENCES payments (clinic_id, id),
  FOREIGN KEY (clinic_id, visit_id) REFERENCES visits (clinic_id, id)
);
SELECT ezz_make_append_only('payment_allocations');

-- Discounts / write-offs (dentist or owner), refunds and payment voids (owner only). Never edits; always new rows.
CREATE TABLE adjustments (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id       uuid NOT NULL REFERENCES clinics(id),
  visit_id        uuid NOT NULL,
  patient_id      uuid NOT NULL,
  kind            text NOT NULL CHECK (kind IN ('DISCOUNT', 'WRITE_OFF', 'REFUND', 'PAYMENT_VOID')),
  amount_millimes bigint NOT NULL CHECK (amount_millimes > 0 AND amount_millimes <= 100000000),
  reason_code     text NOT NULL CHECK (reason_code ~ '^[A-Z_]{3,40}$'),
  reason_note     text CHECK (reason_note IS NULL OR length(reason_note) <= 300),
  payment_id      uuid,
  tender          text CHECK (tender IS NULL OR tender IN ('CASH', 'CARD')),
  cash_period_id  uuid,
  authorized_by   uuid NOT NULL,
  authorized_role text NOT NULL CHECK (authorized_role IN ('OWNER', 'DENTIST')),
  created_at      timestamptz NOT NULL DEFAULT now(),
  CHECK ((kind IN ('REFUND', 'PAYMENT_VOID')) = (payment_id IS NOT NULL AND tender IS NOT NULL)),
  CHECK (kind NOT IN ('REFUND', 'PAYMENT_VOID') OR authorized_role = 'OWNER'),
  UNIQUE (clinic_id, id),
  FOREIGN KEY (clinic_id, visit_id) REFERENCES visits (clinic_id, id),
  FOREIGN KEY (clinic_id, patient_id) REFERENCES patients (clinic_id, id),
  FOREIGN KEY (clinic_id, payment_id) REFERENCES payments (clinic_id, id),
  FOREIGN KEY (clinic_id, authorized_by) REFERENCES staff (clinic_id, id)
);
CREATE UNIQUE INDEX adjustments_one_void_per_payment ON adjustments (clinic_id, payment_id) WHERE kind = 'PAYMENT_VOID';
CREATE INDEX adjustments_visit ON adjustments (clinic_id, visit_id);
SELECT ezz_make_append_only('adjustments');

CREATE TABLE receipts (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id       uuid NOT NULL REFERENCES clinics(id),
  series          text NOT NULL CHECK (series IN ('R')),
  number          integer NOT NULL CHECK (number > 0),
  kind            text NOT NULL CHECK (kind IN ('PAYMENT', 'REFUND', 'VOID')),
  payment_id      uuid,
  adjustment_id   uuid,
  issued_by       uuid NOT NULL,
  issued_at       timestamptz NOT NULL DEFAULT now(),
  snapshot        jsonb NOT NULL,
  snapshot_sha256 text NOT NULL CHECK (snapshot_sha256 ~ '^[0-9a-f]{64}$'),
  CHECK ((kind = 'PAYMENT') = (payment_id IS NOT NULL AND adjustment_id IS NULL)),
  CHECK ((kind <> 'PAYMENT') = (adjustment_id IS NOT NULL)),
  UNIQUE (clinic_id, series, number),
  UNIQUE (clinic_id, payment_id),
  UNIQUE (clinic_id, adjustment_id),
  FOREIGN KEY (clinic_id, payment_id) REFERENCES payments (clinic_id, id),
  FOREIGN KEY (clinic_id, adjustment_id) REFERENCES adjustments (clinic_id, id),
  FOREIGN KEY (clinic_id, issued_by) REFERENCES staff (clinic_id, id)
);
SELECT ezz_make_append_only('receipts');

CREATE TABLE receipt_prints (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id  uuid NOT NULL REFERENCES clinics(id),
  receipt_id uuid NOT NULL REFERENCES receipts(id),
  printed_by uuid NOT NULL,
  printed_at timestamptz NOT NULL DEFAULT now(),
  is_copy    boolean NOT NULL
);
SELECT ezz_make_append_only('receipt_prints');

-- Balance per visit, computed (never stored, so it cannot drift). security_invoker => RLS of the caller applies.
CREATE VIEW visit_balances WITH (security_invoker = true) AS
SELECT v.clinic_id, v.id AS visit_id, v.patient_id,
  coalesce((SELECT sum(c.fee_millimes) FROM care_items c WHERE c.visit_id = v.id), 0)::bigint AS charged_millimes,
  coalesce((SELECT sum(a.amount_millimes) FROM payment_allocations a WHERE a.visit_id = v.id), 0)::bigint AS paid_millimes,
  coalesce((SELECT sum(j.amount_millimes) FROM adjustments j WHERE j.visit_id = v.id AND j.kind IN ('DISCOUNT', 'WRITE_OFF')), 0)::bigint AS reduced_millimes,
  coalesce((SELECT sum(j.amount_millimes) FROM adjustments j WHERE j.visit_id = v.id AND j.kind IN ('REFUND', 'PAYMENT_VOID')), 0)::bigint AS returned_millimes
FROM visits v;

SELECT ezz_enable_tenant_rls('receipt_counters');
SELECT ezz_enable_tenant_rls('payments');
SELECT ezz_enable_tenant_rls('payment_allocations');
SELECT ezz_enable_tenant_rls('adjustments');
SELECT ezz_enable_tenant_rls('receipts');
SELECT ezz_enable_tenant_rls('receipt_prints');

GRANT SELECT, INSERT ON receipt_counters TO ezz_app;
GRANT UPDATE (next_number) ON receipt_counters TO ezz_app;
GRANT SELECT, INSERT ON payments, payment_allocations, adjustments, receipts, receipt_prints TO ezz_app;
GRANT SELECT ON visit_balances TO ezz_app;
