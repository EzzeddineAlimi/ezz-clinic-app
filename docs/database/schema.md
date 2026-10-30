# EZZ Clinic v0.2 — database specification (Mission B)

Status: **HISTORICAL PARTIAL CATALOGUE** generated 2026-10-28 from only `backend/migrations/0001..0007` on PostgreSQL 16.15. Current merged main contains additional migrations (at least `0012_patient_documents.sql`); this page does **not** catalogue the full current schema. **Source of truth = all merged migration files**. Regenerate against a current throwaway PostgreSQL 16 database before treating a schema catalogue as complete. No schema generation/test was run by this documentation-only update. Fictional data only.

## Setup (development / CI)

```bash
# once, as a PostgreSQL superuser (dev/CI server only)
psql -v owner_pw="'<owner-pw>'" -v app_pw="'<app-pw>'" -v db=ezz_dev -f backend/scripts/bootstrap-roles.sql
cd backend
MIGRATION_DATABASE_URL=postgres://ezz_owner:<owner-pw>@localhost:5432/ezz_dev node scripts/migrate.ts
MIGRATION_DATABASE_URL=... SEED_PASSWORD='<12+ chars>' node scripts/seed-fictional.ts demo-fictional
DATABASE_URL=postgres://ezz_app:<app-pw>@localhost:5432/ezz_dev node src/server.ts   # or npm run build && npm start
```

## Roles and privileges

| Role | Used by | Rights |
|---|---|---|
| `ezz_owner` | migrations, seed CLI | owns schema objects; still subject to FORCEd RLS and append-only triggers |
| `ezz_app` | the API process | SELECT/INSERT on tenant tables, column-level UPDATE only on operational columns, **no UPDATE/DELETE on any evidence table**, NOBYPASSRLS; no INSERT on `provider_settlement_events` |
| superuser | DBA / tests only | can bypass everything → independent owner checkpoints are the control (CH-008) |

## Migrations

| File | Slice | Contents |
|---|---|---|
| 0001_platform_identity_audit.sql | C1/C5 | clinics (fictional-only CHECK), staff, roles, sessions, login attempts, denial counters, idempotency records, audit heads/events/checkpoints, helper functions (RLS, append-only) |
| 0002_patients_visits_care.sql | C1 | patient file counters, synthetic-only patients, visits, dentist-confirmed care items (FDI CHECK, correction rows) |
| 0003_billing_receipts.sql | C4/C5 | receipt counters (gap-free), payments, allocations, adjustments (discount/write-off/refund/void), receipts, reprints, `visit_balances` view |
| 0004_cash.sql | C2 | drawers (1 per clinic), periods (one OPEN), movements, count attempts |
| 0005_card_evidence.sql | C3 | card settings, provider events (no insert grant), statement imports/lines, card matches (tier CHECK) |
| 0006_paper_outage.sql | C6 | paper books, slip entries (one effective per slip), payment ↔ slip link |
| 0007_owner_exceptions.sql | MF17 | exception resolutions (one per item) |

Rules: forward-only, checksummed (runner refuses an edited applied file), one transaction per file; breaking changes via expand → migrate → contract.

## Keys and invariants (highlights)

- Every tenant row has `clinic_id`; `UNIQUE (clinic_id, id)` + composite FKs make cross-clinic references impossible.
- Money columns are `bigint` millimes with range CHECKs; payments `> 0` and `≤ 100,000,000`.
- `care_items`: CARE fee ≥ 0 (0 needs reason), CORRECTION ≠ 0 with reason and `corrects_id`; `confirmed_by_role = 'DENTIST'`; FDI tooth CHECK (11–48 permanent, 51–85 primary).
- `receipts`: `UNIQUE (clinic_id, series, number)`, one receipt per payment / adjustment, snapshot + sha256.
- `adjustments`: refund/void require `payment_id` + tender and `authorized_role = 'OWNER'`; one void per payment (partial unique index).
- `cash_periods`: one OPEN per drawer (partial unique index); CLOSED requires cutoff, accepted count and handover.
- `cash_counts`: attempt ≥ 2 needs a reason; `difference = counted − expected` enforced.
- `statement_lines`: `UNIQUE (clinic_id, line_key)` with key `date|C|R amount|ref|occurrence`; positive amounts, reversal flag.
- `card_matches`: one line per claim and one claim per line; `PROVIDER_VERIFIED` requires a provider event.
- `paper_slip_entries`: one effective entry per (book, slip) (partial unique index); VOID has amount 0 + reason; USED needs amount, tender, visit. `payments_one_per_paper_slip`.
- `idempotency_records`: PK (clinic_id, key) written in the business transaction.

## Concurrency protection

| Operation | Lock | Proven by |
|---|---|---|
| payment / refund / void | `visits` row FOR UPDATE | T-RACE-1 |
| receipt number | `receipt_counters` row FOR UPDATE | T-REC-CONC, T-TX-1 |
| audit append | `audit_heads` row FOR UPDATE | T-EVT-2, all |
| cash write vs count | period FOR SHARE vs FOR UPDATE + clock_timestamp() | T-CASH-CONC |
| duplicate request | idempotency PK insert blocks until first commits | T-IDEM-CONC |
| paper book ranges | advisory transaction lock per clinic | T-PAPER-9 |

