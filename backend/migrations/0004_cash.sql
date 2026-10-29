-- EZZ Clinic v0.2 — 0004 cash drawer periods, owner movements, blind independent counts (MF01/MF02/MF04, CH-007/CH-014).
-- FICTIONAL / SYNTHETIC DATA ONLY.
--
-- Model: one drawer per clinic in v0.2. A period is a time window [opened_at, cutoff_at]. A count attempt is a
-- "cut" at its submitted_at; expected cash = opening float + cash payments + float top-ups - owner withdrawals -
-- bank deposits - petty expenses - cash refunds/voids recorded inside the window. Closing a period accepts the
-- LATEST count attempt, records the owner's handover and opens the next period with
-- opening float = counted - handover (carry-forward of the COUNTED amount, C-139 T-WIN-2).
-- Serialisation: cash writes take FOR SHARE on the open period row; count submission takes FOR UPDATE, so a
-- count's cutoff never splits an in-flight payment (timestamps use clock_timestamp() after the lock).

CREATE TABLE cash_drawers (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id  uuid NOT NULL REFERENCES clinics(id),
  name       text NOT NULL DEFAULT 'MAIN' CHECK (name ~ '^[A-Z0-9_-]{2,20}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (clinic_id, name),
  UNIQUE (clinic_id, id)
);
-- v0.2 constraint: exactly one drawer per clinic (multi-drawer needs payment->drawer assignment first).
CREATE UNIQUE INDEX cash_drawers_one_per_clinic ON cash_drawers (clinic_id);

CREATE TABLE cash_periods (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id              uuid NOT NULL REFERENCES clinics(id),
  drawer_id              uuid NOT NULL,
  period_no              integer NOT NULL CHECK (period_no > 0),
  opened_at              timestamptz NOT NULL,
  opened_by              uuid NOT NULL,
  opening_float_millimes bigint NOT NULL CHECK (opening_float_millimes >= 0),
  opening_basis          text NOT NULL CHECK (opening_basis IN ('OWNER_DECLARED', 'COUNTED_CARRY_FORWARD')),
  previous_period_id     uuid,
  status                 text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'CLOSED')),
  cutoff_at              timestamptz,
  closed_at              timestamptz,
  closed_by              uuid,
  accepted_count_id      uuid,
  handover_millimes      bigint CHECK (handover_millimes IS NULL OR handover_millimes >= 0),
  close_note             text,
  CHECK ((status = 'CLOSED') = (closed_at IS NOT NULL AND cutoff_at IS NOT NULL AND accepted_count_id IS NOT NULL AND handover_millimes IS NOT NULL)),
  CHECK ((opening_basis = 'COUNTED_CARRY_FORWARD') = (previous_period_id IS NOT NULL)),
  UNIQUE (clinic_id, drawer_id, period_no),
  UNIQUE (clinic_id, id),
  FOREIGN KEY (clinic_id, drawer_id) REFERENCES cash_drawers (clinic_id, id),
  FOREIGN KEY (clinic_id, previous_period_id) REFERENCES cash_periods (clinic_id, id),
  FOREIGN KEY (clinic_id, opened_by) REFERENCES staff (clinic_id, id)
);
CREATE UNIQUE INDEX cash_periods_one_open ON cash_periods (clinic_id, drawer_id) WHERE status = 'OPEN';

CREATE TABLE cash_movements (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id       uuid NOT NULL REFERENCES clinics(id),
  period_id       uuid NOT NULL,
  kind            text NOT NULL CHECK (kind IN ('OWNER_WITHDRAWAL', 'BANK_DEPOSIT', 'PETTY_EXPENSE', 'FLOAT_TOP_UP')),
  amount_millimes bigint NOT NULL CHECK (amount_millimes > 0 AND amount_millimes <= 100000000),
  reason          text NOT NULL CHECK (length(reason) BETWEEN 3 AND 200),
  voucher_ref     text CHECK (voucher_ref IS NULL OR voucher_ref ~ '^[A-Za-z0-9/_-]{1,40}$'),
  authorized_by   uuid NOT NULL,
  recorded_at     timestamptz NOT NULL,
  FOREIGN KEY (clinic_id, period_id) REFERENCES cash_periods (clinic_id, id),
  FOREIGN KEY (clinic_id, authorized_by) REFERENCES staff (clinic_id, id)
);
SELECT ezz_make_append_only('cash_movements');

-- Every attempt is kept (CH-007 T-CASH-3); attempt >= 2 needs a reason. expected/difference are stored for the
-- owner review and are NEVER returned to the counter in the submit response.
CREATE TABLE cash_counts (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id           uuid NOT NULL REFERENCES clinics(id),
  period_id           uuid NOT NULL,
  attempt_no          integer NOT NULL CHECK (attempt_no > 0),
  counted_by          uuid NOT NULL,
  counted_by_roles    text NOT NULL,
  counted_millimes    bigint NOT NULL CHECK (counted_millimes >= 0 AND counted_millimes <= 1000000000),
  denominations       jsonb,
  recount_reason      text,
  submitted_at        timestamptz NOT NULL,
  expected_millimes   bigint NOT NULL,
  difference_millimes bigint NOT NULL,
  counter_independent boolean NOT NULL,
  independence_notes  text NOT NULL,
  CHECK (attempt_no = 1 OR length(coalesce(recount_reason, '')) >= 3),
  CHECK (difference_millimes = counted_millimes - expected_millimes),
  UNIQUE (clinic_id, period_id, attempt_no),
  UNIQUE (clinic_id, id),
  FOREIGN KEY (clinic_id, period_id) REFERENCES cash_periods (clinic_id, id),
  FOREIGN KEY (clinic_id, counted_by) REFERENCES staff (clinic_id, id)
);
SELECT ezz_make_append_only('cash_counts');

ALTER TABLE cash_periods ADD FOREIGN KEY (clinic_id, accepted_count_id) REFERENCES cash_counts (clinic_id, id);
ALTER TABLE payments ADD FOREIGN KEY (clinic_id, cash_period_id) REFERENCES cash_periods (clinic_id, id);
ALTER TABLE adjustments ADD FOREIGN KEY (clinic_id, cash_period_id) REFERENCES cash_periods (clinic_id, id);

SELECT ezz_enable_tenant_rls('cash_drawers');
SELECT ezz_enable_tenant_rls('cash_periods');
SELECT ezz_enable_tenant_rls('cash_movements');
SELECT ezz_enable_tenant_rls('cash_counts');

GRANT SELECT, INSERT ON cash_drawers, cash_movements, cash_counts TO ezz_app;
GRANT SELECT, INSERT ON cash_periods TO ezz_app;
GRANT UPDATE (status, cutoff_at, closed_at, closed_by, accepted_count_id, handover_millimes, close_note) ON cash_periods TO ezz_app;
