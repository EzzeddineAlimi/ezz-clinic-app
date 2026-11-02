/*
 * Filesystem locations that must resolve the same way whether the code runs from TypeScript sources
 * (node --test test/*.ts) or from the compiled build (dist/…, npm run test:dist). Paths built relative to
 * import.meta.url broke the compiled run (dist/migrations, dist/src/server.ts do not exist): resolve from the
 * backend root instead, found by walking up to the directory that holds package.json AND migrations/.
 */
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

function findBackendRoot(): string {
	let d = dirname(fileURLToPath(import.meta.url));
	for (let i = 0; i < 8; i++) {
		if (
			existsSync(join(d, "package.json")) &&
			existsSync(join(d, "migrations"))
		)
			return d;
		const up = dirname(d);
		if (up === d) break;
		d = up;
	}
	throw new Error(
		"backend root (package.json + migrations/) not found above " +
			fileURLToPath(import.meta.url),
	);
}

export const BACKEND_ROOT = findBackendRoot();
/** True when running from the compiled build (dist/…/*.js). */
export const RUNNING_COMPILED = import.meta.url.endsWith(".js");
export const MIGRATIONS_DIR = join(BACKEND_ROOT, "migrations");
/** TypeScript sources (architecture tests read these in both modes). */
export const SOURCE_DIR = join(BACKEND_ROOT, "src");
export const SCRIPTS_DIR = join(BACKEND_ROOT, "scripts");
export const REPO_DOCS_DIR = join(BACKEND_ROOT, "..", "docs");
/** The server entry for the current mode: src/server.ts from sources, dist/src/server.js from the build. */
export const SERVER_ENTRY = RUNNING_COMPILED
	? join(BACKEND_ROOT, "dist", "src", "server.js")
	: join(SOURCE_DIR, "server.ts");
