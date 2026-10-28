/*
 * Minimal zero-dependency PostgreSQL wire-protocol (v3) client.
 *
 * WHY THIS EXISTS (ADR-0004): the authoring sandbox for the Opus 5.5 sprint had no npm
 * registry access, so the well-maintained `pg` (node-postgres) driver could not be installed.
 * This client is deliberately small and sits behind the `Db`/`Tx` interfaces in db.ts so it
 * can be replaced by `pg` without touching module code (ticket ENG-01).
 *
 * Supported: TCP or Unix socket, auth trust / cleartext / md5 / SCRAM-SHA-256, extended query
 * protocol with text-format parameters (no string interpolation of values), simple query for
 * migrations, basic type parsing. NOT supported: TLS (do not use over a network), COPY,
 * LISTEN/NOTIFY, binary formats, cancellation. FICTIONAL-DATA DEVELOPMENT ONLY.
 */
import net from 'node:net';
import crypto from 'node:crypto';

export type PgValue = string | number | boolean | null | bigint | object | Date | undefined;
export type Row = Record<string, unknown>;
export interface QueryResult<R = Row> { rows: R[]; rowCount: number; command: string }

export class PgError extends Error {
  code: string;
  constraint?: string;
  detail?: string;
  table?: string;
  constructor(fields: Record<string, string>) {
    super(fields.M ?? 'PostgreSQL error');
    this.name = 'PgError';
    this.code = fields.C ?? 'XX000';
    this.constraint = fields.n;
    this.detail = fields.D;
    this.table = fields.t;
  }
}

export interface ConnConfig {
  host: string; // hostname, or a directory containing the Unix socket
  port: number;
  user: string;
  password?: string;
  database: string;
  applicationName?: string;
}

export function parseDatabaseUrl(url: string): ConnConfig {
  const u = new URL(url);
  if (u.protocol !== 'postgres:' && u.protocol !== 'postgresql:') throw new Error('DATABASE_URL must be postgres://');
  const hostParam = u.searchParams.get('host');
  return {
    host: hostParam ?? (u.hostname || 'localhost'),
    port: Number(u.port || 5432),
    user: decodeURIComponent(u.username),
    password: u.password ? decodeURIComponent(u.password) : undefined,
    database: decodeURIComponent(u.pathname.replace(/^\//, '')) || decodeURIComponent(u.username),
    applicationName: u.searchParams.get('application_name') ?? 'ezz-clinic-backend',
  };
}

const OID = { bool: 16, int8: 20, int2: 21, int4: 23, json: 114, jsonb: 3802, timestamp: 1114, timestamptz: 1184, float4: 700, float8: 701 } as const;

function parseValue(oid: number, text: string): unknown {
  switch (oid) {
    case OID.bool: return text === 't';
    case OID.int2: case OID.int4: return Number(text);
    case OID.int8: {
      const n = Number(text);
      if (!Number.isSafeInteger(n)) throw new Error(`int8 value ${text} exceeds JS safe integer range`);
      return n;
    }
    case OID.float4: case OID.float8: return Number(text);
    case OID.json: case OID.jsonb: return JSON.parse(text);
    case OID.timestamptz: case OID.timestamp: {
      let s = text.replace(' ', 'T');
      if (/[+-]\d\d$/.test(s)) s += ':00';
      const d = new Date(s);
      return Number.isNaN(d.getTime()) ? text : d.toISOString();
    }
    default: return text;
  }
}

function serializeParam(v: PgValue): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v === 'boolean') return v ? 't' : 'f';
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) throw new Error('Non-finite number parameter');
    return String(v);
  }
  if (typeof v === 'bigint') return v.toString();
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

