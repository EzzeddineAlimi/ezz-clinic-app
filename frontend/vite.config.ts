import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
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
    headers: {
      ...headers,
      "Content-Security-Policy": headers["Content-Security-Policy"].replace(
        "script-src 'self'",
        "script-src 'self' 'unsafe-inline'",
      ),
    },
    proxy: { "/api": { target: "http://127.0.0.1:4180" } },
  },
  preview: { headers, proxy: { "/api": { target: "http://127.0.0.1:4180" } } },
});
