import { test, expect } from "@playwright/test";
import type { APIRequestContext, Page } from "@playwright/test";

async function token(request: APIRequestContext, username: string) {
  const response = await request.post("/api/v1/session/login", {
    data: { clinicCode: "web-fictional", username, password: "fictional-pass-123" },
  });
  expect(response.status()).toBe(200);
  return (await response.json() as { token: string }).token;
}
async function staffLogin(page: Page, username: string) {
  await page.goto("/");
  await page.getByLabel("Code du cabinet").fill("web-fictional");
  await page.getByLabel("Identifiant personnel").fill(username);
  await page.getByLabel("Mot de passe").fill("fictional-pass-123");
  await page.getByRole("button", { name: "Ouvrir ma session" }).click();
  await expect(page.getByRole("heading", { name: "Le fil de la journée" })).toBeVisible();
}
test("End-to-end fictional patient: dentist UI confirms care, receptionist takes partial payment and receives server-numbered receipt", async ({ page, request }) => {
  const desk = await token(request, "desk");
  const headers = { Authorization: "Bearer " + desk, "Idempotency-Key": crypto.randomUUID() };
  const dayResponse = await request.get("/api/v1/day-board", { headers });
  expect(dayResponse.status()).toBe(200);
  const { day } = await dayResponse.json() as { day: string };
  const familyName = "Integre" + crypto.randomUUID().slice(0, 8);
  const patientResponse = await request.post("/api/v1/patients", {
    headers,
    data: { familyName, givenName: "Fictionnel", contactPreference: "IN_PERSON", isSynthetic: true },
  });
  expect(patientResponse.status()).toBe(201);
  const { patient } = await patientResponse.json() as { patient: { id: string; fileNo: number } };
  const visitResponse = await request.post("/api/v1/visits", {
    headers: { ...headers, "Idempotency-Key": crypto.randomUUID() },
    data: { patientId: patient.id, scheduledAt: `${day}T17:00:00+01:00`, durationMin: 30 },
  });
  expect(visitResponse.status()).toBe(201);
  const { visit } = await visitResponse.json() as { visit: { id: string } };
  const arrival = await request.post(`/api/v1/visits/${visit.id}/status`, {
    headers: { ...headers, "Idempotency-Key": crypto.randomUUID() },
    data: { status: "ARRIVED" },
  });
  expect(arrival.status()).toBe(200);

  await staffLogin(page, "dentist");
  const row = page.locator(".visit-row").filter({ hasText: familyName });
  await expect(row).toBeVisible();
  await row.getByRole("button", { name: "Confirmer le soin" }).click();
  const careDialog = page.getByRole("dialog");
  await expect(careDialog).toContainText(String(patient.fileNo));
  await careDialog.getByLabel("Code de l’acte *").fill("JOINTE2E");
  await careDialog.getByLabel("Description de l’acte *").fill("Soin fictif combiné");
  await careDialog.getByLabel("Honoraires (TND) *").fill("150.000");
  const savedCare = page.waitForResponse(r => r.url().endsWith(`/visits/${visit.id}/care`) && r.status() === 201);
  await careDialog.getByRole("button", { name: "Confirmer le soin" }).click();
  expect((await (await savedCare).json() as { visitTotalMillimes: number }).visitTotalMillimes).toBe(150000);
  await expect(careDialog).not.toBeVisible();
  await expect(row.getByText("Terminé", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "Se déconnecter" }).click();
  await staffLogin(page, "desk");
  const deskRow = page.locator(".visit-row").filter({ hasText: familyName });
  await expect(deskRow.getByRole("button", { name: "Confirmer le soin" })).toHaveCount(0);
  await deskRow.getByRole("button", { name: "Encaissement" }).click();
  const checkout = page.getByRole("dialog");
  await expect(checkout.getByTestId("checkout-balance")).toHaveText("150.000 TND");
  await expect(checkout.getByLabel("Mode de paiement")).toHaveValue("");
  await checkout.getByLabel("Montant (TND)").fill("30.000");
  await checkout.getByLabel("Mode de paiement").selectOption("CARD");
  await checkout.getByRole("checkbox", { name: /vérifié les paiements enregistrés/ }).check();
  await checkout.getByRole("button", { name: "Préparer le paiement" }).click();
  await expect(checkout.getByText(/Paiement en attente de décision/)).toBeVisible();
  await checkout.getByRole("checkbox", { name: /vérifié les paiements enregistrés/ }).check();
  await checkout.getByRole("checkbox", { name: /paiement distinct a réellement été reçu/ }).check();
  const paymentResponse = page.waitForResponse(r => r.url().includes("/payment-intents/") && r.url().endsWith("/record") && r.request().method() === "POST" && r.status() === 201);
  await checkout.getByRole("button", { name: "Confirmer l’encaissement" }).click();
  const payment = await (await paymentResponse).json() as {
    payment: { id: string; evidence: { tier: string; verifiedBy: null } };
    receipt: { id: string; number: number; label: string };
    balanceAfterMillimes: number;
  };
  expect(payment.receipt.label).toMatch(/^R-[0-9]{6}$/);
  expect(payment.payment.evidence.tier).toBe("DESK_CLAIM");
  expect(payment.payment.evidence.verifiedBy).toBe(null);
  expect(payment.balanceAfterMillimes).toBe(120000);
  await expect(checkout.getByRole("heading", { name: "Reçu " + payment.receipt.label })).toBeVisible();
  await expect(checkout.getByTestId("checkout-balance")).toHaveText("120.000 TND");
  const stored = await request.get(`/api/v1/visits/${visit.id}/payments`, { headers });
  expect(stored.status()).toBe(200);
  const history = await stored.json() as { payments: Array<{ id: string; receiptNumber: number }> };
  expect(history.payments).toHaveLength(1);
  expect(history.payments[0]?.id).toBe(payment.payment.id);
  expect(history.payments[0]?.receiptNumber).toBe(payment.receipt.number);
  await checkout.getByRole("button", { name: "Fermer le formulaire" }).click();
  await page.getByRole("button", { name: "Se déconnecter" }).click();
  await expect(page.locator(".visit-row,dialog")).toHaveCount(0);
});
