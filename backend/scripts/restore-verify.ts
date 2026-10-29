/* Restore an encrypted backup into a NEW database and verify it (B14). FICTIONAL DATA ONLY.
 * Usage: EZZ_ADMIN_URL=postgres://...(target instance) EZZ_BACKUP_PASSPHRASE='...' EZZ_OWNER_PW=... EZZ_APP_PW=...
 *        node scripts/restore-verify.ts <file.dump.enc> <file.manifest.json> <new-database> [anchors.json | checkpoints.txt]
 * anchors.json (optional): { "<clinicId>": [{ "seq": 12, "hash": "..." }] } — the owner's outside checkpoints, or
 * checkpoints.txt: one owner checkpoint line per line (EZZ-CP2 ... as printed by POST /api/v1/owner/checkpoints).
 * Exit code 0 only if every check passes; the JSON report lists each check and the measured timings. */
import { readFileSync } from 'node:fs';
import { restoreAndVerify } from '../src/ops/disaster-recovery.ts';
import { MIGRATIONS_DIR } from '../src/platform/paths.ts';

const [encryptedPath, manifestPath, targetDatabase, anchorsPath] = process.argv.slice(2);
const env = process.env;
if (!encryptedPath || !manifestPath || !targetDatabase || !env.EZZ_ADMIN_URL || !env.EZZ_BACKUP_PASSPHRASE || !env.EZZ_OWNER_PW || !env.EZZ_APP_PW) {
  process.stderr.write('usage: see header of scripts/restore-verify.ts\n');
  process.exit(2);
}
const report = await restoreAndVerify({
  encryptedPath, manifestPath, targetDatabase, passphrase: env.EZZ_BACKUP_PASSPHRASE,
  targetAdminUrl: env.EZZ_ADMIN_URL, rolePasswords: { owner: env.EZZ_OWNER_PW, app: env.EZZ_APP_PW },
  migrationsDir: MIGRATIONS_DIR,
  ...(anchorsPath?.endsWith('.txt')
    ? { checkpointLines: readFileSync(anchorsPath, 'utf8').split('\n').map(l => l.trim()).filter(Boolean) }
    : { anchors: anchorsPath ? JSON.parse(readFileSync(anchorsPath, 'utf8')) : undefined }),
});
process.stdout.write(JSON.stringify(report, null, 2) + '\n');
process.exit(report.ok ? 0 : 1);