class Writer {
  private parts: Buffer[] = [];
  str(s: string) { this.parts.push(Buffer.from(s + '\0', 'utf8')); return this; }
  int32(n: number) { const b = Buffer.alloc(4); b.writeInt32BE(n); this.parts.push(b); return this; }
  int16(n: number) { const b = Buffer.alloc(2); b.writeInt16BE(n); this.parts.push(b); return this; }
  bytes(b: Buffer) { this.parts.push(b); return this; }
  body(): Buffer { return Buffer.concat(this.parts); }
  msg(type: string): Buffer {
    const body = Buffer.concat(this.parts);
    const head = Buffer.alloc(5);
    head.write(type, 0, 'ascii');
    head.writeInt32BE(body.length + 4, 1);
    return Buffer.concat([head, body]);
  }
}

interface Pending {
  resolve: (r: QueryResult[]) => void;
  reject: (e: Error) => void;
  results: QueryResult[];
  fields: { name: string; oid: number }[];
  rows: Row[];
  error?: PgError;
}

export class PgConnection {
  private socket!: net.Socket;
  private buf: Buffer = Buffer.alloc(0);
  private queue: Pending[] = [];
  private chain: Promise<unknown> = Promise.resolve();
  private authResolve?: () => void;
  private authReject?: (e: Error) => void;
  private scram?: { clientNonce: string; clientFirstBare: string; serverSignature?: Buffer };
  dead = false;
  txStatus = 'I';

