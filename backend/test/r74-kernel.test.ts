/*
 * R74 package A — the shared helpers that replaced duplicated code keep the exact behaviour of the copies they replaced.
 *   T-KERNEL-LOCK-1   advisoryLock(tx, ns, id) takes the same lock key as the old inline hashtext('<ns>:' || id), so a
 *                     lock taken by old code (another draft branch, a stale process) still excludes new code.
 *   T-KERNEL-ARRAY-1  pgTextArray / pgIntArray parse what the driver returns (text '{a,b}', JS arrays, NULL) and refuse
 *                     quoted elements instead of mis-splitting them.
 *   T-KERNEL-HASH-1   sha256OrNull hashes a note or keeps null (the R73-H audit anchor rule).
 *   T-KERNEL-SITE-1   the shared tooth-list / area-code readers keep the documents and lab contracts.
 *   T-KERNEL-DAY-1    clinicDay (moved to settings) keeps its validation and its default (today in the clinic timezone).
 * Fictional data only.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb, type TestDb } from './helpers.ts';
import { Db, advisoryLock, pgIntArray, pgTextArray } from '../src/platform/db.ts';
import { sha256, sha256OrNull } from '../src/platform/canonical.ts';
import { readAreaCode, readTeethList, isValidAreaCode, AREA_CODES } from '../src/contracts/clinical.ts';
import { clinicDay, localDate } from '../src/modules/settings.ts';
import { AppError } from '../src/platform/errors.ts';

let db: TestDb;
before(async () => { db = await createTestDb(); });
after(async () => { await db.drop(); });

test('T-KERNEL-LOCK-1 advisoryLock uses the legacy lock key', async () => {
  const pool = new Db(db.ownerUrl, 2);
  try {
    const id = '7d0f6a52-6f3c-4c39-9b1a-1f6d1f0f0a01';
    await pool.tx(null, async tx => {
      await advisoryLock(tx, 'lab_case', id);
      const r = await tx.one<{ held: boolean }>(`SELECT EXISTS (SELECT 1 FROM pg_locks WHERE locktype = 'advisory' AND pid = pg_backend_pid()
        AND ((classid::bigint << 32) | objid::bigint) = (hashtext('lab_case:' || $1)::bigint & 4294967295)) AS held`, [id]);
      assert.equal(r.held, true);
    });
  } finally { await pool.close(); }
});

test('T-KERNEL-ARRAY-1 PostgreSQL array parsing', () => {
  assert.deepEqual(pgTextArray('{EXIF_GPS,XMP}'), ['EXIF_GPS', 'XMP']);
  assert.deepEqual(pgTextArray('{}'), []);
  assert.deepEqual(pgTextArray(null), []);
  assert.deepEqual(pgTextArray(['a', 'b']), ['a', 'b']);
  assert.deepEqual(pgIntArray('{11,12,48}'), [11, 12, 48]);
  assert.deepEqual(pgIntArray([21]), [21]);
  assert.throws(() => pgTextArray('{"a,b",c}'), /quoted array elements/);
});

test('T-KERNEL-HASH-1 sha256OrNull', () => {
  assert.equal(sha256OrNull(null), null);
  assert.equal(sha256OrNull('Fictional note'), sha256('Fictional note'));
});

const failsWith = (fn: () => unknown, message: RegExp) => assert.throws(fn, (e: unknown) => e instanceof AppError && e.code === 'VALIDATION_FAILED' && message.test(e.message));

test('T-KERNEL-SITE-1 tooth list and area code readers', () => {
  assert.deepEqual(readTeethList({ teeth: [21, 11] }), [11, 21], 'sorted');
  assert.deepEqual(readTeethList({}), []);
  failsWith(() => readTeethList({ teeth: [11, 11] }), /distinct FDI tooth numbers/);
  failsWith(() => readTeethList({ teeth: [19] }), /distinct FDI tooth numbers/);
  failsWith(() => readTeethList({ teeth: '11' }), /distinct FDI tooth numbers/);
  assert.equal(readAreaCode({}), null);
  assert.equal(readAreaCode({ areaCode: 10 }), 10);
  failsWith(() => readAreaCode({ areaCode: 11 }), /ISO 3950 area code/);
  assert.deepEqual(AREA_CODES.filter(isValidAreaCode), AREA_CODES);
});

test('T-KERNEL-DAY-1 clinicDay validation and default', () => {
  assert.equal(clinicDay(new URLSearchParams('day=2026-02-28'), 'Africa/Tunis'), '2026-02-28');
  assert.equal(clinicDay(new URLSearchParams(), 'Africa/Tunis'), localDate('Africa/Tunis'));
  failsWith(() => clinicDay(new URLSearchParams('day=2026-02-30'), 'Africa/Tunis'), /real date/);
  failsWith(() => clinicDay(new URLSearchParams('day=tomorrow'), 'Africa/Tunis'), /real date/);
});
