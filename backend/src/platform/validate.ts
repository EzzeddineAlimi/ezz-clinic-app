/*
 * Input validation helpers. All request bodies are untrusted. Money is ALWAYS an integer number of
 * Tunisian millimes (1 TND = 1,000 millimes); floats, strings and exponents are rejected, never rounded.
 */
import { fail } from './errors.ts';

export type Body = Record<string, unknown>;

export const MAX_PAYMENT_MILLIMES = 100_000_000; // 100,000 TND per single operation (ASSUMPTION; configurable later)

export function asBody(v: unknown): Body {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) fail('VALIDATION_FAILED', 'JSON object body required');
  return v as Body;
}

export function str(b: Body, key: string, opts: { min?: number; max?: number; pattern?: RegExp; optional?: boolean } = {}): string {
  const v = b[key];
  if (v === undefined || v === null || v === '') {
    if (opts.optional) return '';
    fail('VALIDATION_FAILED', `${key} is required`, { field: key });
  }
  if (typeof v !== 'string') fail('VALIDATION_FAILED', `${key} must be a string`, { field: key });
  const s = (v as string).trim();
  if (s.length < (opts.min ?? 1) || s.length > (opts.max ?? 200)) fail('VALIDATION_FAILED', `${key} has invalid length`, { field: key });
  if (opts.pattern && !opts.pattern.test(s)) fail('VALIDATION_FAILED', `${key} has invalid format`, { field: key });
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(s)) fail('VALIDATION_FAILED', `${key} contains control characters`, { field: key });
  return s;
}

export function optStr(b: Body, key: string, opts: { max?: number; pattern?: RegExp } = {}): string | null {
  const s = str(b, key, { ...opts, optional: true, min: 0 });
  return s === '' ? null : s;
}

export function millimes(b: Body, key: string, opts: { allowZero?: boolean; allowNegative?: boolean; max?: number } = {}): number {
  const v = b[key];
  if (typeof v !== 'number' || !Number.isSafeInteger(v)) fail('VALIDATION_FAILED', `${key} must be an integer number of millimes`, { field: key });
  const n = v as number;
  const max = opts.max ?? MAX_PAYMENT_MILLIMES;
  if (n === 0 && !opts.allowZero) fail('VALIDATION_FAILED', `${key} must not be zero`, { field: key });
  if (n < 0 && !opts.allowNegative) fail('VALIDATION_FAILED', `${key} must not be negative`, { field: key });
  if (Math.abs(n) > max) fail('VALIDATION_FAILED', `${key} exceeds the per-operation limit`, { field: key, max });
  return n;
}

export function int(b: Body, key: string, min: number, max: number, optional = false): number | null {
  const v = b[key];
  if (v === undefined || v === null) { if (optional) return null; fail('VALIDATION_FAILED', `${key} is required`, { field: key }); }
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < min || v > max) fail('VALIDATION_FAILED', `${key} must be an integer in [${min}, ${max}]`, { field: key });
  return v as number;
}

export function oneOf<T extends string>(b: Body, key: string, allowed: readonly T[], optional = false): T | null {
  const v = b[key];
  if ((v === undefined || v === null) && optional) return null;
  if (typeof v !== 'string' || !(allowed as readonly string[]).includes(v)) fail('VALIDATION_FAILED', `${key} must be one of ${allowed.join(', ')}`, { field: key });
  return v as T;
}

export function bool(b: Body, key: string): boolean {
  const v = b[key];
  if (v === undefined) return false;
  if (typeof v !== 'boolean') fail('VALIDATION_FAILED', `${key} must be boolean`, { field: key });
  return v as boolean;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export function uuid(b: Body, key: string, optional = false): string {
  const v = b[key];
  if ((v === undefined || v === null) && optional) return '';
  if (typeof v !== 'string' || !UUID.test(v)) fail('VALIDATION_FAILED', `${key} must be a UUID`, { field: key });
  return v as string;
}
export const isUuid = (s: string) => UUID.test(s);

export function isoTime(b: Body, key: string): string {
  const s = str(b, key, { max: 40 });
  const d = new Date(s);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(s) || Number.isNaN(d.getTime())) fail('VALIDATION_FAILED', `${key} must be an ISO-8601 date-time`, { field: key });
  return d.toISOString();
}

export function isoDate(b: Body, key: string, optional = false): string | null {
  const v = b[key];
  if ((v === undefined || v === null) && optional) return null;
  const s = str(b, key, { max: 10, pattern: /^\d{4}-\d{2}-\d{2}$/ });
  if (Number.isNaN(new Date(s + 'T00:00:00Z').getTime())) fail('VALIDATION_FAILED', `${key} must be a valid date`, { field: key });
  return s;
}

/**
 * Exact decimal TND string -> integer millimes, for UI/import parsing (CH-020). Never rounds:
 * '12.345' -> 12345, '12' -> 12000, '1.0006' -> error, '' -> error, '1e3' -> error.
 */
export function parseTndToMillimes(input: string): number {
  const s = input.trim().replace(',', '.');
  const m = /^(-)?(\d{1,9})(?:\.(\d{1,3}))?$/.exec(s);
  if (!m) throw new Error('Invalid TND amount: use up to 3 decimals (millimes)');
  const whole = Number(m[2]);
  const frac = Number((m[3] ?? '').padEnd(3, '0'));
  const v = whole * 1000 + frac;
  return m[1] ? -v : v;
}

export function formatMillimes(m: number): string {
  const sign = m < 0 ? '-' : '';
  const a = Math.abs(m);
  return `${sign}${Math.floor(a / 1000)}.${String(a % 1000).padStart(3, '0')} TND`;
}
