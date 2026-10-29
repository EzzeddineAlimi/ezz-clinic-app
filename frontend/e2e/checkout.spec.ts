import { test, expect } from "@playwright/test";
import type { Page, APIRequestContext } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { mkdirSync } from "node:fs";
mkdirSync("../docs/images/sprint3b", { recursive: true });
async function token(
  request: APIRequestContext,
  user: string,
  clinic = "web-fictional",
) {
  const r = await request.post("/api/v1/session/login", {
    data: {
      clinicCode: clinic,
      username: user,
      password: "fictional-pass-123",
    },
  });
  expect(r.status()).toBe(200);
  return (await r.json()).token as string;
}
async function fixture(request: APIRequestContext, clinic = "web-fictional") {
  const desk = await token(request, "desk", clinic),
    dentist = await token(request, "dentist", clinic),
    owner = await token(request, "owner", clinic);
  const headers = {
    Authorization: "Bearer " + desk,
    "Idempotency-Key": crypto.randomUUID(),
  };
  const board = await (
    await request.get("/api/v1/day-board", { headers })
  ).json();
  const familyName = "Fictif-" + crypto.randomUUID().slice(0, 8);
  const p = await request.post("/api/v1/patients", {
    headers,
    data: { familyName, givenName: "Checkout", isSynthetic: true },
  });
  expect(p.status()).toBe(201);
  const v = await request.post("/api/v1/visits", {
    headers: { ...headers, "Idempotency-Key": crypto.randomUUID() },
    data: {
      patientId: (await p.json()).patient.id,
      scheduledAt: board.day + "T18:00:00+01:00",
      allowOverlap: true,
    },
  });
  expect(v.status()).toBe(201);
  const id = (await v.json()).visit.id as string;
  const care = await request.post(`/api/v1/visits/${id}/care`, {
    headers: {
      Authorization: "Bearer " + dentist,
      "Idempotency-Key": crypto.randomUUID(),
    },
    data: {
      procedureCode: "TEST",
      procedureLabel: "Soin fictif",
      feeMillimes: 100000,
    },
  });
  expect(care.status()).toBe(201);
  return { desk, owner, id, familyName };
}
async function login(page: Page, user = "desk", clinic = "web-fictional") {
  await page.goto("/");
  await page.getByLabel("Code du cabinet").fill(clinic);
  await page.getByLabel("Identifiant personnel").fill(user);
  await page.getByLabel("Mot de passe").fill("fictional-pass-123");
  await page.getByRole("button", { name: "Ouvrir ma session" }).click();
  await expect(
    page.getByRole("heading", { name: "Le fil de la journée" }),
  ).toBeVisible();
}
test("Partial cash commit lost in transport, exact replay, receipt snapshot and copy numbering; full card settlement", async ({
  page,
  request,
}) => {
  const f = await fixture(request);
  const opened = await request.post("/api/v1/cash/periods", {
    headers: {
      Authorization: "Bearer " + f.owner,
      "Idempotency-Key": crypto.randomUUID(),
    },
    data: { openingFloatMillimes: 0 },
  });
  expect([201, 409]).toContain(opened.status());
  await login(page);
  await page
    .locator(".visit-row")
    .filter({ hasText: f.familyName })
    .getByRole("button", { name: "Encaissement" })
    .click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByTestId("checkout-balance")).toHaveText(
    "100.000 TND",
  );
  await expect(dialog.getByLabel("Mode de paiement")).toHaveValue("");
  await dialog.getByLabel("Montant (TND)").fill("30.000");
  await dialog.getByLabel("Mode de paiement").selectOption("CASH");
  const attempts: { key: string; body: unknown }[] = [];
  let saved:
    | { receipt: { id: string; label: string }; payment: { id: string } }
    | undefined;
  await page.route(`**/visits/${f.id}/payments`, async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    attempts.push({
      key: route.request().headers()["idempotency-key"]!,
      body: route.request().postDataJSON(),
    });
    if (attempts.length === 1) {
      const r = await route.fetch();
      expect(r.status()).toBe(201);
      saved = await r.json();
      await route.abort("failed");
    } else await route.continue();
  });
  await dialog.getByRole("button", { name: "Enregistrer le paiement" }).click();
  await expect(dialog.getByText(/Résultat incertain/)).toBeVisible();
  await expect(dialog.getByLabel("Montant (TND)")).toBeDisabled();
  await dialog
    .getByRole("button", { name: "Relire le solde et les paiements" })
    .click();
  await expect(dialog.getByTestId("checkout-balance")).toHaveText("70.000 TND");
  await dialog.getByRole("button", { name: /Réessayer/ }).click();
  await expect(dialog.getByText(/Résultat incertain/)).toHaveCount(0);
  expect(attempts).toHaveLength(2);
  expect(attempts[1]).toEqual(attempts[0]);
  await expect(
    dialog.getByRole("heading", { name: "Reçu " + saved!.receipt.label }),
  ).toBeVisible();
  const headers = { Authorization: "Bearer " + f.desk };
  const h = await (
    await request.get(`/api/v1/visits/${f.id}/payments`, { headers })
  ).json();
  expect(h.payments).toHaveLength(1);
  expect(h.payments[0].id).toBe(saved!.payment.id);
  const snapshot = await (
    await request.get(`/api/v1/receipts/${saved!.receipt.id}`, { headers })
  ).json();
  expect(snapshot.receipt.snapshot.balanceAfterMillimes).toBe(70000);
  await page.screenshot({
    path: "../docs/images/sprint3b/checkout-fr.png",
    fullPage: false,
  });
  await dialog.getByRole("button", { name: "Préparer une impression" }).click();
  await expect(dialog.locator("#receipt-print")).toContainText("ORIGINAL");
  await dialog.getByRole("button", { name: "Préparer une impression" }).click();
  await expect(dialog.locator("#receipt-print")).toContainText("COPIE");
  expect(
    await (
      await request.get(`/api/v1/receipts/${saved!.receipt.id}`, { headers })
    ).json(),
  ).toEqual(snapshot);
  await dialog
    .getByRole("button", { name: "Fermer le formulaire", exact: true })
    .click();
  await page
    .locator(".visit-row")
    .filter({ hasText: f.familyName })
    .getByRole("button", { name: "Encaissement" })
    .click();
  await dialog.getByLabel("Montant (TND)").fill("30.000");
  await dialog.getByLabel("Mode de paiement").selectOption("CASH");
  await dialog.getByRole("button", { name: "Enregistrer le paiement" }).click();
  await expect(dialog.getByText(/Paiement similaire détecté/)).toBeVisible();
  expect(
    (
      await (
        await request.get(`/api/v1/visits/${f.id}/payments`, { headers })
      ).json()
    ).payments,
  ).toHaveLength(1);
  await dialog
    .getByRole("button", { name: "Nouvelle intention après refus confirmé" })
    .click();
  await expect(dialog.getByTestId("checkout-balance")).toHaveText("70.000 TND");
  await dialog.getByLabel("Montant (TND)").fill("70.001");
  await dialog.getByLabel("Mode de paiement").selectOption("CARD");
  await dialog.getByRole("button", { name: "Enregistrer le paiement" }).click();
  await expect(
    dialog.getByText("Montant invalide ou supérieur au solde."),
  ).toBeVisible();
  await dialog.getByLabel("Montant (TND)").fill("70.000");
  await dialog.getByRole("button", { name: "Enregistrer le paiement" }).click();
  await expect(dialog.getByTestId("checkout-balance")).toHaveText("0.000 TND");
  await dialog
    .getByRole("button", { name: "Fermer le formulaire", exact: true })
    .click();
  await page.getByRole("button", { name: "العربية", exact: true }).click();
  await page.setViewportSize({ width: 320, height: 800 });
  await page
    .locator(".visit-row")
    .filter({ hasText: f.familyName })
    .getByRole("button", { name: "استخلاص" })
    .click();
  await expect(dialog.getByTestId("checkout-balance")).toHaveText("0.000 TND");
  await expect(
    dialog.getByRole("button", { name: "تسجيل الدفعة" }),
  ).toBeDisabled();
  expect(await dialog.evaluate((d) => d.scrollWidth <= d.clientWidth)).toBe(
    true,
  );
  for (let i = 0; i < 12; i++) {
    await page.keyboard.press("Tab");
    expect(
      await dialog.evaluate((d) => d.contains(document.activeElement)),
    ).toBe(true);
  }
  expect(
    (
      await new AxeBuilder({ page })
        .include("dialog")
        .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
        .analyze()
    ).violations,
  ).toEqual([]);
  await page.screenshot({
    path: "../docs/images/sprint3b/checkout-ar-mobile.png",
    fullPage: false,
  });
  const final = await (
    await request.get(`/api/v1/visits/${f.id}/payments`, { headers })
  ).json();
  expect(final.payments).toHaveLength(2);
});
test("Missing owner cash period fails closed in UI; card remains an explicit desk claim", async ({
  page,
  request,
}) => {
  const f = await fixture(request, "other-fictional");
  await login(page, "desk", "other-fictional");
  await page
    .locator(".visit-row")
    .filter({ hasText: f.familyName })
    .getByRole("button", { name: "Encaissement" })
    .click();
  const d = page.getByRole("dialog");
  await expect(d.getByText(/Caisse indisponible/)).toBeVisible();
  await d.getByLabel("Montant (TND)").fill("1");
  await d.getByLabel("Mode de paiement").selectOption("CASH");
  await expect(
    d.getByRole("button", { name: "Enregistrer le paiement" }),
  ).toBeDisabled();
  expect(
    (
      await (
        await request.get(`/api/v1/visits/${f.id}/payments`, {
          headers: { Authorization: "Bearer " + f.desk },
        })
      ).json()
    ).payments,
  ).toHaveLength(0);
});
test("Financial endpoints enforce assistant403 and cross-clinic404; UI hides action; malformed401 clears checkout", async ({
  page,
  request,
}) => {
  const f = await fixture(request),
    assistant = await token(request, "assistant"),
    other = await token(request, "desk", "other-fictional");
  for (const [user, status] of [
    [assistant, 403],
    [other, 404],
  ] as const)
    for (const suffix of ["balance", "payments"]) {
      const r = await request.get(`/api/v1/visits/${f.id}/${suffix}`, {
        headers: { Authorization: "Bearer " + user },
      });
      expect(r.status()).toBe(status);
    }
  await login(page, "assistant");
  await expect(page.getByRole("button", { name: "Encaissement" })).toHaveCount(
    0,
  );
  await login(page);
  await page
    .locator(".visit-row")
    .filter({ hasText: f.familyName })
    .getByRole("button", { name: "Encaissement" })
    .click();
  const d = page.getByRole("dialog");
  await expect(d.getByTestId("checkout-balance")).toBeVisible();
  await page.route(`**/visits/${f.id}/balance`, (r) =>
    r.fulfill({
      status: 401,
      contentType: "text/html",
      body: "bad gateway auth",
    }),
  );
  await d
    .getByRole("button", { name: "Relire le solde et les paiements" })
    .click();
  await expect(page.getByLabel("Code du cabinet")).toBeVisible();
  await expect(page.locator("dialog,.visit-row")).toHaveCount(0);
});
test("Server 503 after committed payment remains uncertain and retries one frozen intent", async ({
  page,
  request,
}) => {
  const f = await fixture(request);
  await login(page);
  await page
    .locator(".visit-row")
    .filter({ hasText: f.familyName })
    .getByRole("button", { name: "Encaissement" })
    .click();
  const d = page.getByRole("dialog");
  await expect(d.getByTestId("checkout-balance")).toBeVisible();
  await d.getByLabel("Montant (TND)").fill("1.000");
  await d.getByLabel("Mode de paiement").selectOption("CARD");
  let first = true;
  const attempts: { key: string; body: unknown }[] = [];
  await page.route(`**/visits/${f.id}/payments`, async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    attempts.push({
      key: route.request().headers()["idempotency-key"]!,
      body: route.request().postDataJSON(),
    });
    if (first) {
      first = false;
      const committed = await route.fetch();
      expect(committed.status()).toBe(201);
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ error: { code: "INTERNAL" } }),
      });
    } else await route.continue();
  });
  await d.getByRole("button", { name: "Enregistrer le paiement" }).click();
  await expect(d.getByText(/Résultat incertain/)).toBeVisible();
  await expect(d.getByLabel("Montant (TND)")).toBeDisabled();
  await expect(
    d.getByRole("button", { name: "Fermer le formulaire", exact: true }),
  ).toBeDisabled();
  await d.getByRole("button", { name: /Réessayer/ }).click();
  await expect(d.getByRole("heading", { name: /Reçu R-/ })).toBeVisible();
  expect(attempts).toHaveLength(2);
  expect(attempts[1]).toEqual(attempts[0]);
  const h = await (
    await request.get(`/api/v1/visits/${f.id}/payments`, {
      headers: { Authorization: "Bearer " + f.desk },
    })
  ).json();
  expect(h.payments).toHaveLength(1);
});
