/*
 * Replaceable storage for patient-document bytes (R73-D). The document module only sees this interface and an opaque
 * reference string, so a different store can replace the PostgreSQL one without a schema change to documents.
 *
 * PgBlobStore is a DEVELOPMENT/PILOT FOUNDATION, NOT A PRODUCTION STORAGE DECISION: bytes live in an append-only,
 * row-level-secured table, inside the request transaction (no orphan files on rollback) and inside the encrypted B14
 * backups. It is capped at MAX_DOCUMENT_BYTES, which excludes large CBCT volumes. Where documents are finally stored
 * (provider, region, encryption keys, retention) is a founder/operations decision recorded in
 * docs/product/patient-documents.md. Any store must: be clinic-scoped, never be publicly addressable, and return
 * exactly the bytes it was given (the caller re-verifies SHA-256 on every read).
 */
import type { Tx } from './db.ts';
import { randomUUID } from 'node:crypto';
import { sha256Hex } from './fileinspect.ts';

export const MAX_DOCUMENT_BYTES = 20 * 1024 * 1024; // ASSUMPTION for the PostgreSQL foundation; 2D images and PDFs

export interface StoredBlob { ref: string; sha256: string; size: number }

export interface BlobStore {
  /** Short stable name recorded with each stored document, e.g. "postgres-bytea-v1". */
  readonly kind: string;
  put(tx: Tx, clinicId: string, bytes: Buffer): Promise<StoredBlob>;
  /** The stored bytes, or null when the reference is unknown in this clinic. */
  get(tx: Tx, clinicId: string, ref: string): Promise<Buffer | null>;
}

const PG_REF = /^pg:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;

export class PgBlobStore implements BlobStore {
  readonly kind = 'postgres-bytea-v1';
  async put(tx: Tx, clinicId: string, bytes: Buffer): Promise<StoredBlob> {
    if (bytes.length < 1 || bytes.length > MAX_DOCUMENT_BYTES) throw new RangeError('blob size out of range');
    const sha256 = sha256Hex(bytes);
    const r = await tx.one<{ id: string }>('INSERT INTO document_blobs (clinic_id, sha256, size_bytes, content) VALUES ($1,$2,$3,$4) RETURNING id',
      [clinicId, sha256, bytes.length, bytes]);
    return { ref: 'pg:' + r.id, sha256, size: bytes.length };
  }
  async get(tx: Tx, clinicId: string, ref: string): Promise<Buffer | null> {
    const m = PG_REF.exec(ref);
    if (!m) return null;
    const r = await tx.maybeOne<{ content: Buffer }>('SELECT content FROM document_blobs WHERE clinic_id = $1 AND id = $2', [clinicId, m[1]!]);
    return r ? r.content : null;
  }
}

/** In-memory store: proves the interface is replaceable (tests only; loses data on restart). */
export class MemoryBlobStore implements BlobStore {
  readonly kind = 'memory-test-only';
  private readonly blobs = new Map<string, { clinicId: string; bytes: Buffer }>();
  async put(_tx: Tx, clinicId: string, bytes: Buffer): Promise<StoredBlob> {
    const ref = 'mem:' + randomUUID();
    this.blobs.set(ref, { clinicId, bytes: Buffer.from(bytes) });
    return { ref, sha256: sha256Hex(bytes), size: bytes.length };
  }
  async get(_tx: Tx, clinicId: string, ref: string): Promise<Buffer | null> {
    const b = this.blobs.get(ref);
    return b && b.clinicId === clinicId ? Buffer.from(b.bytes) : null;
  }
  /** Test hook: simulate silent corruption in the backing store. */
  corrupt(ref: string) { const b = this.blobs.get(ref); if (b) b.bytes[b.bytes.length - 1] = b.bytes.at(-1)! ^ 0xff; }
}
