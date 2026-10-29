# Patient documents and dental imaging attachments (R73 package D)

Status: **foundation, fictional data only, not reviewed, not production-ready.** Muse reviews it independently. It
stores and protects files attached to a patient. It does **not** view, measure, interpret or diagnose any image.

## What exists

| Concern | Behaviour | Test |
|---|---|---|
| Upload transport | Two steps. (1) JSON metadata with the declared type, size and SHA-256 → `AWAITING_CONTENT`. (2) Raw `application/octet-stream` bytes. The bytes are read only **after** authentication and the permission check. | T-DOCS-1, T-DOCS-2 |
| Who | `document.upload`, `document.read` and `document.correct` are **DENTIST** only, like the clinical record. `document.deletion_request` is **OWNER**, with password re-entry. | T-DOCS-2 |
| Types | Allow-list: JPEG, PNG, PDF, DICOM Part 10. The type is decided by magic bytes and must match the declaration; file names are never used. | T-DOCS-3, T-DOCS-14 |
| Size | 20 MiB per document (`MAX_DOCUMENT_BYTES`, an assumption for the PostgreSQL foundation). The received size and SHA-256 must equal the declaration. | T-DOCS-3 |
| Location privacy | Removes the JPEG EXIF GPS directory (other tags such as orientation are kept), JPEG XMP, and PNG `eXIf` and XMP chunks. An EXIF block that cannot be parsed is dropped whole. Both the received and the stored SHA-256 are recorded. | T-DOCS-1, T-DOCS-5, T-DOCS-14 |
| Screening | `QUARANTINE` → `ACTIVE` or `REJECTED`. The default screener is a **format check, not a malware scanner**: container structure, no trailing bytes (polyglots), and no PDF active content (`/JavaScript`, `/JS`, `/Launch`, embedded files, XFA, …, including `#xx`-escaped names). If the screener is unavailable, the document stays in QUARANTINE and `POST /documents/:id/screen` retries. | T-DOCS-5, T-DOCS-10 |
| Download | `ACTIVE` only. Always `Content-Disposition: attachment` with a generated file name, `nosniff`, `CSP: sandbox`, `no-store`, `CORP: same-origin`, and an `X-Content-Sha256` header. Bytes are re-hashed on every read; a mismatch returns 500 `CONTENT_INTEGRITY_FAILED` and the file is never served. Every download is an audit event. | T-DOCS-1, T-DOCS-8 |
| Isolation | Row-level security on all four tables. The composite key `(clinic, visit, patient)` makes a visit of another patient impossible, even for a direct insert. | T-DOCS-4 |
| Wrong patient | The dentist marks the document `ENTERED_IN_ERROR` with a reason. It can optionally be re-attached to the right patient or visit as a new document pointing to the same stored bytes. The original is withdrawn from lists and downloads but kept. | T-DOCS-6 |
| Deletion | **Nothing is ever deleted.** An owner records a deletion request (`AWAITING_RETENTION_POLICY`, `executed: false`). The application role has no DELETE or UPDATE, and all tables are append-only. | T-DOCS-7 |
| Integrity check | `DOCUMENT_CONTENT_MISMATCH` (stored bytes changed or missing), `DOCUMENT_AUDIT_VALUE_MISMATCH` (patient or SHA-256 differs from the audit event), `ROW_WITHOUT_AUDIT_EVENT`. | T-DOCS-8, T-DOCS-12 |
| Storage | `BlobStore` interface (`platform/blobstore.ts`). `PgBlobStore` (bytea, transactional, included in B14 encrypted backups) is the default. `MemoryBlobStore` proves the interface can be swapped. | T-DOCS-9, T-DOCS-13 |
| Concurrency | An advisory lock per document plus `UNIQUE (document_id, seq)`. Six parallel uploads of the same bytes store once; different bytes return 409. | T-DOCS-11 |

## Endpoints

| Method | Path | Permission |
|---|---|---|
| POST | `/api/v1/patients/:id/documents` (JSON, Idempotency-Key) | document.upload |
| POST | `/api/v1/documents/:id/content` (octet-stream; state-guarded, no Idempotency-Key) | document.upload |
| POST | `/api/v1/documents/:id/screen` | document.upload |
| GET | `/api/v1/patients/:id/documents[?includeEnteredInError=true]` | document.read |
| GET | `/api/v1/documents/:id` (metadata + history) | document.read |
| GET | `/api/v1/documents/:id/content` (binary attachment, audited) | document.read |
| POST | `/api/v1/documents/:id/entered-in-error` `{reason, reassignToPatientId?, visitId?}` | document.correct |
| POST | `/api/v1/documents/:id/deletion-requests` `{basis, reason}` (re-auth) | document.deletion_request |
| GET | `/api/v1/document-deletion-requests` | document.deletion_request |

Frontend notes (Astra):
- Compute SHA-256 in the browser (`crypto.subtle.digest`) before step 1.
- Downloads need the bearer header, so use `fetch` and then a blob URL. Never use a plain `<img src>` to the API.
- Show `status` exactly as returned. Never present `QUARANTINE` or `REJECTED` content, and never infer `ACTIVE`.

## Decisions NOT taken here (need the founder, operations or legal)

1. **Production storage**: provider, region and data residency (Tunisian health-data law), encryption keys, and the size limit for CBCT volumes. Large CBCT/3D files do not fit the 20 MiB PostgreSQL foundation.
2. **Malware scanning**: which scanner, where it runs, and whether uploads wait for it. The default screener checks formats only.
3. **Retention and deletion policy** (open question Q16): retention periods, legal holds, who approves an erasure, and whether backups are purged. Until then, deletion requests are only recorded.
4. **Access beyond the dentist**: assistant capture from a sensor, receptionist scanning of administrative paperwork, and owner access to non-clinical documents.
5. **DICOM headers** hold patient identity fields and are stored unparsed. Whether to check them against the patient, or de-identify them, is a clinical/legal decision.
6. **Image viewing** in the frontend (zoom, contrast, measurements) is out of scope; any measurement tool would need clinical review.
