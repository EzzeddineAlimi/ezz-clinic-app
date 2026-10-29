/*
 * Throwaway PostgreSQL 16 cluster for tests that need their OWN server (TLS settings, fresh-instance restores).
 * Uses the server binaries (initdb / pg_ctl); returns null when they are not installed so callers can skip with a
 * reason. initdb refuses to run as root, so as root the commands run as the postgres OS user. Fictional data only.
 */
import { existsSync, mkdtempSync, rmSync, writeFileSync, chmodSync, chownSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import net from 'node:net';

export function pgBin(): string | null {
  for (const d of ['/usr/lib/postgresql/16/bin']) if (existsSync(join(d, 'initdb'))) return d;
  const r = spawnSync('pg_config', ['--bindir'], { encoding: 'utf8' });
  const d = r.status === 0 ? r.stdout.trim() : '';
  return d && existsSync(join(d, 'initdb')) ? d : null;
}

const asRoot = typeof process.getuid === 'function' && process.getuid() === 0;
const pgUid = () => Number(execFileSync('id', ['-u', 'postgres']).toString());
const pgGid = () => Number(execFileSync('id', ['-g', 'postgres']).toString());

export function pgCmd(bin: string, cmd: string, args: string[]) {
  const full = join(bin, cmd);
  return asRoot ? execFileSync('runuser', ['-u', 'postgres', '--', full, ...args], { stdio: 'pipe' }) : execFileSync(full, args, { stdio: 'pipe' });
}

export async function freePort() {
  return new Promise<number>(res => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = (s.address() as net.AddressInfo).port; s.close(() => res(p)); }); });
}

/** Make a file readable by the server process (postgres user when running as root), mode 0600. */
export function giveToServer(path: string) {
  chmodSync(path, 0o600);
  if (asRoot) chownSync(path, pgUid(), pgGid());
}

export interface FreshPg { dir: string; port: number; superPassword: string; url(db?: string, params?: string): string; stop(): void }

/** initdb + start on 127.0.0.1:<free port>. extraConf: postgres -c settings (e.g. TLS). */
export async function startFreshPg(extraConf: Record<string, string> = {}, prepare?: (dir: string) => void): Promise<FreshPg | null> {
  const bin = pgBin();
  if (!bin) return null;
  const dir = mkdtempSync(join(tmpdir(), 'ezz-fresh-pg-'));
  const superPassword = 'fictional-fresh-superuser-pw';
  const pwfile = join(dir, 'pw');
  writeFileSync(pwfile, superPassword + '\n');
  if (asRoot) { chmodSync(dir, 0o700); chownSync(dir, pgUid(), pgGid()); chownSync(pwfile, pgUid(), 0); }
  pgCmd(bin, 'initdb', ['-D', join(dir, 'data'), '-U', 'postgres', '--pwfile', pwfile, '--auth-host=scram-sha-256', '--auth-local=peer', '-E', 'UTF8', '--no-instructions']);
  prepare?.(dir);
  const port = await freePort();
  const conf = Object.entries({ listen_addresses: '127.0.0.1', ...extraConf }).map(([k, v]) => `-c ${k}=${v}`).join(' ');
  pgCmd(bin, 'pg_ctl', ['-D', join(dir, 'data'), '-o', `-p ${port} -k ${dir} ${conf}`, '-w', '-l', join(dir, 'log'), 'start']);
  return {
    dir, port, superPassword,
    url: (db = 'postgres', params = '') => `postgres://postgres:${superPassword}@127.0.0.1:${port}/${db}${params ? '?' + params : ''}`,
    stop() {
      try { pgCmd(bin, 'pg_ctl', ['-D', join(dir, 'data'), '-m', 'immediate', 'stop']); } catch { /* already stopped */ }
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
