/*
 * Narrow, privacy-preserving secret-pattern tripwire for ALL refs fetched by GitHub Actions.
 * Outputs category + commit only, never credential bytes. NOT equivalent to full secret scanning,
 * entropy analysis, cloud-provider secret validation, or a complete compromise investigation.
 */
import { execFileSync } from 'node:child_process';

const signatures = [
  ['private-key-pem', /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/],
  ['github-classic-token', /gh[pousr]_[A-Za-z0-9_]{30,}/],
  ['github-fine-grained-token', /github_pat_[A-Za-z0-9_]{40,}/],
  ['aws-access-key-id', /(?:AKIA|ASIA)[A-Z0-9]{16}/],
  ['slack-access-token', /xox[baprs]-[0-9A-Za-z-]{20,}/],
  ['stripe-live-secret', /sk_live_[0-9A-Za-z]{16,}/],
  ['openai-like-secret', /sk-(?:proj-)?[A-Za-z0-9_-]{35,}/],
  ['google-api-key', /AIza[0-9A-Za-z_-]{35}/],
  ['npm-access-token', /npm_[A-Za-z0-9]{30,}/],
];
const suspiciousPath = /(^|\/)\.env(?:\..*)?$|(^|\/)(?:id_rsa|id_ed25519|credentials\.json|service-account\.json)$|\.(?:pem|p12|pfx|key|kdbx|dump|sqlite|sqlite3)$/i;
let log, tracked;
try {
  // Only known reachable refs: fetch-depth: 0 is mandatory in the CI workflow.
  log = execFileSync('git', ['log', '--all', '--format=COMMIT:%H', '-p', '--no-ext-diff', '--no-textconv'], {
    encoding: 'utf8', maxBuffer: 160 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
  });
  tracked = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }).split('\0').filter(Boolean);
} catch {
  console.error('SECURITY_SCAN_INCOMPLETE: git history or tracked-file enumeration failed. Fail closed.');
  process.exit(2);
}
const hits = new Map();
let commit = 'unknown';
let commits = 0;
for (const line of log.split('\n')) {
  if (line.startsWith('COMMIT:')) { commit = line.slice(7).trim(); commits++; continue; }
  // Scan added AND deleted code lines so removed credentials cannot be silently missed.
  if (!((line.startsWith('+') && !line.startsWith('+++')) || (line.startsWith('-') && !line.startsWith('---')))) continue;
  for (const [kind, pattern] of signatures) {
    if (pattern.test(line)) hits.set(`${kind}:${commit}`, { kind, commit });
  }
}
for (const path of tracked) {
  if (path.endsWith('.env.example')) continue;
  if (suspiciousPath.test(path)) hits.set(`suspicious-file:${path}`, { kind: 'suspicious-file', commit: 'tracked-path (redacted)' });
}
console.log(`Security tripwire reviewed ${commits} reachable git commits and ${tracked.length} current tracked paths.`);
if (hits.size) {
  console.error(`SECURITY_REVIEW_REQUIRED: ${hits.size} pattern hits (no secret values printed).`);
  for (const { kind, commit } of [...hits.values()].slice(0, 12)) console.error(`  ${kind} @ ${commit}`);
  process.exitCode = 1;
} else {
  console.log('No configured token signatures or disallowed file paths found. This is not a complete secrets clearance.');
}
