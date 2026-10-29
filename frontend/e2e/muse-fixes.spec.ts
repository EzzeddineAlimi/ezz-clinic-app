import { test, expect } from "@playwright/test";
import type { APIRequestContext, Page } from "@playwright/test";

async function token(request: APIRequestContext, username: string) {
  const response = await request.post("/api/v1/session/login", {
    data: { clinicCode: "web-fictional", username, password: "fictional-pass-123" },
  });
  expect(response.status()).toBe(200);
  return (await response.json() as { token: string }).token;
}
async function login(page: Page, username: string) {
  await page.goto("/");
  await page.getByLabel("Code du cabinet").fill("web-fictional");
  await page.getByLabel("Identifiant personnel").fill(username);
  await page.getByLabel("Mot de passe").fill("fictional-pass-123");
  await page.getByRole("button", { name: "Ouvrir ma session" }).click();
  await expect(page.getByRole("heading", { name: "Le fil de la journée" })).toBeVisible();
}
async function newVisit(request: APIRequestContext) {
  const desk = await token(request, "desk");
  const dentist = await token(request, "dentist");
  const headers = { Authorization: `Bearer ${desk}`, "Idempotency-Key": crypto.randomUUID() };
  const day = await request.get("/api/v1/day-board", { headers });
  expect(day.status()).toBe(200);
  const { day: localDay } = await day.json() as { day: string };
  const familyName = "MuseFix" + crypto.randomUUID().slice(0, 8);
  const p = await request.post("/api/v1/patients", {
    headers, data: { familyName, givenName: "Fictionnel", isSynthetic: true },
  });
  expect(p.status()).toBe(201);
  const { patient } = await p.json() as { patient: { id: string } };
  const v = await request.post("/api/v1/visits", {
    headers: { ...headers, "Idempotency-Key": crypto.randomUUID() },
    data: { patientId: patient.id, scheduledAt: localDay + "T18:30:00+01:00", allowOverlap: true },
  });
  expect(v.status()).toBe(201);
  const { visit } = await v.json() as { visit: { id: string } };
  const arrive = await request.post(`/api/v1/visits/${visit.id}/status`, {
    headers: { ...headers, "Idempotency-Key": crypto.randomUUID() },
    data: { status: "ARRIVED" },
  });
  expect(arrive.status()).toBe(200);
  return { desk, dentist, visitId: visit.id, patientId: patient.id, familyName };
}
test("F1+F2: real dentist reviews active medical alert hash before care and explicitly confirms second matching act", async ({ page, request }) => {
  const f = await newVisit(request);
  const addAlert = await request.post(`/api/v1/patients/${f.patientId}/medical-alerts`, {
    headers: { Authorization: "Bearer " + f.dentist, "Idempotency-Key": crypto.randomUUID() },
    data: { code: "ALLERGY_LATEX", severity: "CRITICAL", detail: "Fictional latex caution" },
  });
  expect(addAlert.status()).toBe(201);
  const full = await request.get(`/api/v1/patients/${f.patientId}/medical-alerts`, {
    headers: { Authorization: "Bearer " + f.dentist },
  });
  expect(full.status()).toBe(200);
  const { alertSetHash } = await full.json() as { alertSetHash: string };
  await login(page, "dentist");
  const row = page.locator(".visit-row").filter({ hasText: f.familyName });
  await row.getByRole("button", { name: "Confirmer le soin" }).click();
  let dialog = page.getByRole("dialog");
  await expect(dialog.getByText("ALLERGY_LATEX")).toBeVisible();
  await expect(dialog.getByText("Fictional latex caution")).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Confirmer le soin" })).toBeDisabled();
  await dialog.getByRole("checkbox", { name: /pris connaissance de toutes ces alertes/ }).check();
  await dialog.getByLabel("Code de l’acte *").fill("MUSE");
  await dialog.getByLabel("Description de l’acte *").fill("Soin fictif de contrôle");
  await dialog.getByLabel("Honoraires (TND) *").fill("15.000");
  const first = page.waitForResponse(r => r.url().endsWith(`/visits/${f.visitId}/care`) && r.status() === 201);
  await dialog.getByRole("button", { name: "Confirmer le soin" }).click();
  const r1 = await first;
  expect(r1.request().postDataJSON().alertSetHash).toBe(alertSetHash);
  await expect(dialog).not.toBeVisible();

  await row.getByRole("button", { name: "Confirmer le soin" }).click();
  dialog = page.getByRole("dialog");
  await dialog.getByRole("checkbox", { name: /pris connaissance de toutes ces alertes/ }).check();
  await dialog.getByLabel("Code de l’acte *").fill("MUSE");
  await dialog.getByLabel("Description de l’acte *").fill("Deuxième soin fictif");
  await dialog.getByLabel("Honoraires (TND) *").fill("15.000");
  const denial = page.waitForResponse(r => r.url().endsWith(`/visits/${f.visitId}/care`) && r.status() === 409);
  await dialog.getByRole("button", { name: "Confirmer le soin" }).click();
  const failed = await denial;
  expect((await failed.json()).error.code).toBe("CARE_ALREADY_CONFIRMED");
  await expect(dialog.getByRole("button", { name: "Confirmer le soin" })).toBeDisabled();
  await dialog.getByRole("checkbox", { name: /SECOND acte réalisé/ }).check();
  const second = page.waitForResponse(r => r.url().endsWith(`/visits/${f.visitId}/care`) && r.status() === 201);
  await dialog.getByRole("button", { name: "Confirmer le soin" }).click();
  const r2 = await second;
  expect(r2.request().postDataJSON().confirmRepeat).toBe(true);
  expect(r2.request().postDataJSON().alertSetHash).toBe(alertSetHash);
  expect(r2.request().headers()["idempotency-key"]).not.toBe(r1.request().headers()["idempotency-key"]);
  await expect(dialog).not.toBeVisible();
});
test("F3: second identical payment explicitly reviewed, prepared and recorded as distinct server receipt", async ({ page, request }) => {
  const f = await newVisit(request);
  const care = await request.post("/api/v1/visits/" + f.visitId + "/care", {
    headers: { Authorization: "Bearer " + f.dentist, "Idempotency-Key": crypto.randomUUID() },
    data: { procedureCode: "F3TEST", procedureLabel: "Fictional examination", feeMillimes: 100000 },
  });
  expect(care.status()).toBe(201);
  await login(page, "desk");
  const row = page.locator(".visit-row").filter({ hasText: f.familyName });
  await row.getByRole("button", { name: "Encaissement" }).click();
  let dialog = page.getByRole("dialog");
  await dialog.getByLabel("Montant (TND)").fill("10.000");
  await dialog.getByLabel("Mode de paiement").selectOption("CARD");
  await dialog.getByRole("checkbox", { name: /vérifié les paiements enregistrés/ }).check();
  await dialog.getByRole("button", { name: "Préparer le paiement" }).click();
  await expect(dialog.getByText(/Paiement en attente de décision/)).toBeVisible();
  await dialog.getByRole("checkbox", { name: /vérifié les paiements enregistrés/ }).check();
  await dialog.getByRole("checkbox", { name: /paiement distinct a réellement été reçu/ }).check();
  const firstResponse = page.waitForResponse(r => r.url().endsWith("/record") && r.status() === 201);
  await dialog.getByRole("button", { name: "Confirmer l’encaissement" }).click();
  const first = await firstResponse;
  const firstReceipt = (await first.json() as { receipt: { id: string } }).receipt.id;
  await expect(dialog.getByRole("heading", { name: /Reçu R-/ })).toBeVisible();
  await dialog.getByRole("button", { name: "Fermer le formulaire" }).click();

  await row.getByRole("button", { name: "Encaissement" }).click();
  dialog = page.getByRole("dialog");
  await dialog.getByLabel("Montant (TND)").fill("10.000");
  await dialog.getByLabel("Mode de paiement").selectOption("CARD");
  await expect(dialog.getByText(/Paiement similaire détecté/)).toBeVisible();
  await dialog.getByRole("checkbox", { name: /vérifié les paiements enregistrés/ }).check();
  await expect(dialog.getByRole("button", { name: "Préparer le paiement" })).toBeDisabled();
  await dialog.getByRole("checkbox", { name: /DEUXIÈME paiement distinct/ }).check();
  const preparation = page.waitForResponse(r => r.url().endsWith("/payment-intents") && r.status() === 201);
  await dialog.getByRole("button", { name: "Préparer le paiement" }).click();
  const secondPrepare = await preparation;
  const body = secondPrepare.request().postDataJSON();
  expect(body.amountMillimes).toBe(10000);
  expect(body.confirmDuplicate).toBe(true);
  expect(body.acknowledgedPaymentIds).toHaveLength(1);
  await dialog.getByRole("checkbox", { name: /vérifié les paiements enregistrés/ }).check();
  await dialog.getByRole("checkbox", { name: /paiement distinct a réellement été reçu/ }).check();
  const secondResponse = page.waitForResponse(r => r.url().endsWith("/record") && r.status() === 201);
  await dialog.getByRole("button", { name: "Confirmer l’encaissement" }).click();
  const second = await secondResponse;
  const secondReceipt = (await second.json() as { receipt: { id: string } }).receipt.id;
  expect(secondReceipt).not.toBe(firstReceipt);
  expect(second.request().headers()["idempotency-key"]).not.toBe(first.request().headers()["idempotency-key"]);
  const history = await request.get("/api/v1/visits/" + f.visitId + "/payments", {
    headers: { Authorization: "Bearer " + f.desk },
  });
  expect(history.status()).toBe(200);
  expect((await history.json()).payments).toHaveLength(2);
});
