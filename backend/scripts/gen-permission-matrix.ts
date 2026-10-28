/* Generates docs/security/permission-matrix.md from the code matrix (single source of truth). Usage: node scripts/gen-permission-matrix.ts > ../docs/security/permission-matrix.md */
import { PERMISSIONS, ROLES } from '../src/modules/identity.ts';

export function renderPermissionMatrix(): string {
  const lines = [
    '# Permission matrix (generated — do not edit by hand)',
    '',
    'Source of truth: `backend/src/modules/identity.ts` `PERMISSIONS`. Regenerate with `node scripts/gen-permission-matrix.ts`; `test/architecture.test.ts` fails if this file drifts.',
    'Enforced server-side on every request; identity comes only from the session. Routes marked *re-auth* in docs/api/api-v1.md additionally need a password re-entry within 5 minutes.',
    '',
    `| Permission | ${ROLES.join(' | ')} |`,
    `|---|${ROLES.map(() => ':-:').join('|')}|`,
  ];
  for (const [perm, roles] of Object.entries(PERMISSIONS)) lines.push(`| \`${perm}\` | ${ROLES.map(r => (roles.includes(r) ? 'yes' : '—')).join(' | ')} |`);
  return lines.join('\n') + '\n';
}

if (process.argv[1]?.endsWith('gen-permission-matrix.ts')) process.stdout.write(renderPermissionMatrix());
