import { expect, test } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";

test("U029 appointment slip is bilingual and contains minimum patient data", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await page.getByLabel("Code du cabinet").fill("web-fictional");
  await page.getByLabel("Identifiant personnel").fill("desk");
  await page.getByLabel("Mot de passe").fill("fictional-pass-123");
  await page.getByRole("button", { name: "Ouvrir ma session" }).click();
  await expect(page.getByRole("heading", { name: "Le fil de la journée" })).toBeVisible();
  const row = page.locator(".visit-row").filter({ hasText: "Trabelsi" });
  await row.getByRole("button", { name: "Préparer la carte" }).click();
  const card = page.locator("#appointment-slip-print");
  await expect(card).toContainText("09:15");
  await expect(card).toContainText("Heure de Tunis");
  await expect(card).not.toContainText("Africa/Tunis");
  await expect(card).not.toContainText("Trabelsi");
  await test.info().attach("u029-fr-mobile", { body: await page.screenshot(), contentType: "image/png" });
  await page.emulateMedia({ media: "print" });
  await expect(card).toHaveCSS("visibility", "visible");
  await page.emulateMedia({ media: "screen" });
  await page.getByRole("button", { name: "Fermer le formulaire" }).click();
  await page.getByRole("button", { name: "العربية" }).click();
  await row.getByRole("button", { name: "تحضير بطاقة الموعد" }).click();
  const arabicCard = page.locator("#appointment-slip-print");
  await expect(arabicCard).toHaveAttribute("lang", "ar");
  await expect(arabicCard).toHaveAttribute("dir", "rtl");
  await expect(arabicCard).toContainText("09:15");
  await expect(arabicCard).toContainText("توقيت تونس");
  await expect(arabicCard).not.toContainText("Africa/Tunis");
  await expect(arabicCard).not.toContainText("Trabelsi");
  await test.info().attach("u029-ar-mobile", { body: await page.screenshot(), contentType: "image/png" });
});


test("U029 rejects cancellation after card preview before opening print", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await page.getByLabel("Code du cabinet").fill("web-fictional");
  await page.getByLabel("Identifiant personnel").fill("desk");
  await page.getByLabel("Mot de passe").fill("fictional-pass-123");
  await page.getByRole("button", { name: "Ouvrir ma session" }).click();
  const row = page.locator(".visit-row").filter({ hasText: "Trabelsi" });
  await row.getByRole("button", { name: "Préparer la carte" }).click();
  await expect(page.locator("#appointment-slip-print")).toBeVisible();
  await page.evaluate(() => {
    window.print = () => { document.documentElement.dataset.printed = "yes"; };
  });
  await page.route("**/api/v1/day-board*", async route => {
    const response = await route.fetch();
    const board = await response.json();
    await route.fulfill({ response, json: {
      ...board,
      visits: board.visits.map((visit: { patient: { familyName: string } }) =>
        visit.patient.familyName === "Trabelsi" ? { ...visit, status: "CANCELLED" } : visit),
    } });
  });
  await page.getByRole("button", { name: "Imprimer la carte" }).click();
  await expect(page.locator("#appointment-slip-print")).toHaveCount(0);
  await expect(page.locator(".toast-error")).toContainText("La carte n’a pas été imprimée");
  await expect(row.locator(".status-badge")).toContainText("Annulé");
  await expect(page.locator("html")).not.toHaveAttribute("data-printed", "yes");
});


test("U029 Arabic reschedule after preview refreshes board and never prints stale time", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await page.getByLabel("Code du cabinet").fill("web-fictional");
  await page.getByLabel("Identifiant personnel").fill("desk");
  await page.getByLabel("Mot de passe").fill("fictional-pass-123");
  await page.getByRole("button", { name: "Ouvrir ma session" }).click();
  await page.getByRole("button", { name: "العربية" }).click();
  const row = page.locator(".visit-row").filter({ hasText: "Trabelsi" });
  await row.getByRole("button", { name: "تحضير بطاقة الموعد" }).click();
  await expect(page.locator("#appointment-slip-print")).toContainText("09:15");
  await page.evaluate(() => {
    window.print = () => { document.documentElement.dataset.printed = "yes"; };
  });
  await page.route("**/api/v1/day-board*", async route => {
    const response = await route.fetch();
    const board = await response.json();
    await route.fulfill({ response, json: {
      ...board,
      visits: board.visits.map((visit: { patient: { familyName: string } }) =>
        visit.patient.familyName === "Trabelsi" ? { ...visit, localTime: "10:45" } : visit),
    } });
  });
  await page.getByRole("button", { name: "طباعة بطاقة الموعد" }).click();
  await expect(page.locator("#appointment-slip-print")).toHaveCount(0);
  await expect(page.locator(".toast-error")).toContainText("لم تُطبع بطاقة الموعد");
  await expect(row.locator(".visit-time strong")).toContainText("10:45");
  await expect(page.locator("html")).not.toHaveAttribute("data-printed", "yes");
});


