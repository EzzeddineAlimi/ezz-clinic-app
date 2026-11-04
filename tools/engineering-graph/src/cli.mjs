import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createEngineeringGraph } from './graph.mjs';
import { runProcess } from './process.mjs';
import { validateTask } from './policy.mjs';

if (process.argv.length !== 4) {
  throw new Error('Usage: npm start -- /absolute/checkout/path /path/to/task.json');
}
const root = resolve(process.argv[2]);
const task = validateTask(JSON.parse(await readFile(resolve(process.argv[3]), 'utf8')));
const graph = createEngineeringGraph({ run: runProcess, repoRoot: root });
const result = await graph.invoke({ task });
process.stdout.write(JSON.stringify({
  issue: task.issue,
  branch: result.branch,
  headSha: result.sourceSha,
  draftPr: result.prUrl,
  executedChecks: result.checkEvidence,
  state: result.outcome,
}, null, 2) + '\n');
