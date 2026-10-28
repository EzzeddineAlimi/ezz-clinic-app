/* Encrypted backup of one database (B14). FICTIONAL DATA ONLY.
 * Usage: EZZ_ADMIN_URL=postgres://... EZZ_BACKUP_PASSPHRASE='...' node scripts/backup.ts <database> <out-dir>
 * Writes <name>.dump.enc (AES-256-GCM, owner passphrase) and <name>.manifest.json (no patient data). */
import { createBackup } from '../src/ops/disaster-recovery.ts';

const [database, outDir] = process.argv.slice(2);
const adminUrl = process.env.EZZ_ADMIN_URL, passphrase = process.env.EZZ_BACKUP_PASSPHRASE;
if (!database || !outDir || !adminUrl || !passphrase) {
  process.stderr.write('usage: EZZ_ADMIN_URL=... EZZ_BACKUP_PASSPHRASE=... node scripts/backup.ts <database> <out-dir>\n');
  process.exit(2);
}
const r = await createBackup({ adminUrl, database, outDir, passphrase });
process.stdout.write(JSON.stringify({ encrypted: r.encryptedPath, manifest: r.manifestPath, dumpMs: r.dumpMs, dumpBytes: r.manifest.dumpBytes, clinics: Object.keys(r.manifest.clinics).length }, null, 2) + '\n');
