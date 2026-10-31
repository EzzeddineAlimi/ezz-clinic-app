import { test, expect } from "@playwright/test";
import type { Page, APIRequestContext } from "@playwright/test";

async function auth(request: APIRequestContext, username: string) {
  const r = await request.post("/api/v1/session/login", {
    data: { clinicCode: "web-fictional", username, password: "fictional-pass-123" },
  });
  expect(r.status()).toBe(200);
  return (await r.json()).token as string;
}
async function signIn(page: Page, user: string) {
  await page.goto("/");
  await page.getByLabel("Code du cabinet").fill("web-fictional");
  await page.getByLabel("Identifiant personnel").fill(user);
  await page.getByLabel("Mot de passe").fill("fictional-pass-123");
  await page.getByRole("button", { name: "Ouvrir ma session" }).click();
  await expect(page.getByRole("heading", { name: "Le fil de la journée" })).toBeVisible();
}
test("Dentist sees restricted encounter, signs append-only note and reads patient treatment plan", async ({ page, request }) => {
  const desk = await auth(request, "desk");
  const dentist = await auth(request, "dentist");
  const h = { Authorization: "Bearer " + desk, "Idempotency-Key": crypto.randomUUID() };
  const board = await (await request.get("/api/v1/day-board", { headers: h })).json();
  const familyName = "Clinical" + crypto.randomUUID().slice(0,8);
  const pr = await request.post("/api/v1/patients", {
    headers: h, data: { familyName, givenName: "Fictionnel", isSynthetic: true },
  });
  expect(pr.status()).toBe(201);
  const patientId = (await pr.json()).patient.id as string;
  const vr = await request.post("/api/v1/visits", {
    headers: {...h,"Idempotency-Key":crypto.randomUUID()},
    data: { patientId, scheduledAt: board.day + "T17:00:00+01:00", allowOverlap:true },
  });
  expect(vr.status()).toBe(201);
  const visitId = (await vr.json()).visit.id as string;
  const ar = await request.post("/api/v1/visits/" + visitId + "/status", {
    headers: {...h,"Idempotency-Key":crypto.randomUUID()}, data: {status:"ARRIVED"},
  });
  expect(ar.status()).toBe(200);
  expect((await request.get("/api/v1/visits/"+visitId+"/encounter",{
    headers:{Authorization:"Bearer "+desk},
  })).status()).toBe(403);
  const plan = await request.post("/api/v1/patients/"+patientId+"/treatment-plan-items",{
    headers:{Authorization:"Bearer "+dentist,"Idempotency-Key":crypto.randomUUID()},
    data:{visitId,procedureCode:"FICPLAN",procedureLabel:"Étape simulée",phaseNo:2,estimatedFeeMillimes:150000},
  });
  expect(plan.status()).toBe(201);
  // Two dentist-authored alerts prove details are available only inside clinical.read.
  for (const alert of [
    { code: "ANTICOAGULANT_DOAC", severity: "CAUTION", detail: null },
    { code: "ALLERGY_LATEX", severity: "CRITICAL", detail: "Allergie au latex fictive" },
  ]) {
    const recorded = await request.post("/api/v1/patients/" + patientId + "/medical-alerts", {
      headers: { Authorization: "Bearer " + dentist, "Idempotency-Key": crypto.randomUUID() },
      data: alert,
    });
    expect(recorded.status()).toBe(201);
  }
  expect((await request.get("/api/v1/patients/" + patientId + "/medical-alerts", {
    headers: { Authorization: "Bearer " + desk },
  })).status()).toBe(403);
  await signIn(page,"desk");
  await expect(page.getByRole("button",{name:"Dossier clinique"})).toHaveCount(0);
  await page.getByRole("button",{name:"Se déconnecter"}).click();
  await signIn(page,"dentist");
  const row = page.locator(".visit-row").filter({hasText:familyName});
  await row.getByRole("button",{name:"Dossier clinique"}).click();
  const dialog=page.getByRole("dialog");
  await expect(dialog).toContainText(familyName);
  const overview = dialog.getByTestId("clinical-overview");
  await expect(overview).toBeVisible();
  await expect(overview).toContainText("État du rendez-vous: Arrivé");
  await expect(overview).toContainText("Alertes médicales actives: 2");
  const details = overview.getByTestId("clinical-alert-details");
  await expect(details.locator("li")).toHaveCount(2);
  await expect(details).toContainText("ALLERGY_LATEX");
  await expect(details).toContainText("Allergie au latex fictive");
  await expect(details).toContainText("ANTICOAGULANT_DOAC");
  await expect(details.locator("li").first()).toContainText("ALLERGY_LATEX");
  await expect(details.locator("li").nth(1)).toContainText("ANTICOAGULANT_DOAC");
  const missingDetail = details.getByTestId("clinical-alert-missing-detail");
  await expect(missingDetail).toHaveCount(1);
  await expect(missingDetail).toBeVisible();
  await expect(missingDetail).toHaveText("Détail non renseigné");
  await expect(missingDetail).toHaveCSS("background-color", "rgb(255, 243, 232)");
  await expect(details).toContainText("Vérifié par le dentiste");
  await expect(overview).toContainText("Ce résumé ne prouve ni soin réalisé ni paiement.");
  // Keyboard-only dentist task: the active section must be navigable and reversible.
  const notesNav = dialog.locator(".clinical-nav button").nth(1);
  const overviewNav = dialog.locator(".clinical-nav button").first();
  await notesNav.focus();
  await page.keyboard.press("Enter");
  await expect(notesNav).toHaveAttribute("aria-pressed", "true");
  await expect(overview).toHaveCount(0);
  await page.keyboard.press("Shift+Tab");
  await expect(overviewNav).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(overview).toBeVisible();
  // Muse Ons C-36: verify desktop patient identity remains visible when reading CRITICAL alerts.
  await page.setViewportSize({ width: 1440, height: 900 });
  const desktopIdentity = dialog.locator(".clinical-workspace > .patient-context");
  const desktopCriticalAlert = details.locator("li").first();
  await expect(desktopIdentity).toContainText(familyName);
  await desktopCriticalAlert.evaluate(el => el.scrollIntoView({ block: "center" }));
  // Regression: scrolling to critical alerts must not hide dialog title/close controls.
  await expect(dialog.locator(".modal-head h2")).toBeInViewport({ ratio: 1 });
  await expect(dialog.locator(".modal-head .icon-button")).toBeInViewport({ ratio: 1 });
  await expect(desktopIdentity).toBeInViewport({ ratio: 1 });
  await expect(desktopCriticalAlert).toBeInViewport({ ratio: 0.9 });
  const desktopIdentityBox = await desktopIdentity.boundingBox();
  const desktopAlertBox = await desktopCriticalAlert.boundingBox();
  expect(desktopIdentityBox).not.toBeNull();
  expect(desktopAlertBox).not.toBeNull();
  expect(desktopIdentityBox!.y + desktopIdentityBox!.height).toBeLessThan(desktopAlertBox!.y);
  await test.info().attach("dentist-fr-1440-identity-critical", {
    body: await page.screenshot({ path: "test-results/dentist-fr-1440-identity-critical.png", animations: "disabled", fullPage: false }),
    contentType: "image/png",
  });
  await test.info().attach("dentist-fr-medical-alert-details", {
    body: await page.screenshot({ path: "../docs/images/sprint3b/dentist-fr-medical-alert-details.png", animations: "disabled" }),
    contentType: "image/png",
  });
  await dialog.getByRole("button",{name:/Plan de traitement/}).click();
  await expect(dialog).toContainText("FICPLAN");
  await expect(dialog).toContainText("Estimation du plan (non facturée): 150.000 TND");
  await expect(dialog.locator(".clinical-entry").filter({ hasText: "FICPLAN" }).getByTestId("plan-status")).toHaveText("Proposé");

  const newPlan = dialog.locator("form.cash-form");
  await newPlan.getByLabel("Code").fill("TESTPLAN2");
  await newPlan.getByLabel("Description").fill("Simulation de traitement");
  await newPlan.getByLabel("Dent FDI").fill("16");
  await newPlan.getByLabel("Estimation (TND, facultatif)").fill("25.000");
  const savedPlan = page.waitForResponse(r =>
    r.url().endsWith("/patients/" + patientId + "/treatment-plan-items") &&
    r.request().method() === "POST" && r.status() === 201);
  await newPlan.getByRole("button",{name:"Ajouter"}).click();
  const createdPlan = await (await savedPlan).json();
  expect(createdPlan.planItem.status).toBe("PROPOSED");
  await expect(dialog).toContainText("TESTPLAN2");

  const planEntry = dialog.locator(".clinical-entry").filter({hasText:"TESTPLAN2"});
  const statusForm = planEntry.locator("form.clinical-status");
  await statusForm.getByLabel("Décision").selectOption("ACCEPTED");
  const statusSaved = page.waitForResponse(r =>
    r.url().endsWith("/treatment-plan-items/" + createdPlan.planItem.id + "/status") &&
    r.status() === 201);
  await statusForm.getByRole("button",{name:"Enregistrer la décision"}).click();
  expect((await (await statusSaved).json()).planItem.status).toBe("ACCEPTED");
  await expect(planEntry.getByTestId("plan-status")).toHaveText("Accepté");

  await dialog.getByRole("button",{name:/Constatations/}).click();
  const findingForm = dialog.locator("form.cash-form");
  await findingForm.getByLabel("Dent FDI").fill("16");
  await findingForm.getByLabel("Code de condition").fill("TEST_FIND");
  const savedFinding = page.waitForResponse(r =>
    r.url().endsWith("/visits/" + visitId + "/chart-findings") && r.status() === 201);
  await findingForm.getByRole("button",{name:"Ajouter"}).click();
  const resultFinding = await (await savedFinding).json();
  expect(resultFinding.finding.toothFdi).toBe(16);
  await expect(dialog).toContainText("TEST_FIND");
  const originalFinding = dialog.locator(".clinical-entry").filter({hasText:"TEST_FIND"});
  const correction = await request.post(
    "/api/v1/chart-findings/" + resultFinding.finding.id + "/entered-in-error",
    { headers: { Authorization: "Bearer " + dentist, "Idempotency-Key": crypto.randomUUID() },
      data: { reason: "Incorrect chart entry, fictional correction" } },
  );
  expect(correction.status()).toBe(201);
  await dialog.getByRole("button", {name:"Actualiser"}).click();
  await expect(originalFinding).toHaveAttribute("data-struck","true");
  await expect(originalFinding.locator("s")).toContainText("TEST_FIND");
  await expect(originalFinding.getByTestId("struck-finding"))
    .toContainText("Incorrect chart entry, fictional correction");

  const balance = await request.get("/api/v1/visits/" + visitId + "/balance", {
    headers: {Authorization:"Bearer "+desk},
  });
  expect(balance.status()).toBe(200);
  expect((await balance.json()).balance.chargedMillimes).toBe(0);

  await dialog.getByRole("button",{name:/Notes signées/}).click();
  await dialog.getByLabel("Subjectif").fill("Contexte fictif");
  const signed=page.waitForResponse(r=>r.url().endsWith("/visits/"+visitId+"/clinical-notes") && r.status()===201);
  await dialog.getByRole("button",{name:"Signer et enregistrer"}).click();
  const saved=await (await signed).json();
  expect(saved.note.kind).toBe("NOTE");
  await expect(dialog.getByText("Contexte fictif")).toBeVisible();
  await dialog.getByRole("button",{name:"Actualiser"}).click();
  await expect(dialog.getByText("Contexte fictif")).toBeVisible();
  await expect(dialog.getByRole("button",{name:/Notes signées/})).toContainText("(1)");
  // Signed SOAP is immutable: no second initial-sign affordance after refresh.
  await expect(dialog.getByTestId("clinical-initial-note-form")).toHaveCount(0);
  await expect(dialog.getByRole("button", { name: "Signer et enregistrer" })).toHaveCount(0);
  await dialog.getByRole("button", { name: "Fermer le formulaire" }).click();
  await page.getByRole("button", { name: "العربية", exact: true }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await row.getByRole("button", { name: "الملف السريري" }).click();
  const arabicOverview = page.getByRole("dialog").getByTestId("clinical-overview");
  await expect(arabicOverview).toBeVisible();
  await expect(arabicOverview).toContainText("التنبيهات الطبية النشطة");
  await expect(arabicOverview.getByTestId("clinical-alert-details")).toContainText("Allergie au latex fictive");
  await expect(arabicOverview.getByTestId("clinical-alert-details")).toContainText("تحقّق منه طبيب الأسنان");
  await expect(arabicOverview.getByTestId("clinical-alert-details").locator("li").first()).toContainText("ALLERGY_LATEX");
  const arabicMissingDetail = arabicOverview.getByTestId("clinical-alert-missing-detail");
  await expect(arabicMissingDetail).toHaveCount(1);
  await expect(arabicMissingDetail).toBeVisible();
  await expect(arabicMissingDetail).toHaveText("التفاصيل غير مسجّلة");
  await expect(arabicMissingDetail).toHaveCSS("background-color", "rgb(255, 243, 232)");
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  // C-32: capture the actual 390px viewport, not only the overview element crop.
  // This proves viewport context, but NOT native browser 200% zoom acceptance.
  const alertList = arabicOverview.getByTestId("clinical-alert-details");
  const widths = await alertList.evaluate(el => ({ visible: el.clientWidth, content: el.scrollWidth }));
  expect(widths.content).toBeLessThanOrEqual(widths.visible);
  // C-35: the patient identity must remain visible with the critical alert after scrolling.
  const identity = page.getByRole("dialog").locator(".clinical-workspace > .patient-context");
  await expect(identity).toContainText(familyName);
  const criticalAlert = alertList.locator("li").first();
  await criticalAlert.evaluate(el => el.scrollIntoView({ block: "center" }));
  await expect(page.getByRole("dialog").locator(".modal-head h2")).toBeInViewport({ ratio: 1 });
  await expect(page.getByRole("dialog").locator(".modal-head .icon-button")).toBeInViewport({ ratio: 1 });
  await expect(identity).toBeInViewport({ ratio: 1 });
  await expect(criticalAlert).toBeInViewport({ ratio: 0.9 });
  const identityBox = await identity.boundingBox();
  const alertBox = await criticalAlert.boundingBox();
  expect(identityBox).not.toBeNull();
  expect(alertBox).not.toBeNull();
  expect(identityBox!.y + identityBox!.height).toBeLessThan(alertBox!.y);
  await test.info().attach("dentist-ar-390-critical-first-null-detail", {
    body: await arabicOverview.screenshot({ path: "test-results/dentist-ar-medical-alert-details.png", animations: "disabled" }),
    contentType: "image/png",
  });
  await test.info().attach("dentist-ar-390-full-viewport", {
    body: await page.screenshot({ path: "test-results/dentist-ar-390-full-viewport.png", animations: "disabled", fullPage: false }),
    contentType: "image/png",
  });
});
