/* Exercise the real pinned frontend linter: fixture exclusion, intentional RED, cleanup and GREEN. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, writeFile, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const biome = join(root, "node_modules", "@biomejs", "biome", "bin", "biome");
const lint = () => spawnSync(process.execPath, [biome, "lint", ".", "--reporter=json"], {
  cwd: root, encoding: "utf8", maxBuffer: 2 * 1024 * 1024,
});
const fixtures = join(root, "test", "fixtures");
await mkdir(fixtures, { recursive: true });
const ignored = await mkdtemp(join(fixtures, "lint-probe-"));
const authored = await mkdtemp(join(root, "src", "lint-probe-"));
try {
  await writeFile(join(ignored, "excluded.ts"), "const = ;\n");
  const baseline = lint();
  assert.ifError(baseline.error);
  assert.equal(baseline.status, 0, baseline.stdout + baseline.stderr);

  await writeFile(join(authored, "probe.ts"), "debugger;\n");
  const red = lint();
  assert.ifError(red.error);
  assert.equal(red.status, 1, red.stdout + red.stderr);
  const report = JSON.parse(red.stdout);
  assert.ok(report.diagnostics.some((d) =>
    d.category === "lint/suspicious/noDebugger" &&
    d.location.path.endsWith("probe.ts") &&
    d.location.path.includes("lint-probe-")
  ), "RED must identify authored noDebugger, not an unrelated failure");
  console.log("RED: authored debugger rejected; ignored fixture excluded.");
} finally {
  await rm(authored, { recursive: true, force: true });
  await rm(ignored, { recursive: true, force: true });
}
const green = lint();
assert.ifError(green.error);
assert.equal(green.status, 0, green.stdout + green.stderr);
console.log("GREEN: frontend lint restored after cleanup.");
