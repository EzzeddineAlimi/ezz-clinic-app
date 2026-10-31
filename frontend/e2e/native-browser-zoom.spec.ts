import { execFileSync } from "node:child_process";
import { expect, test } from "@playwright/test";

// Dedicated headed-Xvfb CI step: never present CSS zoom or emulated DPR as native browser zoom.
test("Dentist alerts and dialog controls remain readable at native Chromium 200% zoom in FR/AR", async ({ page, request }) => {
  test.skip(process.env.EZZ_NATIVE_ZOOM !== "1", "Dedicated headed Xvfb native-browser-zoom job");

  const auth = async (username: string): Promise<string> => {
    const response = await request.post("/api/v1/session/login", {
      data: { clinicCode: "web-fictional", username, password: "fictional-pass-123" },
    });
    expect(response.status()).toBe(200);
    return (await response.json()).token as string;
  };
  const desk = await auth("desk");
  const dentist = await auth("dentist");
  const boardResponse = await request.get("/api/v1/day-board", {
    headers: { Authorization: "Bearer " + desk },
  });
  expect(boardResponse.status()).toBe(200);
  const board = await boardResponse.json() as {
    visits: Array<{ status: string; patient: { id: string; familyName: string } }>;
  };
  const arrived = board.visits.find(visit => visit.status === "ARRIVED");
  expect(arrived, "Fictional seed must include an arrived visit").toBeDefined();
  const alert = await request.post("/api/v1/patients/" + arrived!.patient.id + "/medical-alerts", {
    headers: { Authorization: "Bearer " + dentist, "Idempotency-Key": crypto.randomUUID() },
    data: { code: "ALLERGY_LATEX", severity: "CRITICAL", detail: "Allergie au latex fictive" },
  });
  expect(alert.status()).toBe(201);

  await page.setViewportSize({ width: 640, height: 900 });
  await page.goto("/");
  await page.getByLabel("Code du cabinet").fill("web-fictional");
  await page.getByLabel("Identifiant personnel").fill("dentist");
  await page.getByLabel("Mot de passe").fill("fictional-pass-123");
  await page.getByRole("button", { name: "Ouvrir ma session" }).click();
  await expect(page.getByRole("heading", { name: "Le fil de la journée" })).toBeVisible();

  await page.bringToFront();
  const before = await page.evaluate(() => ({ dpr: devicePixelRatio, width: innerWidth }));
  expect(before.dpr, "Xvfb/Chromium baseline devicePixelRatio must be 1").toBe(1);
  expect(before.width).toBe(640);
  for (let i = 0; i < 5; i++) {
    execFileSync("python3", ["scripts/native-browser-zoom.py"], { stdio: "pipe" });
    await page.waitForTimeout(120);
  }
  const zoom = await page.evaluate(() => ({
    dpr: devicePixelRatio, width: innerWidth, cssZoom: document.body.style.zoom,
    viewportScale: visualViewport?.scale,
  }));
  expect(zoom.dpr, "Actual browser zoom must reach 200%, not CSS scale").toBe(2);
  expect(zoom.width, "640 physical px / 200% native zoom must equal 320 CSS px").toBe(320);
  expect(zoom.cssZoom).toBe("");
  expect(zoom.viewportScale).toBe(1);

  const row = page.locator(".visit-row").filter({ hasText: arrived!.patient.familyName });
  await row.getByRole("button", { name: "Dossier clinique" }).click();
  const dialog = page.getByRole("dialog");
  const identity = dialog.locator(".clinical-workspace > .patient-context");
  const critical = dialog.getByTestId("clinical-alert-details").locator("li").first();
  await expect(critical).toContainText("ALLERGY_LATEX");
  await critical.evaluate(element => element.scrollIntoView({ block: "center" }));
  await expect(identity).toBeInViewport({ ratio: 1 });
  await expect(critical).toBeInViewport({ ratio: 0.9 });
  await expect(dialog.locator(".modal-head h2")).toBeInViewport({ ratio: 1 });
  await expect(dialog.locator(".modal-head .icon-button")).toBeInViewport({ ratio: 1 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await test.info().attach("dentist-fr-native-browser-200pct", {
    body: await page.screenshot({ path: "test-results/dentist-fr-native-browser-200pct.png", animations: "disabled" }),
    contentType: "image/png",
  });
  // Investigate blank full-viewport capture at native zoom: capture the actual dialog top-layer separately.
  await test.info().attach("dentist-fr-native-browser-200pct-dialog", {
    body: await dialog.screenshot({ path: "test-results/dentist-fr-native-browser-200pct-dialog.png", animations: "disabled" }),
    contentType: "image/png",
  });

  await dialog.getByRole("button", { name: "Fermer le formulaire" }).click();
  await page.getByRole("button", { name: "العربية", exact: true }).click();
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
  await row.getByRole("button", { name: "الملف السريري" }).click();
  const arabicDialog = page.getByRole("dialog");
  const arabicCritical = arabicDialog.getByTestId("clinical-alert-details").locator("li").first();
  await expect(arabicCritical).toContainText("ALLERGY_LATEX");
  await arabicCritical.evaluate(element => element.scrollIntoView({ block: "center" }));
  await expect(arabicDialog.locator(".clinical-workspace > .patient-context")).toBeInViewport({ ratio: 1 });
  await expect(arabicCritical).toBeInViewport({ ratio: 0.9 });
  await expect(arabicDialog.locator(".modal-head h2")).toBeInViewport({ ratio: 1 });
  await expect(arabicDialog.locator(".modal-head .icon-button")).toBeInViewport({ ratio: 1 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await test.info().attach("dentist-ar-native-browser-200pct", {
    body: await page.screenshot({ path: "test-results/dentist-ar-native-browser-200pct.png", animations: "disabled" }),
    contentType: "image/png",
  });
  await test.info().attach("dentist-ar-native-browser-200pct-dialog", {
    body: await arabicDialog.screenshot({ path: "test-results/dentist-ar-native-browser-200pct-dialog.png", animations: "disabled" }),
    contentType: "image/png",
  });
});
