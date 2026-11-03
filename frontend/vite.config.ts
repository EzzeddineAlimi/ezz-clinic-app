import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
// Host allowlist is limited to this exact private Codespace, never a wildcard.
const codespaceName =
  process.env.CODESPACES === "true" ? process.env.CODESPACE_NAME : undefined;
if (process.env.CODESPACES === "true" && (!codespaceName || !/^[a-z0-9-]+$/.test(codespaceName))) {
  throw new Error("Codespaces preview requires a valid CODESPACE_NAME");
}
const allowedHosts = codespaceName ? [`${codespaceName}-5173.app.github.dev`] : [];
const apiProxy = { target: "http://127.0.0.1:4180", changeOrigin: true };
const headers = {
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Content-Security-Policy":
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' ws://127.0.0.1:5173; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
};
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: true,
    allowedHosts,
    headers: {
      ...headers,
      "Content-Security-Policy": headers["Content-Security-Policy"].replace(
        "script-src 'self'",
        "script-src 'self' 'unsafe-inline'",
      ),
    },
    proxy: { "/api": apiProxy },
  },
  preview: {
    port: 5173,
    strictPort: true,
    allowedHosts,
    headers,
    proxy: { "/api": apiProxy },
  },
});
