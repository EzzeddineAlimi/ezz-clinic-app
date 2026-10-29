/*
 * Composition root. Each module contributes routes; slices are added one line at a time so each
 * pull request stays small and reviewable. Allowed module dependencies are enforced by
 * test/architecture.test.ts (see docs/architecture/module-map.md).
 */
import type http from 'node:http';
import { Db } from './platform/db.ts';
import { readiness } from './platform/readiness.ts';
import { createServer, type Route } from './platform/http.ts';
import { securityHooks, identityRoutes, login } from './modules/identity.ts';
import { auditRoutes } from './modules/audit.ts';
import { patientRoutes } from './modules/patients.ts';
import { workbenchRoutes } from './modules/workbench.ts';
import { careRoutes } from './modules/care.ts';
import { medicalRoutes } from './modules/medical.ts';
import { clinicalRoutes } from './modules/clinical.ts';
import { billingRoutes } from './modules/billing.ts';
import { integrityRoutes } from './modules/integrity.ts';
import { cashRoutes } from './modules/cash.ts';
import { cardRoutes } from './modules/card.ts';
import { paperRoutes } from './modules/paper.ts';
import { exceptionRoutes } from './modules/exceptions.ts';
import { reviewRoutes } from './modules/review.ts';
import { dayBoardRoutes } from './modules/dayboard.ts';
import { printRoutes } from './modules/print.ts';
import { checkpointRoutes } from './modules/checkpoints.ts';
import { settingsRoutes } from './modules/settings.ts';
import { documentRoutes, type DocumentDeps } from './modules/documents.ts';
import { labRoutes } from './modules/lab.ts';
import { stockRoutes } from './modules/stock.ts';
import { PgBlobStore } from './platform/blobstore.ts';
import { structuralScreener } from './platform/fileinspect.ts';

export interface AppOptions {
  databaseUrl: string;
  allowedOrigins?: string[];
  extraAllowedHosts?: string[];
  log?: (line: Record<string, unknown>) => void;
  /** Patient-document storage and screening; defaults are the PostgreSQL foundation and the format-only screener. */
  documents?: Partial<DocumentDeps>;
}

export function buildRoutes(db: Db, documents: Partial<DocumentDeps> = {}): Route[] {
  const loginRoute: Route = { method: 'POST', path: '/api/v1/session/login', handler: async ({ body }) => login(db, body) };
  const health: Route = { method: 'GET', path: '/api/v1/health', handler: async ({ tx }) => {
    await tx.query('SELECT 1');
    return { status: 200, body: { status: 'ok', build: 'v0.2-fictional', fictionalDataOnly: true } };
  } };
  const ready: Route = { method: 'GET', path: '/api/v1/health/ready', handler: async () => {
    const r = await readiness(db);
    return { status: r.ready ? 200 : 503, body: { status: r.ready ? 'ready' : 'not_ready', checks: r.checks } };
  } };
  return [
    health,
    ready,
    loginRoute,
    ...identityRoutes,
    ...auditRoutes,
    ...checkpointRoutes,
    ...settingsRoutes,
    ...patientRoutes,
    ...documentRoutes({ store: documents.store ?? new PgBlobStore(), screener: documents.screener ?? structuralScreener }),
    ...workbenchRoutes,
    ...dayBoardRoutes,
    ...careRoutes,
    ...medicalRoutes,
    ...clinicalRoutes,
    ...billingRoutes,
    ...printRoutes,
    ...integrityRoutes,
    ...cashRoutes,
    ...cardRoutes,
    ...paperRoutes,
    ...exceptionRoutes,
    ...reviewRoutes,
    ...labRoutes,
    ...stockRoutes,
  ];
}

export function createApp(opts: AppOptions): { server: http.Server; db: Db } {
  const db = new Db(opts.databaseUrl, { log: opts.log });
  const server = createServer(db, buildRoutes(db, opts.documents), securityHooks(), {
    allowedOrigins: opts.allowedOrigins ?? [],
    extraAllowedHosts: opts.extraAllowedHosts ?? [],
    log: opts.log ?? (line => process.stdout.write(JSON.stringify(line) + '\n')),
  });
  server.on('close', () => { void db.close(); });
  return { server, db };
}