for (const width of [390, 1440] as const) {
  for (const lang of ["fr", "ar"] as const) {
    test(`U029 printed A4 card stays one page (${lang}, ${width}px)`, async ({ page }) => {
      await page.setViewportSize({ width, height: 844 });
      await page.goto("/");
      await page.getByLabel("Code du cabinet").fill("web-fictional");
      await page.getByLabel("Identifiant personnel").fill("desk");
      await page.getByLabel("Mot de passe").fill("fictional-pass-123");
      await page.getByRole("button", { name: "Ouvrir ma session" }).click();
      if (lang === "ar") await page.getByRole("button", { name: "العربية" }).click();

      const row = page.locator(".visit-row").filter({ hasText: "Trabelsi" });
      await row.getByRole("button", {
        name: lang === "fr" ? "Préparer la carte" : "تحضير بطاقة الموعد",
      }).click();
      const card = page.locator("#appointment-slip-print");
      await expect(card).toHaveAttribute("lang", lang);
      await expect(card.locator(".slip-time")).toContainText("09:15");
      await expect(card.locator(".slip-date")).not.toBeEmpty();
      await expect(card.locator(".slip-fictional")).not.toBeEmpty();
      await expect(card).not.toContainText("Trabelsi");

      await page.emulateMedia({ media: "print" });
      await expect(card).toHaveCSS("visibility", "visible");
      await expect(card.locator(".slip-time")).toHaveCSS("visibility", "visible");
      await expect(row.locator(".name-line")).toHaveCSS("visibility", "hidden");

      const pdf = await page.pdf({ format: "A4", printBackground: true });
      expect(pdf.subarray(0, 5).toString()).toBe("%PDF-");
      // Chromium emits a /Type /Page object for each physical PDF page.
      const evidenceDir = new URL("../../docs/testing/u029/", import.meta.url);
      await mkdir(evidenceDir, { recursive: true });
      await writeFile(new URL(`u029-${lang}-${width}.pdf`, evidenceDir), pdf);
      expect((pdf.toString("latin1").match(/\/Type\s*\/Page\b/g) ?? []).length).toBe(1);
    });
  }
}


for (const scenario of [
  { lang: "fr", prepare: "Préparer la carte", print: "Imprimer la carte",
    warning: "La carte n’a pas été imprimée : vérification impossible" },
  { lang: "ar", prepare: "تحضير بطاقة الموعد", print: "طباعة بطاقة الموعد",
    warning: "لم تُطبع بطاقة الموعد: تعذّر التحقق" },
] as const) {
  test(`U029 does not print when slip verification is unavailable (${scenario.lang})`, async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/");
    await page.getByLabel("Code du cabinet").fill("web-fictional");
    await page.getByLabel("Identifiant personnel").fill("desk");
    await page.getByLabel("Mot de passe").fill("fictional-pass-123");
    await page.getByRole("button", { name: "Ouvrir ma session" }).click();
    if (scenario.lang === "ar") await page.getByRole("button", { name: "العربية" }).click();
    const row = page.locator(".visit-row").filter({ hasText: "Trabelsi" });
    await row.getByRole("button", { name: scenario.prepare }).click();
    await expect(page.locator("#appointment-slip-print")).toBeVisible();
    await page.evaluate(() => {
      window.print = () => { document.documentElement.dataset.printed = "yes"; };
    });
    await page.route("**/api/v1/day-board*", route =>
      route.fulfill({ status: 500, contentType: "application/json",
        body: '{"code":"INTERNAL","message":"synthetic verification failure"}' }));
    await row.getByRole("button", { name: scenario.print }).click();
    await expect(page.locator("#appointment-slip-print")).toHaveCount(0);
    await expect(page.locator(".toast-error")).toContainText(scenario.warning);
    await expect(row.locator(".error-box")).toBeVisible();
    await expect(page.locator("html")).not.toHaveAttribute("data-printed", "yes");
  });
}
