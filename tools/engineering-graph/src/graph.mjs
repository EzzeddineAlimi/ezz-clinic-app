import { Annotation, StateGraph, START, END } from '@langchain/langgraph';
import {
  validateTask, checksForRole, changedPaths, assertScopedPaths, findCompetingPrs,
} from './policy.mjs';

const REPOSITORY = 'EzzeddineAlimi/ezz-clinic-app';
const State = Annotation.Root({
  task: Annotation(),
  sourceSha: Annotation(),
  branch: Annotation(),
  plan: Annotation(),
  summary: Annotation(),
  changedFiles: Annotation(),
  checkEvidence: Annotation(),
  prUrl: Annotation(),
  outcome: Annotation(),
});

export function createEngineeringGraph({ run, repoRoot }) {
  if (typeof run !== 'function' || typeof repoRoot !== 'string' || !repoRoot) {
    throw new Error('A command runner and checkout path are required');
  }
  const exec = (cmd, args) => run(cmd, args, { cwd: repoRoot });

  async function preflight(state) {
    const task = validateTask(state.task);
    const [branch, status, sha, remote] = await Promise.all([
      exec('git', ['branch', '--show-current']),
      exec('git', ['status', '--porcelain', '--untracked-files=all']),
      exec('git', ['rev-parse', 'HEAD']),
      exec('git', ['remote', 'get-url', 'origin']),
    ]);
    if (branch.trim() !== task.branch) throw new Error('Wrong checkout branch');
    if (status.trim()) throw new Error('Checkout must start clean');
    const allowedRemotes = new Set([
      'https://github.com/EzzeddineAlimi/ezz-clinic-app',
      'https://github.com/EzzeddineAlimi/ezz-clinic-app.git',
      'git@github.com:EzzeddineAlimi/ezz-clinic-app.git',
    ]);
    if (!allowedRemotes.has(remote.trim())) {
      throw new Error('Unexpected GitHub remote');
    }
    const issue = JSON.parse(await exec('gh', [
      'issue', 'view', String(task.issue), '--repo', REPOSITORY, '--json', 'number,state',
    ]));
    if (issue.number !== task.issue || issue.state !== 'OPEN') {
      throw new Error('Task issue is not open');
    }
    const prs = await exec('gh', [
      'pr', 'list', '--repo', REPOSITORY, '--state', 'open',
      '--json', 'number,headRefName,body', '--limit', '100',
    ]);
    const competing = findCompetingPrs(prs, task.issue, task.branch);
    if (competing.length) throw new Error('Existing PR owns issue #' + task.issue);
    return { task, sourceSha: sha.trim(), branch: branch.trim() };
  }

  async function plan(state) {
    const task = state.task;
    const prompt = [
      'Read AGENTS.md and the applicable EZZ engineering playbook.',
      'Make a narrow implementation plan only. Do not edit, stage, commit or push.',
      'Do not use real patient data, payment credentials or production endpoints.',
      'Issue: #' + task.issue + ' — ' + task.title,
      'Role: ' + task.role + '. Risk: ' + task.risk,
      'Allowed paths: ' + task.allowedPaths.join(', '),
      'Task: ' + task.instructions,
      'Base SHA: ' + state.sourceSha,
      'For bugs formulate a theory, collect direct proof, then consider a fix.',
    ].join('\n');
    const output = await exec('codex', [
      'exec', '--sandbox', 'read-only', '--cd', repoRoot, prompt,
    ]);
    if (!output.trim()) throw new Error('Planning agent returned no evidence');
    return { plan: output.trim() };
  }

  function coder(role) {
    return async (state) => {
      if (state.task.role !== role) throw new Error('Wrong coder route');
      const prompt = [
        'Implement the approved EZZ Clinic development task. Read AGENTS.md.',
        'Work only inside the permitted paths. Use fictional data exclusively.',
        'Never deploy, merge, push, commit, modify credentials or change real patient/payment data.',
        'Respect independent review and current clinical, financial and privacy gates.',
        'For bugs: theory, direct test/log evidence, minimal fix, regression test.',
        'Role: ' + role,
        'Issue: #' + state.task.issue + ' — ' + state.task.title,
        'Allowed paths: ' + state.task.allowedPaths.join(', '),
        'Instructions: ' + state.task.instructions,
        'Plan to follow after verifying source: ' + state.plan,
      ].join('\n');
      const summary = await exec('codex', [
        'exec', '--sandbox', 'workspace-write', '--cd', repoRoot, prompt,
      ]);
      const changed = changedPaths(await exec('git', [
        'status', '--porcelain', '--untracked-files=all',
      ]));
      assertScopedPaths(changed, state.task.allowedPaths);
      return { summary: summary.trim(), changedFiles: changed };
    };
  }

  async function checks(state) {
    const evidence = [];
    for (const [command, ...args] of checksForRole(state.task.role)) {
      await exec(command, args);
      evidence.push(command + ' ' + args.join(' ') + ': PASS');
    }
    return { checkEvidence: evidence };
  }

  async function publishDraft(state) {
    await exec('git', ['add', '--', ...state.changedFiles]);
    const staged = (await exec('git', ['diff', '--cached', '--name-only'])).trim().split('\n').filter(Boolean);
    if (staged.sort().join('\n') !== [...state.changedFiles].sort().join('\n')) {
      throw new Error('Staged files differ from reviewed scope');
    }
    await exec('git', ['commit', '-m', 'feat(agents): implement issue #' + state.task.issue + ' via LangGraph']);
    const head = (await exec('git', ['rev-parse', 'HEAD'])).trim();
    await exec('git', ['push', '--set-upstream', 'origin', state.task.branch]);
    const body = [
      'Issue #' + state.task.issue,
      'Coding role: ' + state.task.role + '. Risk: ' + state.task.risk + '.',
      'Base SHA: ' + state.sourceSha + '. Draft head: ' + head + '.',
      'Changed paths: ' + state.changedFiles.join(', '),
      'Executed local checks (must be independently corroborated at exact PR head):',
      ...state.checkEvidence,
      'AWAITING INDEPENDENT REVIEW. No self-approval, automated merge, deployment or V1 acceptance.',
      'High-risk changes require founder authorization and applicable domain review.',
    ].join('\n');
    const url = (await exec('gh', [
      'pr', 'create', '--repo', REPOSITORY, '--base', 'main',
      '--head', state.task.branch, '--draft',
      '--title', state.task.title, '--body', body,
    ])).trim();
    if (!url.startsWith('https://github.com/EzzeddineAlimi/ezz-clinic-app/pull/')) {
      throw new Error('Draft PR creation was not verified');
    }
    return { prUrl: url, sourceSha: head };
  }

  function reviewHandoff(state) {
    if (!state.prUrl || !state.checkEvidence?.length) {
      throw new Error('No independent review handoff without an evidenced draft');
    }
    return { outcome: 'AWAITING_INDEPENDENT_REVIEW' };
  }

  return new StateGraph(State)
    .addNode('preflight', preflight)
    .addNode('planning', plan)
    .addNode('backend_coder', coder('backend'))
    .addNode('frontend_coder', coder('frontend'))
    .addNode('database_coder', coder('database'))
    .addNode('ux_coder', coder('ux'))
    .addNode('docs_coder', coder('docs'))
    .addNode('checks', checks)
    .addNode('draft_pr', publishDraft)
    .addNode('independent_review_handoff', reviewHandoff)
    .addEdge(START, 'preflight')
    .addEdge('preflight', 'planning')
    .addConditionalEdges('planning', (state) => state.task.role, {
      backend: 'backend_coder',
      frontend: 'frontend_coder',
      database: 'database_coder',
      ux: 'ux_coder',
      docs: 'docs_coder',
    })
    .addEdge('backend_coder', 'checks')
    .addEdge('frontend_coder', 'checks')
    .addEdge('database_coder', 'checks')
    .addEdge('ux_coder', 'checks')
    .addEdge('docs_coder', 'checks')
    .addEdge('checks', 'draft_pr')
    .addEdge('draft_pr', 'independent_review_handoff')
    .addEdge('independent_review_handoff', END)
    .compile();
}
