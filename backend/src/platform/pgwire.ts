/*
 * Compatibility shim. The temporary zero-dependency wire client (ADR-0004) was replaced by node-postgres
 * with enforced TLS for remote hosts (issue #4); see postgres.ts. Kept so existing imports, scripts and
 * stacked draft branches keep compiling unchanged. Nothing on this branch imports it any more (ARCH-6 enforces that);
 * delete it once the open draft PRs that still import it have been integrated.
 */
export * from "./postgres.ts";
