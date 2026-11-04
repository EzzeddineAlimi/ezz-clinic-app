import test from 'node:test';
import assert from 'node:assert/strict';
import { createEngineeringGraph } from '../src/graph.mjs';
import { validateTask, changedPaths, assertScopedPaths } from '../src/policy.mjs';

const task = {
  issue: 134,
  branch: 'gpt/langgraph-issue-134',
  role: 'docs',
  risk: 'low',
  title: 'Improve harness documentation for tests',
  instructions: 'Add a documented synthetic engineering verification example.',
  allowedPaths: ['docs/harness'],
};

function fakeCommands({ branch = task.branch, changed = ' M docs/harness/README.md\n', fail = '' } = {}) {
  const calls = [];
  let committed = false;
  const run = async (command, args) => {
    const key = command + ' ' + args.join(' ');
    calls.push(key);
    if (fail && key.includes(fail)) throw new Error('synthetic failing check');
    if (command === 'git' && args[0] === 'branch') return branch + '\n';
    if (command === 'git' && args[0] === 'status') return calls.filter((x) => x.startsWith('codex exec --sandbox workspace-write')).length ? changed : '';
    if (command === 'git' && args[0] === 'rev-parse') return committed ? 'newcommit\n' : 'basecommit\n';
    if (command === 'git' && args[0] === 'remote') return 'https://github.com/EzzeddineAlimi/ezz-clinic-app.git\n';
    if (command === 'gh' && args[0] === 'issue') return JSON.stringify({ number: 134, state: 'OPEN' });
    if (command === 'gh' && args[0] === 'pr' && args[1] === 'list') return '[]';
    if (command === 'codex') return args[2] === 'read-only' ? 'evidence-first plan' : 'modified a fictional document';
    if (command === 'git' && args[0] === 'diff') return 'docs/harness/README.md\n';
    if (command === 'git' && args[0] === 'commit') committed = true;
    if (command === 'gh' && args[1] === 'create') return 'https://github.com/EzzeddineAlimi/ezz-clinic-app/pull/999\n';
    return '';
  };
  return { run, calls };
}

test('routes an approved task through real coding, checks, draft PR and independent handoff', async () => {
  const fake = fakeCommands();
  const output = await createEngineeringGraph({ run: fake.run, repoRoot: '/fictional-checkout' }).invoke({ task });
  assert.equal(output.outcome, 'AWAITING_INDEPENDENT_REVIEW');
  assert.equal(output.prUrl, 'https://github.com/EzzeddineAlimi/ezz-clinic-app/pull/999');
  assert.ok(fake.calls.some((c) => c.includes('codex exec --sandbox workspace-write')));
  assert.ok(fake.calls.some((c) => c.includes('node --test scripts/harness/check.test.mjs')));
  assert.ok(fake.calls.some((c) => c.includes('gh pr create') && c.includes('--draft')));
  assert.ok(!fake.calls.some((c) => c.includes('gh pr merge')));
});

test('wrong branch stops before any coder runs', async () => {
  const fake = fakeCommands({ branch: 'main' });
  await assert.rejects(
    () => createEngineeringGraph({ run: fake.run, repoRoot: '/fictional-checkout' }).invoke({ task }),
    /Wrong checkout branch/,
  );
  assert.ok(!fake.calls.some((c) => c.startsWith('codex ')));
});

test('out-of-scope edits cannot be published', async () => {
  const fake = fakeCommands({ changed: ' M backend/src/modules/cash.ts\n' });
  await assert.rejects(
    () => createEngineeringGraph({ run: fake.run, repoRoot: '/fictional-checkout' }).invoke({ task }),
    /Out-of-scope file modified/,
  );
  assert.ok(!fake.calls.some((c) => c.startsWith('git push')));
});

test('failed checks stop before commit or push', async () => {
  const fake = fakeCommands({ fail: 'node --test scripts/harness/check.test.mjs' });
  await assert.rejects(
    () => createEngineeringGraph({ run: fake.run, repoRoot: '/fictional-checkout' }).invoke({ task }),
    /synthetic failing check/,
  );
  assert.ok(!fake.calls.some((c) => c.startsWith('git commit')));
  assert.ok(!fake.calls.some((c) => c.startsWith('git push')));
});

test('rejects invalid task and unsupported changes', () => {
  assert.throws(() => validateTask({ ...task, branch: 'main' }), /isolated/);
  assert.throws(() => validateTask({ ...task, allowedPaths: ['../backend'] }), /safe/);
  assert.deepEqual(changedPaths(' M docs/harness/README.md\n?? docs/harness/new.md\n'), [
    'docs/harness/README.md', 'docs/harness/new.md',
  ]);
  assert.throws(() => assertScopedPaths(['docs/other/file.md'], ['docs/harness']), /Out-of-scope/);
});
