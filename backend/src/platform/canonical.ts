import crypto from 'node:crypto';

/** Deterministic JSON: object keys sorted recursively; used for hashing audit events and requests. */
export function canonicalJson(v: unknown): string {
  if (v === null || typeof v !== 'object') {
    if (typeof v === 'number' && !Number.isFinite(v)) throw new Error('Non-finite number in canonical JSON');
    return JSON.stringify(v ?? null);
  }
  if (Array.isArray(v)) return '[' + v.map(canonicalJson).join(',') + ']';
  const o = v as Record<string, unknown>;
  return '{' + Object.keys(o).filter(k => o[k] !== undefined).sort().map(k => JSON.stringify(k) + ':' + canonicalJson(o[k])).join(',') + '}';
}

export const sha256 = (s: string | Buffer) => crypto.createHash('sha256').update(s).digest('hex');
