/*
 * Compatibility shim. The temporary zero-dependency wire client (ADR-0004) was replaced by node-postgres
 * with enforced TLS for remote hosts (issue #4); see postgres.ts. Kept so existing imports, scripts and
 * stacked draft branches keep compiling unchanged. New code should import from './postgres.ts'.
 */
export * from './postgres.ts';
