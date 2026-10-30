-- Durable, append-only desk intentions and terminal outcomes. No payment or numbering rewrite.
CREATE TABLE payment_intents (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 clinic_id uuid NOT NULL REFERENCES clinics(id),
 visit_id uuid NOT NULL,
 created_by uuid NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 ledger_hash text NOT NULL CHECK (ledger_hash ~ '^[0-9a-f]{64}$'),
 payload jsonb NOT NULL CHECK (jsonb_typeof(payload)='object'),
 UNIQUE (clinic_id,id),
 FOREIGN KEY (clinic_id,visit_id) REFERENCES visits(clinic_id,id),
 FOREIGN KEY (clinic_id,created_by) REFERENCES staff(clinic_id,id)
);
CREATE INDEX payment_intents_visit ON payment_intents(clinic_id,visit_id);
CREATE TABLE payment_intent_outcomes (
 intent_id uuid PRIMARY KEY,
 clinic_id uuid NOT NULL REFERENCES clinics(id),
 status text NOT NULL CHECK (status IN ('RECORDED','CANCELLED')),
 payment_id uuid,
 result jsonb,
 reason text,
 resolved_by uuid NOT NULL,
 resolved_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE (clinic_id,payment_id),
 CHECK ((status='RECORDED' AND payment_id IS NOT NULL AND result IS NOT NULL AND reason IS NULL)
     OR (status='CANCELLED' AND payment_id IS NULL AND result IS NULL AND reason IS NOT NULL AND length(reason)>=3)),
 FOREIGN KEY (clinic_id,intent_id) REFERENCES payment_intents(clinic_id,id),
 FOREIGN KEY (clinic_id,payment_id) REFERENCES payments(clinic_id,id),
 FOREIGN KEY (clinic_id,resolved_by) REFERENCES staff(clinic_id,id)
);
SELECT ezz_make_append_only('payment_intents');
SELECT ezz_make_append_only('payment_intent_outcomes');
SELECT ezz_enable_tenant_rls('payment_intents');
SELECT ezz_enable_tenant_rls('payment_intent_outcomes');
GRANT SELECT, INSERT ON payment_intents,payment_intent_outcomes TO ezz_app;
