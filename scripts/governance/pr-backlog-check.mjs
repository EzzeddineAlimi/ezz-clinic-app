import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const MAX_STACK = 3;
const MAX_STACK_ROOT_HOURS = 24;
const MAX_SINGLE_PR_HOURS = 48;

export function auditPullRequests(pulls, now = new Date()) {
  const byHead = new Map(pulls.map(pr => [pr.head.ref, pr]));
  if (byHead.size !== pulls.length) throw new Error('Duplicate open PR head branch');
  const groups = new Map();

  for (const pr of pulls) {
    const chain = [];
    const visited = new Set();
    let current = pr;
    while (current) {
      if (visited.has(current.number)) throw new Error(`PR base cycle at #${current.number}`);
      visited.add(current.number);
      chain.unshift(current.number);
      current = byHead.get(current.base.ref);
    }
    const rootNumber = chain[0];
    const group = groups.get(rootNumber) ?? {root: pulls.find(p => p.number === rootNumber), members: new Set(), longest: []};
    for (const number of chain) group.members.add(number);
    if (chain.length > group.longest.length) group.longest = chain;
    groups.set(rootNumber, group);
  }

  const findings = [];
  for (const group of groups.values()) {
    const ageHours = (now.getTime() - Date.parse(group.root.created_at)) / 3_600_000;
    if (!Number.isFinite(ageHours) || ageHours < 0) throw new Error(`Invalid created_at for #${group.root.number}`);
    if (group.longest.length > MAX_STACK) {
      findings.push({code: 'STACK_TOO_DEEP', root: group.root.number, detail: `${group.longest.length} linked open PRs: ${group.longest.map(n => `#${n}`).join(' → ')}`});
    }
    if (group.members.size > 1 && ageHours >= MAX_STACK_ROOT_HOURS) {
      findings.push({code: 'STACK_ROOT_AGING', root: group.root.number, detail: `stack root open ${Math.floor(ageHours)}h (limit ${MAX_STACK_ROOT_HOURS}h)`});
    }
    if (group.members.size === 1 && ageHours >= MAX_SINGLE_PR_HOURS) {
      findings.push({code: 'STANDALONE_AGING', root: group.root.number, detail: `unintegrated PR open ${Math.floor(ageHours)}h (limit ${MAX_SINGLE_PR_HOURS}h)`});
    }
  }
  return {openCount: pulls.length, stackCount: [...groups.values()].filter(g => g.members.size > 1).length, findings};
}

export function reportMarkdown(audit, repo) {
  const lines = ['## EZZ open-PR integration watch', '', `Open PRs: **${audit.openCount}** · stacks: **${audit.stackCount}** · actionable findings: **${audit.findings.length}**.`, ''];
  if (audit.findings.length === 0) lines.push('PASS: No stack-depth or age threshold exceeded. This is NOT CI/reviewer/release approval.');
  for (const f of audit.findings) lines.push(`- **${f.code}** at [#${f.root}](https://github.com/${repo}/pull/${f.root}): ${f.detail}`);
  if (audit.findings.length) lines.push('', 'FAIL: Stop extending affected stacks; reconcile their root against current main and make a reviewed integration candidate. Do not close unmerged work or bypass clinical/payment/security gates.');
  return lines.join('\n') + '\n';
}

async function getOpenPulls(repo, token, fetcher = fetch) {
  const pulls = [];
  for (let page = 1; page <= 10; page++) {
    const response = await fetcher(`https://api.github.com/repos/${repo}/pulls?state=open&per_page=100&page=${page}`, {
      headers: {Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'User-Agent': 'ezz-pr-backlog-watch'}
    });
    if (!response.ok) throw new Error(`GitHub PR list failed with HTTP ${response.status}`);
    const chunk = await response.json();
    if (!Array.isArray(chunk)) throw new Error('GitHub PR list response is not an array');
    pulls.push(...chunk);
    if (chunk.length < 100) return pulls;
  }
  throw new Error('Open PR inventory exceeded 1000; refusing partial audit');
}

async function main() {
  const repo = process.env.GITHUB_REPOSITORY;
  const token = process.env.GITHUB_TOKEN;
  if (!repo || !/^[\w.-]+\/[\w.-]+$/.test(repo) || !token) throw new Error('GITHUB_REPOSITORY and GITHUB_TOKEN are required');
  const result = auditPullRequests(await getOpenPulls(repo, token));
  const markdown = reportMarkdown(result, repo);
  console.log(markdown);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, markdown);
  if (result.findings.length) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
