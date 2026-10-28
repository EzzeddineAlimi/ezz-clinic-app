/*
 * Process entry point. Configuration comes only from environment variables (12-factor);
 * see .env.example. Never commit real credentials. Binds to loopback by default.
 */
import { createApp } from './app.ts';

function required(name: string): string {
  const v = process.env[name];
  if (!v) { process.stderr.write(`Missing required environment variable ${name}\n`); process.exit(2); }
  return v;
}

const databaseUrl = required('DATABASE_URL');
const port = Number(process.env.PORT ?? 4180);
const host = process.env.BIND_HOST ?? '127.0.0.1';
const quiet = process.env.LOG_LEVEL === 'silent';

const { server } = createApp({
  databaseUrl,
  allowedOrigins: (process.env.ALLOWED_ORIGINS ?? '').split(',').map(s => s.trim()).filter(Boolean),
  extraAllowedHosts: (process.env.ALLOWED_HOSTS ?? '').split(',').map(s => s.trim()).filter(Boolean),
  log: quiet ? () => {} : line => process.stdout.write(JSON.stringify(line) + '\n'),
});

server.listen(port, host, () => {
  const addr = server.address();
  const p = typeof addr === 'object' && addr ? addr.port : port;
  process.stdout.write(JSON.stringify({ level: 'info', msg: 'EZZ Clinic v0.2 FICTIONAL DATA ONLY', listening: `http://${host}:${p}` }) + '\n');
});

for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, () => server.close(() => process.exit(0)));
