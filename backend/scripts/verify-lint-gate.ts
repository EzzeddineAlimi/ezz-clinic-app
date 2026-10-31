/* Exercise the pinned real CLI: ignored synthetic fixtures, intentional RED, cleanup and GREEN.
 * No application/server/database changes. Safe to repeat locally and in the unconditional CI job.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { BACKEND_ROOT } from '../src/platform/paths.ts';

const biome = join(BACKEND_ROOT, 'node_modules', '@biomejs', 'biome', 'bin', 'biome');
const lint = () => spawnSync(process.execPath, [biome, 'lint', '.', '--reporter=json'], {
  cwd: BACKEND_ROOT, encoding: 'utf8', maxBuffer: 2 * 1024 * 1024,
});
const fixtures = join(BACKEND_ROOT, 'test', 'fixtures', 'synthetic');
await mkdir(fixtures, { recursive: true });
const ignored = await mkdtemp(join(fixtures, 'lint-probe-'));
const authored = await mkdtemp(join(BACKEND_ROOT, 'test', 'lint-probe-'));
try {
  // Invalid TypeScript must stay outside this authored-source lint scope.
  await writeFile(join(ignored, 'excluded.ts'), 'const = ;\n');
  const baseline = lint();
  assert.ifError(baseline.error);
  assert.equal(baseline.status, 0, baseline.stdout + baseline.stderr);

  await writeFile(join(authored, 'probe.ts'), 'debugger;\n');
  const red = lint();
  assert.ifError(red.error);
  assert.equal(red.status, 1, red.stdout + red.stderr);
  const report: { diagnostics: Array<{ category: string; location: { path: string } }> } = JSON.parse(red.stdout);
  assert.ok(report.diagnostics.some(d => d.category === 'lint/suspicious/noDebugger'
    && d.location.path.endsWith('probe.ts') && d.location.path.includes('lint-probe-')),
  'RED must identify the intentional authored noDebugger violation, not an unrelated command failure');
  console.log('RED verified: authored debugger rejected; ignored synthetic fixture was excluded.');
} finally {
  await rm(authored, { recursive: true, force: true });
  await rm(ignored, { recursive: true, force: true });
}
const green = lint();
assert.ifError(green.error);
assert.equal(green.status, 0, green.stdout + green.stderr);
console.log('GREEN verified: cleanup restores the passing authored-backend lint baseline.');
