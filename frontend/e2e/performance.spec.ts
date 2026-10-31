import { expect, test } from "@playwright/test";

// Performance measurements run against the existing, disposable fictional clinic.
// Never log request bodies, authentication headers, patient identifiers or query values.
test("measure receptionist journey and prevent duplicate read requests", async ({ page }) => {
  const requests: { method: string; route: string }[] = [];
  page.on("request", (request) => {
    const route = new URL(request.url()).pathname;
    if (route.startsWith("/api/v1/")) {
      requests.push({ method: request.method(), route });
    }
  });
  const count = (route: string) =>
    requests.filter((request) => request.method === "GET" && request.route === route).length;

  await page.goto("/");
  await page.getByLabel("Code du cabinet").fill("web-fictional");
  await page.getByLabel("Identifiant personnel").fill("desk");
  await page.getByLabel("Mot de passe").fill("fictional-pass-123");

  const loginStart = performance.now();
  await page.getByRole("button", { name: "Ouvrir ma session" }).click();
  await expect(page.getByText("Amira Ben Salem", { exact: true })).toBeVisible();
  const loginToAgendaMs = Math.round(performance.now() - loginStart);
  expect(count("/api/v1/day-board")).toBe(1);

  const directoryStart = performance.now();
  await page.getByRole("button", { name: "Patients", exact: true }).click();
  const searchBox = page.getByPlaceholder("Nom, numéro de dossier ou téléphone");
  await expect(searchBox).toBeVisible();
  await expect(page.locator(".patient-row").first()).toBeVisible();
  const directoryMs = Math.round(performance.now() - directoryStart);
  expect(count("/api/v1/patients")).toBe(1);

  const searchBefore = count("/api/v1/patients");
  const searchStart = performance.now();
  await searchBox.fill("Trabelsi");
  const searched = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return (
      url.pathname === "/api/v1/patients" &&
      url.searchParams.get("q") === "Trabelsi" &&
      response.status() === 200
    );
  });
  await page.getByRole("button", { name: "Rechercher", exact: true }).click();
  await searched;
  await expect(page.getByText("Youssef Trabelsi", { exact: true }).first()).toBeVisible();
  const searchMs = Math.round(performance.now() - searchStart);
  expect(count("/api/v1/patients") - searchBefore).toBe(1);

  await page.getByRole("button", { name: "Agenda", exact: true }).click();
  const dayBefore = count("/api/v1/day-board");
  const dayStart = performance.now();
  const changed = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return (
      url.pathname === "/api/v1/day-board" &&
      url.searchParams.get("day") === "2099-01-15" &&
      response.status() === 200
    );
  });
  await page.getByLabel("Date des rendez-vous", { exact: true }).fill("2099-01-15");
  await changed;
  await expect(page.getByText("Une page blanche pour cette journée.")).toBeVisible();
  const dayChangeMs = Math.round(performance.now() - dayStart);
  expect(count("/api/v1/day-board") - dayBefore).toBe(1);

  // Diagnostic timings are recorded, not gated: shared CI runners vary in speed.
  // Keep only API route paths; never attach patient search terms or response bodies.
  const apiResources = await page.evaluate(() =>
    performance
      .getEntriesByType("resource")
      .filter((resource) => new URL(resource.name).pathname.startsWith("/api/v1/"))
      .map((resource) => ({
        route: new URL(resource.name).pathname,
        durationMs: Math.round(resource.duration),
        transferBytes: (resource as PerformanceResourceTiming).transferSize,
      })),
  );
  const report = {
    fictionalDataOnly: true,
    journeyMs: { loginToAgendaMs, directoryMs, searchMs, dayChangeMs },
    requests,
    apiResources,
  };
  await test.info().attach("performance-baseline.json", {
    body: Buffer.from(JSON.stringify(report, null, 2)),
    contentType: "application/json",
  });
  console.log("EZZ_PERFORMANCE_BASELINE " + JSON.stringify(report));
});