## Generated catalogue (from the migrated database)

| Table | RLS (forced) | Append-only trigger | ezz_app privileges | Columns (type, NOT NULL = *) |
|---|:-:|:-:|---|---|
| `adjustments` | yes (forced) | yes | INSERT,SELECT | id uuid*, clinic_id uuid*, visit_id uuid*, patient_id uuid*, kind text*, amount_millimes bigint*, reason_code text*, reason_note text, payment_id uuid, tender text, cash_period_id uuid, authorized_by uuid*, authorized_role text*, created_at timestamptz* |
| `audit_checkpoints` | yes (forced) | yes | INSERT,SELECT | id uuid*, clinic_id uuid*, seq bigint*, hash text*, created_by uuid*, created_at timestamptz*, note text |
| `audit_events` | yes (forced) | yes | INSERT,SELECT | clinic_id uuid*, seq bigint*, id uuid*, occurred_at timestamptz*, actor_staff_id uuid, actor_roles text*, action text*, entity_type text*, entity_id text*, payload jsonb*, canonical text*, prev_hash text*, hash text* |
| `audit_heads` | yes (forced) | — | INSERT,SELECT + UPDATE(last_hash,last_seq) | clinic_id uuid*, last_seq bigint*, last_hash text* |
| `card_matches` | yes (forced) | yes | INSERT,SELECT | id uuid*, clinic_id uuid*, payment_id uuid*, statement_line_id uuid*, evidence_tier text*, provider_event_id uuid, basis text*, note text, confirmed_by uuid*, confirmed_at timestamptz* |
| `care_items` | yes (forced) | yes | INSERT,SELECT | id uuid*, clinic_id uuid*, visit_id uuid*, patient_id uuid*, kind text*, corrects_id uuid, procedure_code text*, procedure_label text*, tooth_fdi smallint, surfaces text, fee_millimes bigint*, reason text, confirmed_by uuid*, confirmed_by_role text*, confirmed_at timestamptz* |
| `cash_counts` | yes (forced) | yes | INSERT,SELECT | id uuid*, clinic_id uuid*, period_id uuid*, attempt_no integer*, counted_by uuid*, counted_by_roles text*, counted_millimes bigint*, denominations jsonb, recount_reason text, submitted_at timestamptz*, expected_millimes bigint*, difference_millimes bigint*, counter_independent boolean*, independence_notes text* |
| `cash_drawers` | yes (forced) | — | INSERT,SELECT | id uuid*, clinic_id uuid*, name text*, created_at timestamptz* |
| `cash_movements` | yes (forced) | yes | INSERT,SELECT | id uuid*, clinic_id uuid*, period_id uuid*, kind text*, amount_millimes bigint*, reason text*, voucher_ref text, authorized_by uuid*, recorded_at timestamptz* |
| `cash_periods` | yes (forced) | — | INSERT,SELECT + UPDATE(accepted_count_id,close_note,closed_at,closed_by,cutoff_at,handover_millimes,status) | id uuid*, clinic_id uuid*, drawer_id uuid*, period_no integer*, opened_at timestamptz*, opened_by uuid*, opening_float_millimes bigint*, opening_basis text*, previous_period_id uuid, status text*, cutoff_at timestamptz, closed_at timestamptz, closed_by uuid, accepted_count_id uuid, handover_millimes bigint, close_note text |
| `clinic_card_settings` | yes (forced) | — | INSERT,SELECT + UPDATE(account_last4,import_stale_after_days,match_window_days,settlement_lag_days,updated_at,updated_by) | clinic_id uuid*, account_last4 text*, settlement_lag_days integer*, match_window_days integer*, import_stale_after_days integer*, updated_by uuid*, updated_at timestamptz* |
| `clinics` | no | — | SELECT | id uuid*, code text*, name text*, is_fictional boolean*, settings jsonb*, created_at timestamptz* |
| `exception_resolutions` | yes (forced) | yes | INSERT,SELECT | id uuid*, clinic_id uuid*, exception_key text*, reason_code text*, note text, resolved_by uuid*, resolved_at timestamptz* |
| `idempotency_records` | yes (forced) | — | INSERT,SELECT + UPDATE(response_body,response_status) | clinic_id uuid*, key text*, actor_staff_id uuid*, route text*, request_hash text*, response_status integer, response_body jsonb, created_at timestamptz* |
| `login_attempts` | no | — | INSERT,SELECT | id bigint*, clinic_id uuid, username text*, succeeded boolean*, at timestamptz* |
| `paper_books` | yes (forced) | yes | INSERT,SELECT | id uuid*, clinic_id uuid*, prefix text*, first_no integer*, last_no integer*, custodian_staff_id uuid*, issued_by uuid*, issued_at timestamptz*, note text |
| `paper_slip_entries` | yes (forced) | yes | INSERT,SELECT | id uuid*, clinic_id uuid*, book_id uuid*, slip_no integer*, entry_kind text*, amount_millimes bigint*, tender text, visit_id uuid, written_on date, note text, classification text*, content_hash text*, entered_by uuid*, entered_at timestamptz* |
| `patient_file_counters` | yes (forced) | — | INSERT,SELECT + UPDATE(next_no) | clinic_id uuid*, next_no integer* |
| `patients` | yes (forced) | — | INSERT,SELECT + UPDATE(contact_preference,family_name,given_name,name_ar,phone,preferred_language) | id uuid*, clinic_id uuid*, file_no integer*, family_name text*, given_name text*, name_ar text, date_of_birth date, sex text, phone text, contact_preference text*, preferred_language text*, is_synthetic boolean*, created_by uuid*, created_at timestamptz* |
| `payment_allocations` | yes (forced) | yes | INSERT,SELECT | clinic_id uuid*, payment_id uuid*, visit_id uuid*, amount_millimes bigint* |
| `payments` | yes (forced) | yes | INSERT,SELECT | id uuid*, clinic_id uuid*, patient_id uuid*, visit_id uuid*, amount_millimes bigint*, tender text*, source text*, card_terminal_ref text, card_last4 text, cash_period_id uuid, recorded_by uuid*, recorded_at timestamptz*, paper_slip_entry_id uuid |
| `provider_settlement_events` | yes (forced) | — | SELECT | id uuid*, clinic_id uuid*, provider_name text*, provider_event_ref text*, signature_verified boolean*, amount_millimes bigint*, received_at timestamptz* |
| `receipt_counters` | yes (forced) | — | INSERT,SELECT + UPDATE(next_number) | clinic_id uuid*, series text*, next_number integer* |
| `receipt_prints` | yes (forced) | yes | INSERT,SELECT | id uuid*, clinic_id uuid*, receipt_id uuid*, printed_by uuid*, printed_at timestamptz*, is_copy boolean* |
| `receipts` | yes (forced) | yes | INSERT,SELECT | id uuid*, clinic_id uuid*, series text*, number integer*, kind text*, payment_id uuid, adjustment_id uuid, issued_by uuid*, issued_at timestamptz*, snapshot jsonb*, snapshot_sha256 text* |
| `security_denials` | yes (forced) | — | INSERT,SELECT,UPDATE | clinic_id uuid*, staff_id uuid*, action text*, day date*, count integer*, last_at timestamptz* |
| `sessions` | no | — | INSERT,SELECT + UPDATE(last_seen_at,reauth_at,revoked_at) | token_hash text*, clinic_id uuid*, staff_id uuid*, created_at timestamptz*, last_seen_at timestamptz*, expires_at timestamptz*, reauth_at timestamptz, revoked_at timestamptz |
| `staff` | yes (forced) | — | INSERT,SELECT + UPDATE(active,deactivated_at,display_name,password_hash) | id uuid*, clinic_id uuid*, username text*, display_name text*, password_hash text*, active boolean*, created_at timestamptz*, deactivated_at timestamptz |
| `staff_roles` | yes (forced) | — | DELETE,INSERT,SELECT | clinic_id uuid*, staff_id uuid*, role text*, granted_at timestamptz*, granted_by uuid |
| `statement_imports` | yes (forced) | yes | INSERT,SELECT | id uuid*, clinic_id uuid*, imported_by uuid*, imported_at timestamptz*, file_name text*, file_sha256 text*, account_last4 text*, period_start date*, period_end date*, card_line_count integer*, discarded_non_card integer*, file_net_total_millimes bigint*, declared_total_millimes bigint, total_source text*, status text*, lines_new integer*, lines_already_known integer*, detail jsonb*, forced_reason text |
| `statement_lines` | yes (forced) | yes | INSERT,SELECT | id uuid*, clinic_id uuid*, import_id uuid*, line_key text*, txn_date date*, amount_millimes bigint*, is_reversal boolean*, terminal_ref text, card_last4 text, occurrence integer* |
| `visits` | yes (forced) | — | INSERT,SELECT + UPDATE(dentist_id,scheduled_at,status,status_changed_at,status_changed_by,status_reason) | id uuid*, clinic_id uuid*, patient_id uuid*, dentist_id uuid, scheduled_at timestamptz*, duration_min integer*, status text*, status_changed_at timestamptz*, status_changed_by uuid*, status_reason text, created_by uuid*, created_at timestamptz* |

Constraint counts in the migrated schema: CHECK=110, FOREIGN KEY=73, PRIMARY KEY=33, UNIQUE=30.


## Not yet in the schema (designed in docs/clinical-domain/clinical-requirements.md §16)

Odontogram events, findings, treatment plans/phases/quotes, clinical notes + addenda, medical alerts, consents, prescriptions, attachments/imaging metadata, lab cases, recalls, patient credits/deposits (MF10), multi-drawer cash, provider settlement feed.
