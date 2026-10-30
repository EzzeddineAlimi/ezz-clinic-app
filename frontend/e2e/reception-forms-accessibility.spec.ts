import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

async function login(page: Page) {
  await page.goto("/");
  await page.getByLabel("Code du cabinet").fill("web-fictional");
  await page.getByLabel("Identifiant personnel").fill("desk");
  await page.getByLabel("Mot de passe").fill("fictional-pass-123");
  await page.getByRole("button", { name: "Ouvrir ma session" }).click();
  await expect(page.getByRole("heading", { name: "Le fil de la journée" })).toBeVisible();
}

async function checkDialog(page: Page) {
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  expect(await dialog.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
  for (let i = 0; i < 12; i++) {
    await page.keyboard.press("Tab");
    expect(await page.evaluate(() => !!document.activeElement?.closest("dialog"))).toBe(true);
  }
  const audit = await new AxeBuilder({ page })
    .include("dialog")
    .withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"])
    .analyze();
  expect(audit.violations).toEqual([]);
}

test("FR registration reflows at 320px, traps keyboard focus and restores opener on Escape", async ({ page }) => {
  await login(page);
  await page.getByRole("button", { name: "Patients", exact: true }).click();
  await page.setViewportSize({ width: 320, height: 800 });
  const opener = page.getByRole("button", { name: "Nouveau patient", exact: true });
  await opener.click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByLabel("Nom *", { exact: true })).toBeVisible();
  await checkDialog(page);
  await page.keyboard.press("Escape");
  await expect(dialog).not.toBeVisible();
  await expect(opener).toBeFocused();
});

for (const language of ["fr", "ar"] as const) {
  test(`${language.toUpperCase()} booking: 390px RTL/mobile or 720px reflow, no patientless write, accessible dialog`, async ({ page }) => {
    await login(page);
    if (language === "ar") {
      await page.getByRole("button", { name: "العربية", exact: true }).click();
    }
    await page.setViewportSize(language === "ar"
      ? { width: 390, height: 844 }
      : { width: 720, height: 900 });
    await expect(page.locator("html")).toHaveAttribute("dir", language === "ar" ? "rtl" : "ltr");
    const opener = page.getByRole("button", {
      name: language === "ar" ? "موعد جديد" : "Nouveau rendez-vous",
      exact: true,
    });
    await opener.click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByText(language === "ar" ? "اختيار المريض" : "Choisir le patient")).toBeVisible();
    let posted = 0;
    page.on("request", (r) => {
      if (r.method() === "POST" && r.url().endsWith("/api/v1/visits")) posted++;
    });
    await dialog.getByRole("button", {
      name: language === "ar" ? "تسجيل الموعد" : "Enregistrer le rendez-vous",
    }).click();
    await expect(dialog.getByRole("alert")).toBeVisible();
    expect(posted).toBe(0);
    await dialog.getByRole("button", { name: /Karim Chaabane/ }).click();
    await expect(dialog.getByText(language === "ar" ? "المريض المحدد" : "Patient sélectionné")).toBeVisible();
    await checkDialog(page);
    await page.keyboard.press("Escape");
    await expect(dialog).not.toBeVisible();
    await expect(opener).toBeFocused();
    expect(posted).toBe(0);
  });
}
