import { test, expect } from "@playwright/test";
import type { Page, APIRequestContext } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

async function token(request: APIRequestContext, user: string, clinic = "web-fictional") {
  const r = await request.post("/api/v1/session/login", {
    data: { clinicCode: clinic, username: user, password: "fictional-pass-123" },
  });
  expect(r.status()).toBe(200);
  return (await r.json()).token as string;
}
async function fixture(request: APIRequestContext, clinic = "web-fictional") {
  const desk = await token(request, "desk", clinic);
  const dentist = await token(request, "dentist", clinic);
  const owner = await token(request, "owner", clinic);
  const headers = { Authorization: "Bearer " + desk, "Idempotency-Key": crypto.randomUUID() };
  const board = await (await request.get("/api/v1/day-board", { headers })).json();
  const familyName = "Fictif-" + crypto.randomUUID().slice(0, 8);
  const p = await request.post("/api/v1/patients", {
    headers, data: { familyName, givenName: "Checkout", isSynthetic: true },
  });
  expect(p.status()).toBe(201);
  const v = await request.post("/api/v1/visits", {
    headers: { ...headers, "Idempotency-Key": crypto.randomUUID() },
    data: { patientId: (await p.json()).patient.id, scheduledAt: board.day + "T18:00:00+01:00", allowOverlap: true },
  });
  expect(v.status()).toBe(201);
  const id = (await v.json()).visit.id as string;
  const care = await request.post("/api/v1/visits/" + id + "/care", {
    headers: { Authorization: "Bearer " + dentist, "Idempotency-Key": crypto.randomUUID() },
    data: { procedureCode: "TEST", procedureLabel: "Soin fictif", feeMillimes: 100000 },
  });
  expect(care.status()).toBe(201);
  return { desk, dentist, owner, id, familyName };
}
async function login(page: Page, user = "desk", clinic = "web-fictional") {
  await page.goto("/");
  await page.getByLabel("Code du cabinet").fill(clinic);
  await page.getByLabel("Identifiant personnel").fill(user);
  await page.getByLabel("Mot de passe").fill("fictional-pass-123");
  await page.getByRole("button", { name: "Ouvrir ma session" }).click();
  await expect(page.getByRole("heading", { name: "Le fil de la journée" })).toBeVisible();
}
async function open(page: Page, familyName: string, lang: "fr" | "ar" = "fr") {
  const row = page.locator(".visit-row").filter({ hasText: familyName });
  await row.getByRole("button", { name: lang === "fr" ? "Encaissement" : "استخلاص" }).click();
  const d = page.getByRole("dialog");
  await expect(d.getByTestId("checkout-balance")).toBeVisible();
  return d;
}
async function review(d: ReturnType<Page["getByRole"]>, lang: "fr" | "ar" = "fr") {
  await d.getByRole("checkbox", {
    name: lang === "fr" ? /vérifié les paiements enregistrés/ : /راجعت الدفعات المسجلة/,
  }).check();
}
async function prepare(d: ReturnType<Page["getByRole"]>, n: string, tender: "CASH" | "CARD") {
  await d.getByLabel("Montant (TND)").fill(n);
  await d.getByLabel("Mode de paiement").selectOption(tender);
  await review(d);
  await d.getByRole("button", { name: "Préparer le paiement" }).click();
  await expect(d.getByText(/Paiement en attente de décision/)).toBeVisible();
  await expect(d.getByTestId("checkout-balance")).toBeVisible();
}
async function record(d: ReturnType<Page["getByRole"]>) {
  await review(d);
  await d.getByRole("checkbox", { name: /paiement distinct a réellement été reçu/ }).check();
  await d.getByRole("button", { name: "Confirmer l’encaissement" }).click();
}
test("Committed server payment is discovered after reload without automatic duplicate", async ({ page, request }) => {
  const f = await fixture(request);
  const opened = await request.post("/api/v1/cash/periods", {
    headers: { Authorization: "Bearer " + f.owner, "Idempotency-Key": crypto.randomUUID() },
    data: { openingFloatMillimes: 0 },
  });
  expect([201, 409]).toContain(opened.status());
  await login(page);
  let d = await open(page, f.familyName);
  await prepare(d, "30.000", "CASH");
  // The server records while the browser only knows an unresolved intention.
  // Simulates an interrupted client without relying on fragile proxy routing.
  const auth = { Authorization: "Bearer " + f.desk };
  const recovered = await request.get("/api/v1/visits/" + f.id + "/payment-recovery", { headers: auth });
  expect(recovered.status()).toBe(200);
  const state = await recovered.json() as { intentions: Array<{ id: string; status: string }> };
  const savedIntent = state.intentions.find(i => i.status === "PENDING");
  expect(savedIntent).toBeTruthy();
  const committedResponse = await request.post("/api/v1/payment-intents/" + savedIntent!.id + "/record", {
    headers: { ...auth, "Idempotency-Key": crypto.randomUUID() }, data: {},
  });
  expect(committedResponse.status()).toBe(201);
  const committed = await committedResponse.json() as {
    payment: { id: string }, receipt: { id: string; label: string },
  };
  let automaticRecords = 0;
  page.on("request", r => {
    if (r.url().includes("/payment-intents/") && r.url().endsWith("/record") && r.method() === "POST") {
      automaticRecords++;
    }
  });
  await login(page);
  d = await open(page, f.familyName);
  await expect(d.getByTestId("checkout-balance")).toHaveText("70.000 TND");
  await expect(d.getByText(/Paiement en attente de décision/)).toHaveCount(0);
  await expect(d.getByRole("button", { name: "Voir le reçu" })).toHaveCount(1);
  expect(automaticRecords).toBe(0);
  await d.getByRole("button", { name: "Voir le reçu" }).click();
  await expect(d.getByRole("heading", { name: "Reçu " + committed.receipt.label })).toBeVisible();
  await d.getByRole("button", { name: "Préparer une impression" }).click();
  await expect(d.locator("#receipt-print")).toContainText("ORIGINAL");
  await expect(d.getByText(/impression et remise au patient non confirmées/)).toBeVisible();
  await d.getByRole("button", { name: "Préparer une impression" }).click();
  await expect(d.locator("#receipt-print")).toContainText("COPIE");
  const h = await (await request.get("/api/v1/visits/" + f.id + "/payments", {
    headers: { Authorization: "Bearer " + f.desk },
  })).json();
  expect(h.payments).toHaveLength(1);
  expect(h.payments[0].id).toBe(committed.payment.id);
  expect(h.payments[0].receiptId).toBe(committed!.receipt.id);
});