  private cfg: ConnConfig;
  constructor(cfg: ConnConfig) { this.cfg = cfg; }

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const isSocket = this.cfg.host.startsWith('/');
      this.socket = isSocket
        ? net.createConnection({ path: `${this.cfg.host}/.s.PGSQL.${this.cfg.port}` })
        : net.createConnection({ host: this.cfg.host, port: this.cfg.port });
      this.authResolve = resolve;
      this.authReject = reject;
      this.socket.on('connect', () => {
        const params = new Writer()
          .int32(196608)
          .str('user').str(this.cfg.user)
          .str('database').str(this.cfg.database)
          .str('client_encoding').str('UTF8')
          .str('application_name').str(this.cfg.applicationName ?? 'ezz-clinic-backend')
          .str('');
        const payload = params.body();
        const len = Buffer.alloc(4); len.writeInt32BE(payload.length + 4);
        this.socket.write(Buffer.concat([len, payload]));
      });
      this.socket.on('data', (d: Buffer) => this.onData(d));
      this.socket.on('error', (e) => this.fail(e));
      this.socket.on('close', () => this.fail(new Error('PostgreSQL connection closed')));
    });
  }

  private fail(e: Error) {
    if (this.dead) return;
    this.dead = true;
    this.authReject?.(e);
    this.authReject = undefined;
    for (const p of this.queue.splice(0)) p.reject(e);
  }

  private onData(d: Buffer) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, d]) : d;
    while (this.buf.length >= 5) {
      const type = String.fromCharCode(this.buf[0]!);
      const len = this.buf.readInt32BE(1);
      if (this.buf.length < len + 1) break;
      const body = this.buf.subarray(5, len + 1);
      this.buf = this.buf.subarray(len + 1);
      try { this.handle(type, body); } catch (e) { this.fail(e as Error); this.socket.destroy(); return; }
    }
  }

  private send(b: Buffer) { this.socket.write(b); }

  private handle(type: string, body: Buffer) {
    switch (type) {
      case 'R': return this.handleAuth(body);
      case 'S': case 'K': case 'N': case '1': case '2': case 'n': case 's': case 't': return;
      case 'Z': {
        this.txStatus = String.fromCharCode(body[0]!);
        if (this.authResolve) { const r = this.authResolve; this.authResolve = undefined; this.authReject = undefined; r(); return; }
        const p = this.queue.shift();
        if (!p) return;
        if (p.error) p.reject(p.error); else p.resolve(p.results);
        return;
      }
      case 'E': {
        const fields: Record<string, string> = {};
        let i = 0;
        while (i < body.length && body[i] !== 0) {
          const code = String.fromCharCode(body[i]!);
          const end = body.indexOf(0, i + 1);
          fields[code] = body.toString('utf8', i + 1, end);
          i = end + 1;
        }
        const err = new PgError(fields);
        if (this.authReject) { const r = this.authReject; this.authResolve = undefined; this.authReject = undefined; r(err); return; }
        const p = this.queue[0];
        if (p && !p.error) p.error = err;
        return;
      }
      case 'T': {
        const p = this.queue[0]; if (!p) return;
        const n = body.readInt16BE(0); let off = 2; p.fields = [];
        for (let k = 0; k < n; k++) {
          const end = body.indexOf(0, off);
          const name = body.toString('utf8', off, end); off = end + 1;
          off += 4 + 2; const oid = body.readInt32BE(off); off += 4 + 2 + 4 + 2;
          p.fields.push({ name, oid });
        }
        p.rows = [];
        return;
      }
      case 'D': {
        const p = this.queue[0]; if (!p) return;
        const n = body.readInt16BE(0); let off = 2; const row: Row = {};
        for (let k = 0; k < n; k++) {
          const l = body.readInt32BE(off); off += 4;
          const f = p.fields[k]!;
          if (l === -1) { row[f.name] = null; continue; }
          row[f.name] = parseValue(f.oid, body.toString('utf8', off, off + l)); off += l;
        }
        p.rows.push(row);
        return;
      }
      case 'C': {
        const p = this.queue[0]; if (!p) return;
        const tag = body.toString('utf8', 0, body.length - 1);
        const parts = tag.split(' ');
        const count = Number(parts[parts.length - 1]);
        p.results.push({ rows: p.rows, rowCount: Number.isFinite(count) ? count : p.rows.length, command: parts[0] ?? '' });
        p.rows = []; p.fields = [];
        return;
      }
      case 'I': { const p = this.queue[0]; if (p) p.results.push({ rows: [], rowCount: 0, command: '' }); return; }
      default: return;
    }
  }

  private handleAuth(body: Buffer) {
    const code = body.readInt32BE(0);
    if (code === 0) return;
    const pw = this.cfg.password ?? '';
    if (code === 3) { this.send(new Writer().str(pw).msg('p')); return; }
    if (code === 5) {
      const salt = body.subarray(4, 8);
      const inner = crypto.createHash('md5').update(pw + this.cfg.user).digest('hex');
      const outer = crypto.createHash('md5').update(Buffer.concat([Buffer.from(inner), salt])).digest('hex');
      this.send(new Writer().str('md5' + outer).msg('p'));
      return;
    }
    if (code === 10) {
      const mechs = body.toString('utf8', 4).split('\0');
      if (!mechs.includes('SCRAM-SHA-256')) throw new Error('Server offers no supported SASL mechanism');
      const clientNonce = crypto.randomBytes(18).toString('base64');
      const clientFirstBare = `n=*,r=${clientNonce}`;
      this.scram = { clientNonce, clientFirstBare };
      const data = Buffer.from('n,,' + clientFirstBare, 'utf8');
      this.send(new Writer().str('SCRAM-SHA-256').int32(data.length).bytes(data).msg('p'));
      return;
    }
    if (code === 11) {
      const s = this.scram; if (!s) throw new Error('SCRAM state missing');
      const serverFirst = body.toString('utf8', 4);
      const attrs = Object.fromEntries(serverFirst.split(',').map(kv => [kv[0], kv.slice(2)]));
      const nonce = attrs.r!, salt = Buffer.from(attrs.s!, 'base64'), iter = Number(attrs.i);
      if (!nonce.startsWith(s.clientNonce)) throw new Error('SCRAM nonce mismatch');
      const salted = crypto.pbkdf2Sync(pw.normalize('NFKC'), salt, iter, 32, 'sha256');
      const hmac = (k: Buffer, m: string) => crypto.createHmac('sha256', k).update(m).digest();
      const clientKey = hmac(salted, 'Client Key');
      const storedKey = crypto.createHash('sha256').update(clientKey).digest();
      const finalNoProof = `c=biws,r=${nonce}`;
      const authMessage = `${s.clientFirstBare},${serverFirst},${finalNoProof}`;
      const sig = hmac(storedKey, authMessage);
      const proof = Buffer.alloc(clientKey.length);
      for (let i = 0; i < clientKey.length; i++) proof[i] = clientKey[i]! ^ sig[i]!;
      s.serverSignature = hmac(hmac(salted, 'Server Key'), authMessage);
      this.send(new Writer().bytes(Buffer.from(`${finalNoProof},p=${proof.toString('base64')}`, 'utf8')).msg('p'));
      return;
    }
    if (code === 12) {
      const v = body.toString('utf8', 4).split(',').find(x => x.startsWith('v='))?.slice(2);
      if (!v || !this.scram?.serverSignature || !crypto.timingSafeEqual(Buffer.from(v, 'base64'), this.scram.serverSignature)) {
        throw new Error('SCRAM server signature invalid');
      }
      return;
    }
    throw new Error(`Unsupported PostgreSQL auth method ${code}`);
  }

  private enqueue(build: () => Buffer): Promise<QueryResult[]> {
    const run = () => new Promise<QueryResult[]>((resolve, reject) => {
      if (this.dead) { reject(new Error('PostgreSQL connection is closed')); return; }
      this.queue.push({ resolve, reject, results: [], fields: [], rows: [] });
      this.send(build());
    });
    const p = this.chain.then(run, run);
    this.chain = p.catch(() => undefined);
    return p;
  }

  /** Parameterised query (extended protocol). Values are never interpolated into SQL text. */
  async query<R = Row>(sql: string, params: PgValue[] = []): Promise<QueryResult<R>> {
    const results = await this.enqueue(() => {
      const bind = new Writer().str('').str('').int16(0).int16(params.length);
      for (const v of params) {
        const s = serializeParam(v);
        if (s === null) bind.int32(-1);
        else { const b = Buffer.from(s, 'utf8'); bind.int32(b.length).bytes(b); }
      }
      bind.int16(0);
      return Buffer.concat([
        new Writer().str('').str(sql).int16(0).msg('P'),
        bind.msg('B'),
        new Writer().bytes(Buffer.from('P')).str('').msg('D'),
        new Writer().str('').int32(0).msg('E'),
        new Writer().msg('S'),
      ]);
    });
    const last = results[results.length - 1] ?? { rows: [], rowCount: 0, command: '' };
    return last as QueryResult<R>;
  }

  /** Simple query protocol: multiple statements, no parameters. Use ONLY for trusted migration files. */
  async exec(sql: string): Promise<QueryResult[]> {
    return this.enqueue(() => new Writer().str(sql).msg('Q'));
  }

  end() {
    if (this.dead) return;
    try { this.socket.write(new Writer().msg('X')); } catch { /* ignore */ }
    this.dead = true;
    this.socket.end();
  }
}

