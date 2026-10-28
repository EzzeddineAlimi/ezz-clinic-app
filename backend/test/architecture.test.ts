/*
 * Architecture fitness tests: module boundaries of the modular monolith (docs/architecture/module-map.md),
 * platform must not depend on modules, no floating-point money parsing, no SQL string interpolation of values.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');
const ALLOWED: Record<string, string[]> = {
  audit: [],
  identity: ['audit'],
  patients: ['audit'],
  workbench: [],
  care: ['audit', 'patients', 'medical'],
  medical: ['audit', 'patients'],
  clinical: ['audit', 'patients', 'care', 'medical'],
  billing: ['audit', 'patients'],
  integrity: ['audit', 'cash'],
  cash: ['audit', 'billing'],
  card: ['audit'],
  paper: ['audit', 'billing'],
  exceptions: ['audit', 'card', 'paper', 'integrity'],
  review: ['integrity'],
  dayboard: ['identity', 'patients'],
};
const importsOf = (file: string) => [...readFileSync(file, 'utf8').matchAll(/from '\.\/([a-z]+)\.ts'/g)].map(m => m[1]!);

test('ARCH-1 module dependency graph matches the declared map (no hidden coupling, no cycles)', () => {
  const files = readdirSync(join(SRC, 'modules')).filter(f => f.endsWith('.ts'));
  assert.deepEqual(files.map(f => f.replace('.ts', '')).sort(), Object.keys(ALLOWED).sort(), 'every module is declared');
  for (const f of files) {
    const mod = f.replace('.ts', '');
    for (const dep of importsOf(join(SRC, 'modules', f))) assert.ok(ALLOWED[mod]!.includes(dep), `${mod} must not import ${dep}`);
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