test("Identical second card payment requires reviewed history and explicit distinct-payment approval", async ({ page, request }) => {
  const f = await fixture(request);
  await login(page);
  let d = await open(page, f.familyName);
  await prepare(d, "10.000", "CARD");
  await record(d);
  await expect(d.getByRole("heading", { name: /Reçu R-/ })).toBeVisible();
  await d.getByRole("button", { name: "Fermer le formulaire" }).click();
  d = await open(page, f.familyName);
  await d.getByLabel("Montant (TND)").fill("10.000");
  await d.getByLabel("Mode de paiement").selectOption("CARD");
  await expect(d.getByText(/Paiement similaire détecté/)).toBeVisible();
  await review(d);
  await expect(d.getByRole("button", { name: "Préparer le paiement" })).toBeDisabled();
  await d.getByRole("checkbox", { name: /DEUXIÈME paiement distinct/ }).check();
  const prepareRequest = page.waitForResponse(r => r.url().endsWith("/visits/" + f.id + "/payment-intents") && r.status() === 201);
  await d.getByRole("button", { name: "Préparer le paiement" }).click();
  const attempted = (await prepareRequest).request().postDataJSON();
  expect(attempted.confirmDuplicate).toBe(true);
  await expect(d.getByText(/Paiement en attente de décision/)).toBeVisible();
  await record(d);
  await expect(d.getByTestId("checkout-balance")).toHaveText("80.000 TND");
  const h = await (await request.get("/api/v1/visits/" + f.id + "/payments", {
    headers: { Authorization: "Bearer " + f.desk },
  })).json();
  expect(h.payments).toHaveLength(2);
  expect(h.payments[0].id).not.toBe(h.payments[1].id);
  expect(h.payments[0].receiptId).not.toBe(h.payments[1].receiptId);
});

