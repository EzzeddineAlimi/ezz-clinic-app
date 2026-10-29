/*
 * Architecture fitness tests: module boundaries of the modular monolith (the ALLOWED map below is the source of truth),
 * platform must not depend on modules, no floating-point money parsing, no SQL string interpolation of values,
 * and (R74) one owner for each shared rule: advisory locks, dental-site validation, clinic-day computation.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SOURCE_DIR } from '../src/platform/paths.ts';

const SRC = SOURCE_DIR; // TypeScript sources, also when this test runs compiled
const ALLOWED: Record<string, string[]> = {
  audit: [],
  identity: ['audit', 'settings'],
  patients: ['audit', 'settings'],
  workbench: [],
  care: ['audit', 'patients', 'medical'],
  medical: ['audit', 'patients', 'settings'],
  clinical: ['audit', 'patients', 'care', 'medical'],
  billing: ['audit', 'patients'],
  integrity: ['audit', 'cash', 'clinical'],
  cash: ['audit', 'billing'],
  card: ['audit', 'settings'],
  paper: ['audit', 'billing', 'settings'],
  exceptions: ['audit', 'card', 'paper', 'integrity', 'settings', 'lab'],
  review: ['integrity', 'settings'],
  dayboard: ['identity', 'settings'],
  print: ['audit', 'settings'],
  checkpoints: ['audit', 'print', 'settings'],
  settings: ['audit'],
  documents: ['audit', 'patients'],
  lab: ['audit', 'patients', 'settings'],
  stock: ['audit', 'settings'],
};
const importsOf = (file: string) => [...readFileSync(file, 'utf8').matchAll(/from '\.\/([a-z]+)\.ts'/g)].map(m => m[1]!);

test('ARCH-1 module dependency graph matches the declared map (no hidden coupling, no cycles)', () => {
  const files = readdirSync(join(SRC, 'modules')).filter(f => f.endsWith('.ts'));
  assert.deepEqual(files.map(f => f.replace('.ts', '')).sort(), Object.keys(ALLOWED).sort(), 'every module is declared');
  for (const f of files) {
    const mod = f.replace('.ts', '');
    const deps = importsOf(join(SRC, 'modules', f));
    for (const dep of deps) assert.ok(ALLOWED[mod]!.includes(dep), `${mod} must not import ${dep}`);
    for (const dep of ALLOWED[mod]!) assert.ok(deps.includes(dep), `${mod} declares ${dep} but no longer uses it: remove it from the map`);
  }
});

test('ARCH-2 platform layer never imports a business module', () => {
  for (const f of readdirSync(join(SRC, 'platform'))) {
    const text = readFileSync(join(SRC, 'platform', f), 'utf8');
    assert.ok(!/from '\.\.\/modules\//.test(text), `platform/${f} imports a module`);
  }
});

test('ARCH-3 money safety: no parseFloat / Math.round / toFixed on amounts in server code', () => {
  for (const dir of ['modules', 'platform']) for (const f of readdirSync(join(SRC, dir))) {
    const text = readFileSync(join(SRC, dir, f), 'utf8');
    assert.ok(!/parseFloat\(|Math\.round\(|\.toFixed\(/.test(text), `${dir}/${f} uses float rounding`);
  }
});

test('ARCH-4 SQL values are parameterised: no ${...} interpolation inside SQL strings except whitelisted identifiers', () => {
  for (const f of readdirSync(join(SRC, 'modules'))) {
    const text = readFileSync(join(SRC, 'modules', f), 'utf8');
    for (const m of text.matchAll(/`((?:SELECT|INSERT|UPDATE|DELETE)[^`]*)`/g)) {
      for (const expr of m[1]!.matchAll(/\$\{([^}]*)\}/g)) {
        const ok = /^(table|lock|input\.paperSlipEntryId \? .*)$/.test(expr[1]!.trim());
        assert.ok(ok, `${f}: interpolated SQL expression \${${expr[1]}}`);
      }
    }
  }
});

test('ARCH-5 docs/security/permission-matrix.md is in sync with the code matrix', async () => {
  const { renderPermissionMatrix } = await import('../scripts/gen-permission-matrix.ts');
  const doc = readFileSync(join(SRC, '..', '..', 'docs', 'security', 'permission-matrix.md'), 'utf8');
  assert.equal(doc, renderPermissionMatrix());
});

const serverFiles = () => ['modules', 'platform', 'contracts'].flatMap(dir => readdirSync(join(SRC, dir)).filter(f => f.endsWith('.ts')).map(f => `${dir}/${f}`));
const read = (rel: string) => readFileSync(join(SRC, rel), 'utf8');

test('ARCH-6 shared rules have one owner (R74): advisory locks, dental-site validation, clinic-day, pg arrays', () => {
  for (const rel of serverFiles()) {
    const text = read(rel);
    if (rel !== 'platform/db.ts') {
      assert.ok(!text.includes('pg_advisory_xact_lock'), `${rel}: take advisory locks through db.ts advisoryLock()`);
      assert.ok(!/replace\(\/\[\{\}\]\/g/.test(text), `${rel}: parse PostgreSQL arrays with db.ts pgTextArray()/pgIntArray()`);
    }
    if (rel !== 'contracts/clinical.ts') assert.ok(!/AREA_CODES\s*=/.test(text), `${rel}: ISO 3950 area codes live in contracts/clinical.ts`);
    if (rel !== 'modules/settings.ts' && rel !== 'modules/print.ts') assert.ok(!text.includes('Intl.DateTimeFormat'), `${rel}: clinic days come from settings.ts localDate()/clinicDay()`);
  }
});

test('ARCH-7 nothing imports the deprecated pgwire.ts shim (kept only for open draft branches)', () => {
  const roots = [join(SRC, '..', 'test'), join(SRC, '..', 'scripts')];
  const files = [...serverFiles().map(rel => join(SRC, rel)), ...roots.flatMap(d => readdirSync(d).filter(f => f.endsWith('.ts')).map(f => join(d, f)))];
  for (const file of files) if (!file.endsWith('pgwire.ts')) assert.ok(!/from '[./a-z]*\/pgwire\.ts'/.test(readFileSync(file, 'utf8')), `${file}: import from platform/postgres.ts`);
});
