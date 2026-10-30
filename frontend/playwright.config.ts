import { defineConfig } from "@playwright/test";
import { existsSync } from "node:fs";

// Capture the clinic day before starting either the API fixture or browser tests.
const fixtureDay = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Africa/Tunis", year: "numeric", month: "2-digit", day: "2-digit",
}).format(new Date());
process.env.EZZ_E2E_FIXTURE_DAY = fixtureDay;

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
    ["json", { outputFile: "../docs/testing/sprint3b/browser-results.json" }],
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
        EZZ_E2E_FIXTURE_DAY: fixtureDay,
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
