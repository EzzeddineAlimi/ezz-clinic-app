export const ROLES = Object.freeze(['backend', 'frontend', 'database', 'ux', 'docs']);

const CHECKS = Object.freeze({
  backend: [
    ['npm', '--prefix', 'backend', 'run', 'typecheck'],
    ['npm', '--prefix', 'backend', 'run', 'lint'],
    ['npm', '--prefix', 'backend', 'test'],
    ['npm', '--prefix', 'backend', 'run', 'test:dist'],
  ],
  frontend: [
    ['npm', '--prefix', 'frontend', 'run', 'lint'],
    ['npm', '--prefix', 'frontend', 'test'],
    ['npm', '--prefix', 'frontend', 'run', 'build'],
    ['npm', '--prefix', 'frontend', 'run', 'test:e2e'],
  ],
  database: [
    ['npm', '--prefix', 'backend', 'run', 'typecheck'],
    ['npm', '--prefix', 'backend', 'test'],
    ['npm', '--prefix', 'backend', 'run', 'test:dist'],
  ],
  ux: [
    ['npm', '--prefix', 'frontend', 'run', 'lint'],
    ['npm', '--prefix', 'frontend', 'test'],
    ['npm', '--prefix', 'frontend', 'run', 'build'],
    ['npm', '--prefix', 'frontend', 'run', 'test:e2e'],
  ],
  docs: [
    ['node', '--test', 'scripts/harness/check.test.mjs'],
    ['node', 'scripts/harness/check.mjs'],
  ],
});

export function validateTask(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('Task must be a JSON object');
  }
  const { issue, branch, role, title, instructions, allowedPaths, risk } = input;
  if (!Number.isSafeInteger(issue) || issue < 1) {
    throw new Error('Task needs an existing GitHub issue number');
  }
  if (typeof branch !== 'string' || !/^gpt\/[a-z0-9][a-z0-9/-]*$/.test(branch) || branch.includes('..')) {
    throw new Error('Task must name an isolated gpt/ branch');
  }
  if (!ROLES.includes(role)) {
    throw new Error('Unrecognized coding role');
  }
  if (risk !== 'low' && risk !== 'high') {
    throw new Error('Risk must be low or high');
  }
  if (typeof title !== 'string' || title.trim().length < 8 || title.length > 120) {
    throw new Error('Task title must be between 8 and 120 characters');
  }
  if (typeof instructions !== 'string' || instructions.trim().length < 12) {
    throw new Error('Task needs explicit implementation instructions');
  }
  if (!Array.isArray(allowedPaths) || allowedPaths.length === 0 ||
    allowedPaths.some((p) => typeof p !== 'string' || !/^[a-zA-Z0-9_.\/-]+$/.test(p) ||
      p.startsWith('/') || p.startsWith('.') || p.split('/').includes('..'))) {
    throw new Error('Task needs safe, non-empty allowed path prefixes');
  }
  return { issue, branch, role, title, instructions, allowedPaths, risk };
}

export function checksForRole(role) {
  const checks = CHECKS[role];
  if (!checks) throw new Error('Unrecognized coding role');
  return checks;
}

export function changedPaths(porcelain) {
  const lines = porcelain.split('\n').filter(Boolean);
  return lines.map((line) => {
    if (line.length < 4 || line[2] !== ' ' || line.slice(0, 2).includes('R')) {
      throw new Error('Unsupported git status entry; resolve manually: ' + line);
    }
    return line.slice(3);
  });
}

export function assertScopedPaths(paths, prefixes) {
  if (paths.length === 0) throw new Error('Coding agent made no file changes');
  for (const path of paths) {
    const permitted = prefixes.some((prefix) =>
      path === prefix || path.startsWith(prefix.endsWith('/') ? prefix : prefix + '/'));
    if (!permitted) throw new Error('Out-of-scope file modified: ' + path);
  }
}

export function findCompetingPrs(rawJson, issue, branch) {
  const prs = JSON.parse(rawJson);
  if (!Array.isArray(prs)) throw new Error('GitHub PR inventory is not an array');
  const token = new RegExp('(^|[^0-9])#' + issue + '(?![0-9])');
  return prs.filter((pr) =>
    pr.headRefName !== branch && token.test(String(pr.body ?? '')));
}
