import { test, expect } from "@playwright/test";
import type { Page, APIRequestContext } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

async function login(page: Page, user: string, clinic = "web-fictional") {
  await page.goto("/");
  await page.getByLabel("Code du cabinet").fill(clinic);
  await page.getByLabel("Identifiant personnel").fill(user);
  await page.getByLabel("Mot de passe").fill("fictional-pass-123");
  await page.getByRole("button", { name: "Ouvrir ma session" }).click();
  await expect(page.getByRole("heading", { name: "Le fil de la journée" })).toBeVisible();
}
async function token(request: APIRequestContext, user: string) {
  const response = await request.post("/api/v1/session/login", {
    data: { clinicCode: "web-fictional", username: user, password: "fictional-pass-123" },
  });
  expect(response.status()).toBe(200);
  return (await response.json()).token as string;
}
test("owner cash control: blind count, reviewed gap, carry-forward close, Arabic mobile and desk denial", async ({ page, request }) => {
  const deskToken = await token(request, "desk");
  await login(page, "desk");
  await expect(page.getByRole("button", { name: "Caisse", exact: true })).toHaveCount(0);
  await login(page, "owner");
  await page.getByRole("button", { name: "Caisse", exact: true }).click();
  const cash = page.locator(".owner-cash");
  await expect(cash).toBeVisible();

  const openButton = cash.getByRole("button", { name: "Ouvrir la première période" });
  if (await openButton.isVisible().catch(() => false)) {
    await cash.getByLabel("Fonds de caisse initial (TND)").fill("0");
    await cash.getByLabel("Mot de passe du responsable (confirmation d'identité)").fill("fictional-pass-123");
    await openButton.click();
  }

  await expect(cash.getByTestId("cash-attempt-count")).toBeVisible();
  await expect(cash.getByText("Comptage à l'aveugle", { exact: false })).toBeVisible();
  // Never reveal the expected amount in the count view, including after browser reload.
  await expect(cash.getByTestId("cash-expected")).toHaveCount(0);
  await expect(cash.getByTestId("cash-difference")).toHaveCount(0);

  const attempts = Number(await cash.getByTestId("cash-attempt-count").textContent());
  await cash.getByTestId("cash-count-amount").fill("17.250");
  if (attempts > 0) await cash.getByLabel("Motif du recomptage (obligatoire)").fill("Contrôle fictif indépendant");
  const countResponse = page.waitForResponse(r => r.url().includes("/cash/periods/") &&
    r.url().endsWith("/counts") && r.request().method() === "POST");
  await cash.getByRole("button", { name: "Enregistrer le comptage" }).click();
  expect((await countResponse).status()).toBe(201);
  await expect(cash.getByTestId("cash-expected")).toBeVisible();
  await expect(cash.getByTestId("cash-counted")).toHaveText("17.250 TND");
  await expect(cash.getByText("Un écart ne prouve pas un vol.", { exact: false })).toBeVisible();
  // The owner must see every stored attempt and its reason before accepting the latest.
  await expect(cash.getByTestId("cash-attempt-history").locator("li")).toHaveCount(attempts + 1);
  await cash.getByRole("button", { name: "Effectuer un nouveau comptage" }).click();
  await expect(cash.getByTestId("cash-expected")).toHaveCount(0);
  await expect(cash.getByTestId("cash-difference")).toHaveCount(0);
  await expect(cash.getByTestId("cash-attempt-history")).toHaveCount(0);
  await cash.getByTestId("cash-count-amount").fill("17.000");
  await cash.getByLabel("Motif du recomptage (obligatoire)").fill("Vérification contradictoire fictive");
  const recountResponse = page.waitForResponse(r => r.url().includes("/cash/periods/") &&
    r.url().endsWith("/counts") && r.request().method() === "POST");
  await cash.getByRole("button", { name: "Enregistrer le comptage" }).click();
  expect((await recountResponse).status()).toBe(201);
  await expect(cash.getByTestId("cash-attempt-history").locator("li")).toHaveCount(attempts + 2);
  await expect(cash.getByTestId("cash-attempt-history")).toContainText("Vérification contradictoire fictive");
  await expect(cash.getByTestId("cash-attempt-history")).toContainText("17.250 TND");
  await expect(cash.getByTestId("cash-attempt-history")).toContainText("17.000 TND");
  await expect(cash.getByTestId("cash-attempt-history")).toContainText("Horodatage enregistré (serveur)");
  await expect(cash.getByTestId("cash-attempt-history")).toContainText("Détail du contrôle logiciel (sans preuve physique)");
  await expect(cash.getByTestId("cash-attempt-history")).toContainText("Contrôle logiciel uniquement");
  await expect(cash.getByTestId("cash-attempt-history").locator("time").last()).toContainText("UTC");
  await expect(cash.getByTestId("cash-counted")).toHaveText("17.000 TND");

  await page.getByRole("button", { name: "العربية", exact: true }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(cash.getByRole("heading", { name: "سجل عمليات الجرد المسجلة" })).toBeVisible();
  await expect(cash.getByTestId("cash-attempt-history")).toContainText("وقت تسجيل الجرد (الخادم)");
  await expect(cash.getByTestId("cash-attempt-history")).toContainText("تفاصيل الفحص البرمجي (لا يثبت الجرد الفعلي)");
  await expect(cash.getByTestId("cash-attempt-history")).toContainText("فحص برمجي فقط");
  await expect(cash.getByTestId("cash-attempt-history").locator("time").last()).toContainText("UTC");
  await expect(cash.getByTestId("cash-attempt-history").locator("li")).toHaveCount(attempts + 2);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.getByRole("button", { name: "FR", exact: true }).click();
  const id = await (async () => {
    const r = await request.get("/api/v1/cash/periods/current", {
      headers: { Authorization: "Bearer " + deskToken },
    });
    expect(r.status()).toBe(200);
    const b = await r.json() as { period: { id: string, blind: boolean, expectedMillimes?: number, differenceMillimes?: number } };
    expect(b.period.blind).toBe(true);
    expect(b.period).not.toHaveProperty("expectedMillimes");
    expect(b.period).not.toHaveProperty("differenceMillimes");
    return b.period.id;
  })();
  const denied = await request.get("/api/v1/cash/periods/" + id + "/review", {
    headers: { Authorization: "Bearer " + deskToken },
  });
  expect(denied.status()).toBe(403);
  await page.reload();
  await login(page, "owner");
  await page.getByRole("button", { name: "Caisse", exact: true }).click();
  await expect(cash.getByTestId("cash-expected")).toHaveCount(0);
  await cash.getByRole("button", { name: "Consulter le contrôle" }).click();
  await expect(cash.getByTestId("cash-counted")).toHaveText("17.000 TND");
  await expect(cash.getByTestId("cash-attempt-history").locator("li")).toHaveCount(attempts + 2);
  await cash.getByLabel("Espèces sorties physiquement lors de la remise (TND)").fill("0");
  await cash.getByLabel("Mot de passe du responsable (confirmation d'identité)").fill("fictional-pass-123");
  await cash.getByRole("checkbox", { name: /vérifié les tentatives/ }).check();
  await cash.getByRole("button", { name: "Confirmer la clôture" }).click();
  await expect(cash.getByTestId("cash-attempt-count")).toHaveText("0");

  await page.getByRole("button", { name: "العربية", exact: true }).click();
  await page.setViewportSize({ width: 320, height: 800 });
  await expect(cash.getByRole("heading", { name: "مراقبة الصندوق" })).toBeVisible();
  await expect(cash.getByTestId("cash-expected")).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  const report = await new AxeBuilder({ page }).include(".owner-cash").withTags(["wcag2a","wcag2aa","wcag21aa"]).analyze();
  expect(report.violations).toEqual([]);
});
