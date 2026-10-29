-- EZZ Clinic v0.2 — 0006 numbered paper outage books and slip re-entry (MF09, CH-010, C-146 T-PAPER-1..6).
-- FICTIONAL / SYNTHETIC DATA ONLY.
-- Paper slips live in their own namespace (prefix 'P', e.g. P-007) and NEVER consume electronic receipt numbers
-- (series 'R', e.g. R-000007). Every entry attempt is kept as evidence; only the first effective entry per slip
-- number can create a payment. ASSUMPTION (C-146): the dentist/owner physically holds and initials the book.

CREATE TABLE paper_books (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id          uuid NOT NULL REFERENCES clinics(id),
  prefix             text NOT NULL DEFAULT 'P' CHECK (prefix ~ '^P[A-Z0-9]?$'),
  first_no           integer NOT NULL CHECK (first_no > 0),
  last_no            integer NOT NULL,
  custodian_staff_id uuid NOT NULL,
  issued_by          uuid NOT NULL,
  issued_at          timestamptz NOT NULL DEFAULT now(),
  note               text,
  CHECK (last_no >= first_no AND last_no - first_no < 1000),
  UNIQUE (clinic_id, prefix, first_no),
  UNIQUE (clinic_id, id),
  FOREIGN KEY (clinic_id, custodian_staff_id) REFERENCES staff (clinic_id, id),
  FOREIGN KEY (clinic_id, issued_by) REFERENCES staff (clinic_id, id)
);
SELECT ezz_make_append_only('paper_books');

CREATE TABLE paper_slip_entries (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id       uuid NOT NULL REFERENCES clinics(id),
  book_id         uuid NOT NULL,
  slip_no         integer NOT NULL CHECK (slip_no > 0),
  entry_kind      text NOT NULL CHECK (entry_kind IN ('USED', 'VOID', 'UNUSED')),
  amount_millimes bigint NOT NULL DEFAULT 0 CHECK (amount_millimes >= 0 AND amount_millimes <= 100000000),
  tender          text CHECK (tender IS NULL OR tender IN ('CASH', 'CARD')),
  visit_id        uuid,
  written_on      date,
  note            text CHECK (note IS NULL OR length(note) <= 200),
  classification  text NOT NULL CHECK (classification IN ('POSTED', 'DUPLICATE_ENTRY', 'CONFLICT', 'VOID_RECORDED', 'UNUSED_DECLARED')),
  content_hash    text NOT NULL CHECK (content_hash ~ '^[0-9a-f]{64}$'),
  entered_by      uuid NOT NULL,
  entered_at      timestamptz NOT NULL DEFAULT now(),
  CHECK (entry_kind <> 'VOID' OR (amount_millimes = 0 AND length(coalesce(note, '')) >= 3)),
  CHECK (entry_kind <> 'UNUSED' OR amount_millimes = 0),
  CHECK (entry_kind <> 'USED' OR (amount_millimes > 0 AND tender IS NOT NULL AND visit_id IS NOT NULL)),
  UNIQUE (clinic_id, id),
  FOREIGN KEY (clinic_id, book_id) REFERENCES paper_books (clinic_id, id),
  FOREIGN KEY (clinic_id, visit_id) REFERENCES visits (clinic_id, id),
  FOREIGN KEY (clinic_id, entered_by) REFERENCES staff (clinic_id, id)
);
-- At most one EFFECTIVE entry per slip number; duplicates / conflicts are kept but never effective.
CREATE UNIQUE INDEX paper_slip_one_effective ON paper_slip_entries (clinic_id, book_id, slip_no)
  WHERE classification IN ('POSTED', 'VOID_RECORDED', 'UNUSED_DECLARED');
SELECT ezz_make_append_only('paper_slip_entries');

ALTER TABLE payments ADD COLUMN paper_slip_entry_id uuid;
ALTER TABLE payments ADD FOREIGN KEY (clinic_id, paper_slip_entry_id) REFERENCES paper_slip_entries (clinic_id, id);
ALTER TABLE payments ADD CONSTRAINT payments_paper_link CHECK ((source = 'PAPER_OUTAGE') = (paper_slip_entry_id IS NOT NULL));
CREATE UNIQUE INDEX payments_one_per_paper_slip ON payments (clinic_id, paper_slip_entry_id) WHERE paper_slip_entry_id IS NOT NULL;

SELECT ezz_enable_tenant_rls('paper_books');
SELECT ezz_enable_tenant_rls('paper_slip_entries');
GRANT SELECT, INSERT ON paper_books, paper_slip_entries TO ezz_app;
