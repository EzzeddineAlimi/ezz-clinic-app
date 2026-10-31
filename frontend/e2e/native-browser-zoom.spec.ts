import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import type { Locator } from "@playwright/test";

// Independent OS-compositor capture: CDP page and element screenshots were flat background.
function captureDesktop(path: string): Buffer {
  if (!process.env.DISPLAY) throw new Error("Native zoom desktop capture requires DISPLAY");
  execFileSync("ffmpeg", [
    "-y", "-loglevel", "error", "-f", "x11grab",
    "-video_size", "1280x1024", "-i", process.env.DISPLAY + "+0,0",
    "-frames:v", "1", path,
  ]);
  // Fail if the central UI is flat; CDP screenshots previously passed while blank.
  const pixels = execFileSync("ffmpeg", [
    "-loglevel", "error", "-i", path, "-vf", "crop=380:450:120:380,format=gray",
    "-f", "rawvideo", "pipe:1",
  ]);
  let darkest = 255, lightest = 0;
  for (const pixel of pixels) {
    darkest = Math.min(darkest, pixel);
    lightest = Math.max(lightest, pixel);
  }
  if (lightest - darkest < 30) throw new Error("Native zoom UI screenshot is blank");
  return readFileSync(path);
}
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
  const missingDetailAlert = await request.post("/api/v1/patients/" + arrived!.patient.id + "/medical-alerts", {
    headers: { Authorization: "Bearer " + dentist, "Idempotency-Key": crypto.randomUUID() },
    data: { code: "ANTICOAGULANT_DOAC", severity: "CAUTION", detail: null },
  });
  expect(missingDetailAlert.status()).toBe(201);

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
  const frPatientBox = await identity.boundingBox();
  const frScrollBox = await dialog.locator(".clinical-workspace > .clinical-content").boundingBox();
  expect(frPatientBox).not.toBeNull();
  expect(frScrollBox).not.toBeNull();
  expect(frScrollBox!.y).toBeGreaterThanOrEqual(frPatientBox!.y + frPatientBox!.height);
  await expect(critical).toBeInViewport({ ratio: 0.9 });
  await expect(dialog.locator(".modal-head h2")).toBeInViewport({ ratio: 1 });
  await expect(dialog.locator(".modal-head .icon-button")).toBeInViewport({ ratio: 1 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await test.info().attach("dentist-fr-native-200pct-X11-desktop", {
    body: captureDesktop("test-results/dentist-fr-native-200pct-X11-desktop.png"),
    contentType: "image/png",
  });

  const frMissingDetail = dialog.getByTestId("clinical-alert-missing-detail");
  await frMissingDetail.scrollIntoViewIfNeeded();
  await expect(frMissingDetail).toBeInViewport({ ratio: 1 });
  await expect(frMissingDetail).toHaveText("Détail non renseigné");
  await expect(identity).toBeInViewport({ ratio: 1 });
  await expect(dialog.locator(".modal-head .icon-button")).toBeInViewport({ ratio: 1 });
  await test.info().attach("dentist-fr-native-200pct-missing-detail-X11", {
    body: captureDesktop("test-results/dentist-fr-native-200pct-missing-detail-X11.png"),
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
  const arIdentity = arabicDialog.locator(".clinical-workspace > .patient-context");
  await expect(arIdentity).toBeInViewport({ ratio: 1 });
  const arPatientBox = await arIdentity.boundingBox();
  const arScrollBox = await arabicDialog.locator(".clinical-workspace > .clinical-content").boundingBox();
  expect(arPatientBox).not.toBeNull();
  expect(arScrollBox).not.toBeNull();
  expect(arScrollBox!.y).toBeGreaterThanOrEqual(arPatientBox!.y + arPatientBox!.height);
  await expect(arabicCritical).toBeInViewport({ ratio: 0.9 });
  await expect(arabicDialog.locator(".modal-head h2")).toBeInViewport({ ratio: 1 });
  await expect(arabicDialog.locator(".modal-head .icon-button")).toBeInViewport({ ratio: 1 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await test.info().attach("dentist-ar-native-200pct-X11-desktop", {
    body: captureDesktop("test-results/dentist-ar-native-200pct-X11-desktop.png"),
    contentType: "image/png",
  });
  const arMissingDetail = arabicDialog.getByTestId("clinical-alert-missing-detail");
  await arMissingDetail.scrollIntoViewIfNeeded();
  await expect(arMissingDetail).toBeInViewport({ ratio: 1 });
  await expect(arMissingDetail).toHaveText("التفاصيل غير مسجّلة");
  await expect(arIdentity).toBeInViewport({ ratio: 1 });
  await expect(arabicDialog.locator(".modal-head .icon-button")).toBeInViewport({ ratio: 1 });
  await test.info().attach("dentist-ar-native-200pct-missing-detail-X11", {
    body: captureDesktop("test-results/dentist-ar-native-200pct-missing-detail-X11.png"),
    contentType: "image/png",
  });

  // C-37: exercise real native zoom outside D02; CSS-zoom screenshots are not evidence.
  const signInAtNativeZoom = async (username: "desk" | "owner") => {
    await page.goto("/");
    await page.getByLabel("Code du cabinet").fill("web-fictional");
    await page.getByLabel("Identifiant personnel").fill(username);
    await page.getByLabel("Mot de passe").fill("fictional-pass-123");
    await page.getByRole("button", { name: "Ouvrir ma session" }).click();
    await expect(page.getByRole("heading", { name: "Le fil de la journée" })).toBeVisible();
    expect(await page.evaluate(() => ({ dpr: devicePixelRatio, width: innerWidth }))).toEqual({ dpr: 2, width: 320 });
    const layout = await page.evaluate(() => ({
      viewport: innerWidth,
      scrollWidth: document.documentElement.scrollWidth,
      offenders: [...document.querySelectorAll<HTMLElement>("body *")].map(element => {
        const rect = element.getBoundingClientRect();
        return { tag: element.tagName, className: String(element.className).slice(0, 80),
          left: Math.round(rect.left), right: Math.round(rect.right), width: Math.round(rect.width) };
      }).filter(item => item.right > innerWidth + 1 || item.left < -1).slice(0, 16),
    }));
    console.log("C37_NATIVE_200_LAYOUT", username, JSON.stringify(layout));
    expect(layout.scrollWidth).toBeLessThanOrEqual(layout.viewport);
  };
  const reachByKeyboardTab = async (target: Locator) => {
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    for (let step = 0; step < 60; step++) {
      await page.keyboard.press("Tab");
      if (await target.evaluate(element => element === document.activeElement)) return;
    }
    throw new Error("Navigation target not reachable by Tab at native 200% zoom");
  };

  await signInAtNativeZoom("desk");
  await expect(page.locator(".visit-row").first()).toBeVisible();
  await test.info().attach("reception-fr-native-200pct-X11-desktop", {
    body: captureDesktop("test-results/reception-fr-native-200pct-X11-desktop.png"),
    contentType: "image/png",
  });
  const patientsNav = page.getByRole("button", { name: "Patients", exact: true });
  await reachByKeyboardTab(patientsNav);
  await page.keyboard.press("Enter");
  await expect(page.getByPlaceholder("Nom, numéro de dossier ou téléphone")).toBeVisible();
  await page.keyboard.press("Shift+Tab");
  const agendaNav = page.getByRole("button", { name: "Agenda", exact: true });
  await expect(agendaNav).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.locator(".visit-row").first()).toBeVisible();
  await page.getByRole("button", { name: "العربية", exact: true }).click();
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
  await test.info().attach("reception-ar-native-200pct-X11-desktop", {
    body: captureDesktop("test-results/reception-ar-native-200pct-X11-desktop.png"),
    contentType: "image/png",
  });

  await signInAtNativeZoom("owner");
  const cashNav = page.getByRole("button", { name: "Caisse", exact: true });
  await reachByKeyboardTab(cashNav);
  await page.keyboard.press("Enter");
  const cash = page.locator(".owner-cash");
  await expect(cash).toBeVisible();
  await expect(page.getByRole("heading", { name: "Contrôle de caisse", level: 1 })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await test.info().attach("owner-fr-native-200pct-X11-desktop", {
    body: captureDesktop("test-results/owner-fr-native-200pct-X11-desktop.png"),
    contentType: "image/png",
  });
  await page.getByRole("button", { name: "العربية", exact: true }).click();
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
  await expect(cash).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await test.info().attach("owner-ar-native-200pct-X11-desktop", {
    body: captureDesktop("test-results/owner-ar-native-200pct-X11-desktop.png"),
    contentType: "image/png",
  });
});
