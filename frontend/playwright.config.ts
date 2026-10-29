import { defineConfig } from "@playwright/test";
import { existsSync } from "node:fs";
export default defineConfig({
  testDir: "./e2e",
  workers: 1,
  timeout: 30000,
  use: {
    baseURL: "http://127.0.0.1:5173",
    viewport: { width: 1440, height: 1000 },
    launchOptions: {
      ...(existsSync("/usr/bin/chromium")
        ? { executablePath: "/usr/bin/chromium" }
        : {}),
      args: ["--no-sandbox"],
    },
    trace: "off",
  },
  reporter: [
    ["list"],
    ["json", { outputFile: "../docs/testing/sprint2/browser-results.json" }],
  ],
  webServer: [
    {
      command: "node ../backend/scripts/dev-web.ts",
      url: "http://127.0.0.1:4180/api/v1/health/ready",
      timeout: 60000,
      reuseExistingServer: false,
      env: {
        EZZ_TEST_ADMIN_URL:
          process.env.EZZ_TEST_ADMIN_URL ??
          "postgres://postgres:fictional-dev-superuser-pw@127.0.0.1:54316/postgres",
      },
    },
    {
      command: "npm run build && npm run preview",
      url: "http://127.0.0.1:5173",
      timeout: 60000,
      reuseExistingServer: false,
    },
  ],
});
