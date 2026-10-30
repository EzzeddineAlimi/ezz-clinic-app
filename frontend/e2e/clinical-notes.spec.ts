import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import type { Page } from "@playwright/test";

async function login(page: Page, username: string) {
  await page.goto("/");
  await page.getByLabel("Code du cabinet").fill("web-fictional");
  await page.getByLabel("Identifiant personnel").fill(username);
  await page.getByLabel("Mot de passe").fill("fictional-pass-123");
  const response = page.waitForResponse(r => r.url().endsWith("/session/login") && r.status() === 200);
  await page.getByRole("button", { name: "Ouvrir ma session" }).click();
  return (await (await response).json()) as { token: string };
}

test("UX13 signed SOAP cannot be signed again; dentist appends a linked signed entry (FR/AR 390px)", async ({ page }) => {
  const desk = await login(page, "desk");
  const name = "UxSigned" + crypto.randomUUID().slice(0, 8);
  const patient = await page.request.post("/api/v1/patients", {
    headers: { Authorization: "Bearer " + desk.token, "Idempotency-Key": crypto.randomUUID() },
    data: { familyName: name, givenName: "Fictif", isSynthetic: true },
  });
  expect(patient.status()).toBe(201);
  const { patient: created } = await patient.json() as { patient: { id: string } };
  const visitResponse = await page.request.post("/api/v1/visits", {
    headers: { Authorization: "Bearer " + desk.token, "Idempotency-Key": crypto.randomUUID() },
    data: { patientId: created.id, scheduledAt: "2098-01-18T09:00:00+01:00" },
  });
  expect(visitResponse.status()).toBe(201);
  await login(page, "dentist");
  await page.getByLabel("Date des rendez-vous", { exact: true }).fill("2098-01-18");
  const row = page.locator(".visit-row").filter({ hasText: name });
  await expect(row).toBeVisible();
  await row.getByRole("button", { name: "Dossier clinique" }).click();
  const dialog = page.getByRole("dialog");
  const initial = dialog.getByTestId("clinical-initial-note-form");
  await initial.getByLabel("Subjectif").fill("Symptômes fictifs d'essai");
  const signed = page.waitForResponse(r => r.url().endsWith("/clinical-notes") &&
    r.request().method() === "POST" && r.status() === 201);
  await initial.getByRole("button", { name: "Signer et enregistrer" }).click();
  const { note: original } = await (await signed).json() as { note: { id: string; kind: string } };
  expect(original.kind).toBe("NOTE");
  await expect(initial).toHaveCount(0);
  await expect(dialog.getByText("Note initiale déjà signée.", { exact: false })).toBeVisible();
  const addendumToggle = dialog.getByRole("button", { name: "Ajouter un complément" });
  await addendumToggle.click();
  const addendum = dialog.getByTestId("clinical-addendum-form");
  await addendum.getByLabel("Évaluation").fill("Précision fictive ajoutée après signature");
  const posted = page.waitForResponse(r => r.url().endsWith("/clinical-notes/" + original.id + "/addenda") &&
    r.request().method() === "POST" && r.status() === 201);
  await addendum.getByRole("button", { name: "Signer le complément" }).click();
  const response = await posted;
  expect(response.request().postDataJSON().kind).toBe("ADDENDUM");
  const { note: added } = await response.json() as { note: { kind: string; parentNoteId: string } };
  expect(added.kind).toBe("ADDENDUM");
  expect(added.parentNoteId).toBe(original.id);
  await expect(addendumToggle).toBeFocused();
  await expect(dialog.getByText("Précision fictive ajoutée après signature")).toBeVisible();
  await expect(dialog.getByText("Symptômes fictifs d'essai")).toBeVisible();
  await expect(dialog.getByTestId("clinical-initial-note-form")).toHaveCount(0);
  const denied = await page.request.post("/api/v1/clinical-notes/" + original.id + "/addenda", {
    headers: { Authorization: "Bearer " + desk.token, "Idempotency-Key": crypto.randomUUID() },
    data: { kind: "ADDENDUM", subjective: "Tentative accueil fictive" },
  });
  expect(denied.status()).toBe(403);
  await dialog.getByRole("button", { name: "Fermer le formulaire", exact: true }).click();
  await page.getByRole("button", { name: "العربية", exact: true }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await row.getByRole("button", { name: "الملف السريري" }).click();
  const arabic = page.getByRole("dialog");
  await expect(arabic.getByText("تم توقيع الملاحظة الأصلية.", { exact: false })).toBeVisible();
  await expect(arabic.getByRole("button", { name: "توقيع وتسجيل" })).toHaveCount(0);
  await arabic.getByRole("button", { name: "نظرة عامة" }).click();
  const overview = arabic.getByTestId("clinical-overview");
  await expect(overview).toContainText("حالة الموعد");
  await expect(overview).toContainText("التنبيهات الطبية النشطة");
  await expect(overview).toContainText("هذا الملخص لا يثبت إجراء علاج أو استلام دفعة");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const axe = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze();
  expect(axe.violations).toEqual([]);
});


test("UX13 struck initial SOAP remains visible but permits a new signed note (Arabic 390px)", async ({ page }) => {
  const desk = await login(page, "desk");
  const name = "UxStruck" + crypto.randomUUID().slice(0, 8);
  const patient = await page.request.post("/api/v1/patients", {
    headers: { Authorization: "Bearer " + desk.token, "Idempotency-Key": crypto.randomUUID() },
    data: { familyName: name, givenName: "Fictif", isSynthetic: true },
  });
  expect(patient.status()).toBe(201);
  const { patient: created } = await patient.json() as { patient: { id: string } };
  const visitResponse = await page.request.post("/api/v1/visits", {
    headers: { Authorization: "Bearer " + desk.token, "Idempotency-Key": crypto.randomUUID() },
    data: { patientId: created.id, scheduledAt: "2098-01-19T09:00:00+01:00" },
  });
  expect(visitResponse.status()).toBe(201);
  const dentist = await login(page, "dentist");
  await page.getByLabel("Date des rendez-vous", { exact: true }).fill("2098-01-19");
  const row = page.locator(".visit-row").filter({ hasText: name });
  await expect(row).toBeVisible();
  await row.getByRole("button", { name: "Dossier clinique" }).click();
  const frenchDialog = page.getByRole("dialog");
  const firstNote = frenchDialog.getByTestId("clinical-initial-note-form");
  await firstNote.getByLabel("Subjectif").fill("Texte initial fictif à conserver");
  const firstSigned = page.waitForResponse(r => r.url().endsWith("/clinical-notes") &&
    r.request().method() === "POST" && r.status() === 201);
  await firstNote.getByRole("button", { name: "Signer et enregistrer" }).click();
  const { note: original } = await (await firstSigned).json() as { note: { id: string } };
  await expect(firstNote).toHaveCount(0);

  const strike = await page.request.post("/api/v1/clinical-notes/" + original.id + "/addenda", {
    headers: { Authorization: "Bearer " + dentist.token, "Idempotency-Key": crypto.randomUUID() },
    data: { kind: "ENTERED_IN_ERROR", reason: "Note initiale attribuée par erreur" },
  });
  expect(strike.status()).toBe(201);
  const rejectedAddendum = await page.request.post("/api/v1/clinical-notes/" + original.id + "/addenda", {
    headers: { Authorization: "Bearer " + dentist.token, "Idempotency-Key": crypto.randomUUID() },
    data: { kind: "ADDENDUM", subjective: "Ne doit pas être accepté" },
  });
  expect(rejectedAddendum.status()).toBe(409);
  // Same open dialog, out-of-band strike: Refresh must reconcile signedLocally.
  await frenchDialog.getByRole("button", { name: "Actualiser" }).click();
  await expect(frenchDialog.getByTestId("clinical-initial-note-form")).toBeVisible();
  await expect(frenchDialog.getByText("Texte initial fictif à conserver")).toBeVisible();
  await frenchDialog.getByRole("button", { name: "Fermer le formulaire" }).click();

  await page.getByRole("button", { name: "العربية", exact: true }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await row.getByRole("button", { name: "الملف السريري" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByText("إدخال تم تصنيفه كخطأ", { exact: false })).toBeVisible();
  await expect(dialog.getByText("Texte initial fictif à conserver")).toBeVisible();
  const replacement = dialog.getByTestId("clinical-initial-note-form");
  await expect(replacement).toBeVisible();
  await replacement.getByLabel("ذاتي").fill("ملاحظة بديلة تجريبية");
  const signed = page.waitForResponse(r => r.url().endsWith("/clinical-notes") &&
    r.request().method() === "POST" && r.status() === 201);
  await replacement.getByRole("button", { name: "توقيع وتسجيل" }).click();
  const { note: newNote } = await (await signed).json() as { note: { id: string; kind: string } };
  expect(newNote.kind).toBe("NOTE");
  expect(newNote.id).not.toBe(original.id);
  await expect(dialog.getByTestId("clinical-initial-note-form")).toHaveCount(0);
  await expect(dialog.getByText("ملاحظة بديلة تجريبية")).toBeVisible();
  await expect(dialog.getByText("Texte initial fictif à conserver")).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