/** Small connection pool. */
export class PgPool {
  private idle: PgConnection[] = [];
  private total = 0;
  private waiters: ((c: PgConnection) => void)[] = [];
  private closed = false;
  private cfg: ConnConfig;
  private max: number;
  constructor(cfg: ConnConfig, max = 8) { this.cfg = cfg; this.max = max; }

  async acquire(): Promise<PgConnection> {
    if (this.closed) throw new Error('Pool closed');
    while (this.idle.length) {
      const c = this.idle.pop()!;
      if (!c.dead) return c;
      this.total--;
    }
    if (this.total < this.max) {
      this.total++;
      const c = new PgConnection(this.cfg);
      try { await c.connect(); } catch (e) { this.total--; throw e; }
      return c;
    }
    return new Promise(res => this.waiters.push(res));
  }

  release(c: PgConnection, destroy = false) {
    if (destroy || c.dead || c.txStatus !== 'I' || this.closed) {
      c.end(); this.total--;
      if (this.waiters.length && !this.closed) {
        const w = this.waiters.shift()!;
        this.acquire().then(w, () => this.waiters.unshift(w));
      }
      return;
    }
    const w = this.waiters.shift();
    if (w) w(c); else this.idle.push(c);
  }

  async end() {
    this.closed = true;
    for (const c of this.idle.splice(0)) c.end();
  }
}