test("Pending intention reloads without capture and can be explicitly cancelled after reconciliation", async ({ page, request }) => {
  const f = await fixture(request);
  await login(page);
  let d = await open(page, f.familyName);
  await prepare(d, "5.000", "CARD");
  await login(page);
  d = await open(page, f.familyName);
  await expect(d.getByText(/Paiement en attente de décision/)).toBeVisible();
  await expect(d.getByRole("button", { name: "Préparer le paiement" })).toHaveCount(0);
  await review(d);
  await d.getByRole("checkbox", { name: /cette intention n’a enregistré aucun paiement/ }).check();
  await d.getByLabel("Raison de l’annulation").fill("Fictional payment not recorded");
  await d.getByRole("button", { name: /Annuler cette intention/ }).click();
  await expect(d.getByText(/Paiement en attente de décision/)).toHaveCount(0);
  await expect(d.getByTestId("checkout-balance")).toHaveText("100.000 TND");
  const h = await (await request.get("/api/v1/visits/" + f.id + "/payments", {
    headers: { Authorization: "Bearer " + f.desk },
  })).json();
  expect(h.payments).toHaveLength(0);
});

test("Missing cash period blocks cash; assistant is denied, foreign clinic neutral, malformed 401 clears UI", async ({ page, request }) => {
  const f = await fixture(request, "other-fictional");
  const assistant = await token(request, "assistant", "web-fictional");
  const foreign = await token(request, "desk", "web-fictional");
  for (const [auth, status] of [[assistant, 403], [foreign, 404]] as const) {
    const r = await request.get("/api/v1/visits/" + f.id + "/payment-recovery", {
      headers: { Authorization: "Bearer " + auth },
    });
    expect(r.status()).toBe(status);
  }
  await login(page, "desk", "other-fictional");
  const d = await open(page, f.familyName);
  await expect(d.getByText(/Caisse indisponible/)).toBeVisible();
  await d.getByLabel("Montant (TND)").fill("1.000");
  await d.getByLabel("Mode de paiement").selectOption("CASH");
  await review(d);
  await expect(d.getByRole("button", { name: "Préparer le paiement" })).toBeDisabled();
  await page.route("**/api/v1/visits/" + f.id + "/payment-recovery", route => route.fulfill({
    status: 401, contentType: "text/html", body: "invalid auth proxy",
  }));
  await d.getByRole("button", { name: "Relire le solde et les paiements" }).click();
  await expect(page.getByLabel("Code du cabinet")).toBeVisible();
  await expect(page.locator("dialog,.visit-row")).toHaveCount(0);
});

test("Arabic mobile recovery is keyboard accessible without lateral overflow", async ({ page, request }) => {
  const f = await fixture(request);
  await login(page);
  await page.getByRole("button", { name: "العربية", exact: true }).click();
  await page.setViewportSize({ width: 320, height: 800 });
  const d = await open(page, f.familyName, "ar");
  await expect(d.getByTestId("checkout-balance")).toHaveText("100.000 TND");
  await expect(d.getByRole("button", { name: "تحضير الدفعة" })).toBeDisabled();
  expect(await d.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
  for (let i = 0; i < 12; i++) {
    await page.keyboard.press("Tab");
    expect(await d.evaluate(el => el.contains(document.activeElement))).toBe(true);
  }
  expect((await new AxeBuilder({ page })
    .include("dialog")
    .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
    .analyze()).violations).toEqual([]);
});
