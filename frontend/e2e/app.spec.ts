import { test, expect } from "@playwright/test";
import type { Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { mkdirSync } from "node:fs";
const images = "../docs/images/sprint2";
mkdirSync(images, { recursive: true });
async function login(page: Page, user = "desk") {
  await page.goto("/");
  await page.getByLabel("Code du cabinet").fill("web-fictional");
  await page.getByLabel("Identifiant personnel").fill(user);
  await page.getByLabel("Mot de passe").fill("fictional-pass-123");
  const response = page.waitForResponse(
    (r) => r.url().endsWith("/session/login") && r.status() === 200,
  );
  await page.getByRole("button", { name: "Ouvrir ma session" }).click();
  const session = (await (await response).json()) as {
    token: string;
    staff: { id: string };
  };
  await expect(
    page.getByRole("heading", { name: "Le fil de la journée" }),
  ).toBeVisible();
  await expect(
    page.getByText("Amira Ben Salem", { exact: true }),
  ).toBeVisible();
  return session;
}
test("Real seeded board: French desktop, Arabic mobile, no storage, accessibility and screenshots", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/");
  await page.screenshot({ path: images + "/login-fr.png", fullPage: true });
  await login(page);
  await expect(
    page.getByText("Youssef Trabelsi", { exact: true }),
  ).toBeVisible();
  await page.screenshot({
    path: images + "/agenda-fr-desktop.png",
    fullPage: true,
  });
  const accessibility = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"])
    .analyze();
  expect(accessibility.violations).toEqual([]);
  await page.getByRole("button", { name: "Patients", exact: true }).click();
  await expect(
    page.getByPlaceholder("Nom, numéro de dossier ou téléphone"),
  ).toBeVisible();
  await page.screenshot({
    path: images + "/patients-fr-desktop.png",
    fullPage: true,
  });
  await page.getByRole("button", { name: "Agenda", exact: true }).click();
  await page.getByRole("button", { name: "العربية", exact: true }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
  await page.screenshot({
    path: images + "/agenda-ar-mobile.png",
    fullPage: true,
  });
  await page.setViewportSize({ width: 320, height: 800 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  expect(
    await page.evaluate(() => [localStorage.length, sessionStorage.length]),
  ).toEqual([0, 0]);
  expect(errors).toEqual([]);
});
test("Register no-phone patient, schedule in clinic zone, record arrival and search file", async ({
  page,
}) => {
  await login(page);
  await page.getByRole("button", { name: "Patients", exact: true }).click();
  await page
    .getByRole("button", { name: "Nouveau patient", exact: true })
    .click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Nom *", { exact: true }).fill("FictifSprintDeux");
  await dialog.getByLabel("Prénom *", { exact: true }).fill("Salma");
  await dialog.getByLabel("Nom en arabe").fill("سلمى");
  await dialog.getByRole("button", { name: "Créer le dossier" }).click();
  await expect(dialog).not.toBeVisible();
  await page
    .getByPlaceholder("Nom, numéro de dossier ou téléphone")
    .fill("FictifSprintDeux");
  await page.getByRole("button", { name: "Rechercher", exact: true }).click();
  const row = page
    .locator(".patient-row")
    .filter({ hasText: "Salma FictifSprintDeux" });
  await expect(row).toBeVisible();
  await row.getByRole("button", { name: "Planifier", exact: true }).click();
  await page.getByRole("dialog").getByLabel("Heure du cabinet *").fill("16:15");
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Enregistrer le rendez-vous" })
    .click();
  await expect(page.getByRole("dialog")).not.toBeVisible();
  await page.getByRole("button", { name: "Agenda", exact: true }).click();
  const visit = page
    .locator(".visit-row")
    .filter({ hasText: "Salma FictifSprintDeux" });
  await expect(visit).toContainText("16:15");
  await visit.getByRole("button", { name: "Signaler l’arrivée" }).click();
  await expect(
    page
      .locator(".visit-row")
      .filter({ hasText: "Salma FictifSprintDeux" })
      .getByText("Arrivé", { exact: true }),
  ).toBeVisible();
});
test("Duplicate warning requires human decision; no automatic retry", async ({
  page,
}) => {
  await login(page);
  await page.getByRole("button", { name: "Patients", exact: true }).click();
  await page
    .getByRole("button", { name: "Nouveau patient", exact: true })
    .click();
  const d = page.getByRole("dialog");
  await d.getByLabel("Nom *", { exact: true }).fill("Trabelsi");
  await d.getByLabel("Prénom *", { exact: true }).fill("Youssef");
  await d.getByRole("button", { name: "Créer le dossier" }).click();
  await expect(
    d.getByText("Un dossier similaire existe.", { exact: false }),
  ).toBeVisible();
  await expect(
    d.getByRole("button", { name: "Créer le dossier" }),
  ).toBeDisabled();
  await d.getByLabel("J’ai vérifié : il s’agit d’un autre patient").check();
  await d.getByRole("button", { name: "Créer le dossier" }).click();
  await expect(d).not.toBeVisible();
  await page
    .getByPlaceholder("Nom, numéro de dossier ou téléphone")
    .fill("Trabelsi");
  await page.getByRole("button", { name: "Rechercher", exact: true }).click();
  await expect(page.locator(".patient-row")).toHaveCount(2);
});
test("Lost response after actual database commit: retry same body/key creates only one file", async ({
  page,
}) => {
  await login(page);
  await page.getByRole("button", { name: "Patients", exact: true }).click();
  let lost = false;
  const keys: string[] = [];
  const bodies: string[] = [];
  await page.route("**/api/v1/patients", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    keys.push(route.request().headers()["idempotency-key"] ?? "");
    bodies.push(route.request().postData() ?? "");
    if (!lost) {
      lost = true;
      await route.fetch();
      await route.abort("failed");
    } else await route.continue();
  });
  await page
    .getByRole("button", { name: "Nouveau patient", exact: true })
    .click();
  const d = page.getByRole("dialog");
  await d.getByLabel("Nom *", { exact: true }).fill("ReponsePerdue");
  await d.getByLabel("Prénom *", { exact: true }).fill("Fictif");
  await d.getByRole("button", { name: "Créer le dossier" }).click();
  await expect(d.getByLabel("Nom *", { exact: true })).toBeDisabled();
  await d.getByRole("button", { name: "Réessayer la même demande" }).click();
  await expect(d).not.toBeVisible();
  expect(keys).toHaveLength(2);
  expect(keys[0]).toBe(keys[1]);
  expect(bodies[0]).toBe(bodies[1]);
  await page
    .getByPlaceholder("Nom, numéro de dossier ou téléphone")
    .fill("ReponsePerdue");
  await page.getByRole("button", { name: "Rechercher", exact: true }).click();
  await expect(page.locator(".patient-row")).toHaveCount(1);
});
test("Real server revocation clears patient data and returns to login", async ({
  page,
}) => {
  const session = await login(page);
  const r = await page.request.post("/api/v1/session/logout", {
    headers: { Authorization: "Bearer " + session.token },
    data: {},
  });
  expect(r.status()).toBe(200);
  await page.getByRole("button", { name: "Actualiser", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Ouvrir ma session" }),
  ).toBeVisible();
  await expect(
    page.getByText("Amira Ben Salem", { exact: true }),
  ).not.toBeVisible();
});
test("Assistant is read-only and real server denies registration; no role workaround", async ({
  page,
}) => {
  const session = await login(page, "assistant");
  await expect(
    page.getByRole("button", { name: "Nouveau rendez-vous", exact: true }),
  ).not.toBeVisible();
  await page.getByRole("button", { name: "Patients", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Nouveau patient", exact: true }),
  ).not.toBeVisible();
  const denied = await page.request.post("/api/v1/patients", {
    headers: {
      Authorization: "Bearer " + session.token,
      "Idempotency-Key": crypto.randomUUID(),
    },
    data: { familyName: "Denied", givenName: "Fictif", isSynthetic: true },
  });
  expect(denied.status()).toBe(403);
});
test("Real empty day, loading delay, offline and recovery states", async ({
  page,
  context,
}) => {
  await login(page);
  await page
    .getByLabel("Date des rendez-vous", { exact: true })
    .fill("2099-01-15");
  await expect(
    page.getByText("Une page blanche pour cette journée."),
  ).toBeVisible();
  let release: () => void = () => {};
  const hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/api/v1/day-board*", async (route) => {
    await hold;
    await route.continue();
  });
  await page.getByRole("button", { name: "Actualiser", exact: true }).click();
  await expect(page.getByText("Chargement…", { exact: true })).toBeVisible();
  release();
  await expect(
    page.getByText("Une page blanche pour cette journée."),
  ).toBeVisible();
  await page.unroute("**/api/v1/day-board*");
  await context.setOffline(true);
  await page.getByRole("button", { name: "Actualiser", exact: true }).click();
  await expect(
    page.getByText("Connexion indisponible.", { exact: false }),
  ).toBeVisible();
  await context.setOffline(false);
  await page
    .getByRole("button", { name: "Actualiser", exact: true })
    .first()
    .click();
  await expect(
    page.getByText("Une page blanche pour cette journée."),
  ).toBeVisible();
});
test("Invalid credentials and native required fields; modal keyboard escape restores focus", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByLabel("Code du cabinet").fill("web-fictional");
  await page.getByLabel("Identifiant personnel").fill("desk");
  await page.getByLabel("Mot de passe").fill("incorrect");
  await page.getByRole("button", { name: "Ouvrir ma session" }).click();
  await expect(
    page.getByText("Cabinet, identifiant ou mot de passe incorrect."),
  ).toBeVisible();
  await login(page);
  await page.getByRole("button", { name: "Patients", exact: true }).click();
  const opener = page.getByRole("button", {
    name: "Nouveau patient",
    exact: true,
  });
  await opener.click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Créer le dossier" })
    .click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).not.toBeVisible();
  await expect(opener).toBeFocused();
});
test("Server permission change produces visible 403 and masks prior board data", async ({
  page,
}) => {
  const session = await login(page);
  const ownerRes = await page.request.post("/api/v1/session/login", {
    data: {
      clinicCode: "web-fictional",
      username: "owner",
      password: "fictional-pass-123",
    },
  });
  const owner = (await ownerRes.json()) as { token: string };
  const setRole = (op: string) =>
    page.request.post(`/api/v1/staff/${session.staff.id}/roles`, {
      headers: {
        Authorization: "Bearer " + owner.token,
        "Idempotency-Key": crypto.randomUUID(),
      },
      data: { op, role: "RECEPTIONIST" },
    });
  expect((await setRole("REVOKE")).status()).toBe(200);
  try {
    await page.getByRole("button", { name: "Actualiser", exact: true }).click();
    await expect(
      page.getByText("Cette action n’est pas disponible pour votre rôle."),
    ).toBeVisible();
    await expect(
      page.getByText("Amira Ben Salem", { exact: true }),
    ).not.toBeVisible();
  } finally {
    expect((await setRole("GRANT")).status()).toBe(200);
  }
});
test("Other clinic patient remains absent and cross-clinic id returns neutral 404", async ({
  page,
}) => {
  const ours = await login(page);
  const otherRes = await page.request.post("/api/v1/session/login", {
    data: {
      clinicCode: "other-fictional",
      username: "desk",
      password: "fictional-pass-123",
    },
  });
  const other = (await otherRes.json()) as { token: string };
  const created = await page.request.post("/api/v1/patients", {
    headers: {
      Authorization: "Bearer " + other.token,
      "Idempotency-Key": crypto.randomUUID(),
    },
    data: {
      familyName: "IsolatedFictional",
      givenName: "Other",
      isSynthetic: true,
    },
  });
  const result = (await created.json()) as { patient: { id: string } };
  expect(created.status()).toBe(201);
  const forbidden = await page.request.get(
    "/api/v1/patients/" + result.patient.id,
    { headers: { Authorization: "Bearer " + ours.token } },
  );
  expect(forbidden.status()).toBe(404);
  await page.getByRole("button", { name: "Patients", exact: true }).click();
  await page
    .getByPlaceholder("Nom, numéro de dossier ou téléphone")
    .fill("IsolatedFictional");
  await page.getByRole("button", { name: "Rechercher", exact: true }).click();
  await expect(page.getByText("Aucun dossier trouvé.")).toBeVisible();
});
test("Overlapping appointment requires explicit confirmation; Arabic form remains keyboard accessible", async ({
  page,
}) => {
  await login(page);
  await page
    .getByRole("button", { name: "Nouveau rendez-vous", exact: true })
    .click();
  const d = page.getByRole("dialog");
  await d.getByRole("button", { name: /Karim Chaabane/ }).click();
  await d.getByLabel("Heure du cabinet *").fill("09:15");
  await d
    .getByLabel("Praticien", { exact: true })
    .selectOption({ label: "Fictional dentist" });
  await d.getByRole("button", { name: "Enregistrer le rendez-vous" }).click();
  await expect(
    d.getByText("Le praticien a déjà un rendez-vous sur ce créneau."),
  ).toBeVisible();
  await expect(
    d.getByRole("button", { name: "Enregistrer le rendez-vous" }),
  ).toBeDisabled();
  await d.getByLabel("J’ai vérifié : autoriser ce chevauchement").check();
  const accepted = page.waitForResponse(
    (r) =>
      r.url().endsWith("/visits") &&
      r.request().method() === "POST" &&
      r.status() === 201,
  );
  await d.getByRole("button", { name: "Enregistrer le rendez-vous" }).click();
  const response = await accepted;
  expect(response.request().postDataJSON().allowOverlap).toBe(true);
  await expect(d).not.toBeVisible();
  await page.getByRole("button", { name: "العربية", exact: true }).click();
  await page.getByRole("button", { name: "المرضى", exact: true }).click();
  await page.getByRole("button", { name: "مريض جديد", exact: true }).click();
  const ar = page.getByRole("dialog");
  await expect(ar.getByLabel("اللقب *", { exact: true })).toBeVisible();
  for (let i = 0; i < 18; i++) {
    await page.keyboard.press("Tab");
    expect(
      await page.evaluate(() => !!document.activeElement?.closest("dialog")),
    ).toBe(true);
  }
  await page.setViewportSize({ width: 320, height: 800 });
  expect(
    await page.evaluate(
      () =>
        document.querySelector("dialog")!.scrollWidth <=
        document.querySelector("dialog")!.clientWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: images + "/registration-ar-mobile.png",
    fullPage: true,
  });
  const mobileAxe = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"])
    .analyze();
  expect(mobileAxe.violations).toEqual([]);
  await ar.getByLabel("اللقب *", { exact: true }).fill("مريضوهمي");
  await ar.getByLabel("الاسم *", { exact: true }).fill("اختبار");
  const submit = ar.getByRole("button", { name: "إنشاء الملف", exact: true });
  await submit.scrollIntoViewIfNeeded();
  await submit.focus();
  await expect(submit).toBeInViewport();
  await page.keyboard.press("Enter");
  await expect(ar).not.toBeVisible();
});

for (const method of ["GET", "POST"] as const)
  test(`Malformed authenticated ${method}401 clears workspace and all patient DOM`, async ({
    page,
  }) => {
    await login(page);
    if (method === "POST") {
      await page.getByRole("button", { name: "Patients", exact: true }).click();
      await page
        .getByRole("button", { name: "Nouveau patient", exact: true })
        .click();
      const d = page.getByRole("dialog");
      await d.getByLabel("Nom *", { exact: true }).fill("UnauthorizedFictif");
      await d.getByLabel("Prénom *", { exact: true }).fill("Test");
    }
    await page.route(
      method === "GET" ? "**/api/v1/day-board*" : "**/api/v1/patients",
      (route) =>
        route.fulfill({
          status: 401,
          contentType: "text/html",
          body: "<html>expired proxy</html>",
        }),
    );
    await page
      .getByRole("button", {
        name: method === "GET" ? "Actualiser" : "Créer le dossier",
        exact: true,
      })
      .click();
    await expect(
      page.getByRole("button", { name: "Ouvrir ma session" }),
    ).toBeVisible();
    await expect(
      page.getByText("Amira Ben Salem", { exact: true }),
    ).not.toBeVisible();
    await expect(page.locator(".patient-row,.visit-row,dialog")).toHaveCount(0);
  });

test("Dentist confirms fictional care through real API; receptionist remains denied", async ({ page }) => {
  const desk = await login(page, "desk");
  await expect(page.getByRole("button", { name: "Confirmer le soin" })).toHaveCount(0);
  await login(page, "dentist");
  const visit = page.locator(".visit-row").filter({ hasText: "Amira Ben Salem" });
  await visit.getByRole("button", { name: "Confirmer le soin" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText("Amira Ben Salem");
  await dialog.getByLabel("Code de l’acte *").fill("EXAM");
  await dialog.getByLabel("Description de l’acte *").fill("Examen fictif");
  await dialog.getByLabel("Honoraires (TND) *").fill("100.000");
  const saved = page.waitForResponse((response) =>
    response.url().endsWith("/care") &&
    response.request().method() === "POST" &&
    response.status() === 201,
  );
  await dialog.getByRole("button", { name: "Confirmer le soin" }).click();
  const response = await saved;
  expect(response.request().postDataJSON().feeMillimes).toBe(100000);
  const care = (await response.json()) as { careItem: { visitId: string }, visitTotalMillimes: number };
  expect(care.visitTotalMillimes).toBe(100000);
  await expect(dialog).not.toBeVisible();
  await expect(page.getByText("Soin enregistré par le dentiste.")).toBeVisible();
  const denied = await page.request.post(`/api/v1/visits/${care.careItem.visitId}/care`, {
    headers: {
      Authorization: "Bearer " + desk.token,
      "Idempotency-Key": crypto.randomUUID(),
    },
    data: { procedureCode: "TEST", procedureLabel: "Refused", feeMillimes: 1000 },
  });
  expect(denied.status()).toBe(403);
});

test("UX12: Arabic substring search and same-name booking require visible file verification", async ({ page, request }) => {
  const session = await request.post("/api/v1/session/login", {
    data: { clinicCode: "web-fictional", username: "desk", password: "fictional-pass-123" },
  });
  expect(session.status()).toBe(200);
  const { token } = await session.json() as { token: string };
  const familyName = "Ux12" + crypto.randomUUID().slice(0, 8);
  for (const [i, nameAr] of ["حياة الفحص الأول", "حياة الفحص الثاني"].entries()) {
    const created = await request.post("/api/v1/patients", {
      headers: { Authorization: "Bearer " + token, "Idempotency-Key": crypto.randomUUID() },
      data: {
        familyName, givenName: "Hayet", nameAr, isSynthetic: true,
        phone: "+216 20 000 00" + (i + 1), contactPreference: "BASIC_PHONE_CALL",
        dateOfBirth: i === 0 ? "1982-01-03" : "1994-02-05",
      },
    });
    expect(created.status()).toBe(201);
  }
  await login(page);
  await page.getByRole("button", { name: "Patients", exact: true }).click();
  const search = page.getByPlaceholder("Nom, numéro de dossier ou téléphone");
  await search.fill("الفحص الثاني");
  await page.getByRole("button", { name: "Rechercher", exact: true }).click();
  await expect(page.locator(".patient-row")).toHaveCount(1);
  await expect(page.locator(".patient-row")).toContainText("1994");
  await expect(page.locator(".patient-row")).toContainText("••••0002");
  await page.locator(".patient-row").getByRole("button", { name: "Planifier", exact: true }).click();
  await expect(page.getByRole("dialog")).toContainText("Noms identiques");
  await page.getByRole("dialog").getByRole("button", { name: "Fermer", exact: true }).click();
  await search.fill(familyName.slice(3, 9));
  await page.getByRole("button", { name: "Rechercher", exact: true }).click();
  await expect(page.locator(".patient-row")).toHaveCount(2);
  const first = page.locator(".patient-row").filter({ hasText: "1982" });
  await expect(first).toContainText("••••0001");
  await first.getByRole("button", { name: "Planifier", exact: true }).click();
  const confirmation = page.getByRole("dialog");
  await expect(confirmation).toContainText("Noms identiques");
  await expect(confirmation).toContainText("Dossier #");
  await confirmation.getByRole("button", { name: /Confirmer ce dossier pour le rendez-vous/ }).click();
  await expect(page.getByRole("dialog")).toContainText("Patient sélectionné");
});

test("UX12 status: desk no-show requires reason, updates board, and cannot re-arrive", async ({ page }) => {
  const session = await login(page);
  const headers = { Authorization: "Bearer " + session.token, "Idempotency-Key": crypto.randomUUID() };
  const name = "UxNoShow" + crypto.randomUUID().slice(0, 7);
  const patient = await page.request.post("/api/v1/patients", {
    headers, data: { familyName: name, givenName: "Fictif", isSynthetic: true },
  });
  expect(patient.status()).toBe(201);
  const { patient: created } = await patient.json() as { patient: { id: string } };
  const visit = await page.request.post("/api/v1/visits", {
    headers: { ...headers, "Idempotency-Key": crypto.randomUUID() },
    data: { patientId: created.id, scheduledAt: "2025-02-15T09:00:00+01:00", durationMin: 30 },
  });
  expect(visit.status()).toBe(201);
  await page.getByLabel("Date des rendez-vous", { exact: true }).fill("2025-02-15");
  const row = page.locator(".visit-row").filter({ hasText: name });
  await expect(row).toBeVisible();
  await row.getByRole("button", { name: "Signaler absent" }).click();
  const dialog = page.getByRole("dialog");
  const confirm = dialog.getByRole("button", { name: "Confirmer le changement" });
  await expect(confirm).toBeDisabled();
  await dialog.getByLabel("Motif de ce changement *").fill("Patient absent au rendez-vous");
  await confirm.click();
  await expect(dialog).not.toBeVisible();
  await expect(row.getByText("Absent", { exact: true })).toBeVisible();
  await expect(row).toContainText("Patient absent au rendez-vous");
  await expect(row.getByRole("button", { name: "Signaler l’arrivée" })).toHaveCount(0);
  await expect(row.getByRole("button", { name: "Annuler le rendez-vous" })).toHaveCount(0);
});

test("UX12 status: future no-show is denied; reasoned cancellation is final and RTL accessible", async ({ page }) => {
  const session = await login(page);
  const headers = { Authorization: "Bearer " + session.token, "Idempotency-Key": crypto.randomUUID() };
  const name = "UxCancel" + crypto.randomUUID().slice(0, 7);
  const patient = await page.request.post("/api/v1/patients", {
    headers, data: { familyName: name, givenName: "Fictif", isSynthetic: true },
  });
  expect(patient.status()).toBe(201);
  const { patient: created } = await patient.json() as { patient: { id: string } };
  const visit = await page.request.post("/api/v1/visits", {
    headers: { ...headers, "Idempotency-Key": crypto.randomUUID() },
    data: { patientId: created.id, scheduledAt: "2098-01-15T09:00:00+01:00", durationMin: 30 },
  });
  expect(visit.status()).toBe(201);
  const { visit: createdVisit } = await visit.json() as { visit: { id: string } };
  const premature = await page.request.post("/api/v1/visits/" + createdVisit.id + "/status", {
    headers: { ...headers, "Idempotency-Key": crypto.randomUUID() },
    data: { status: "NO_SHOW", reason: "Patient absent" },
  });
  expect(premature.status()).toBe(409);
  const noReason = await page.request.post("/api/v1/visits/" + createdVisit.id + "/status", {
    headers: { ...headers, "Idempotency-Key": crypto.randomUUID() },
    data: { status: "CANCELLED" },
  });
  expect(noReason.status()).toBe(400);
  await page.getByRole("button", { name: "العربية", exact: true }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByLabel("تاريخ المواعيد", { exact: true }).fill("2098-01-15");
  const row = page.locator(".visit-row").filter({ hasText: name });
  await expect(row).toBeVisible();
  await expect(row.getByRole("button", { name: "تسجيل الغياب" })).toHaveCount(0);
  await row.getByRole("button", { name: "إلغاء الموعد" }).click();
  const dialog = page.getByRole("dialog");
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
  const axe = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze();
  expect(axe.violations).toEqual([]);
  await dialog.getByLabel("سبب تغيير حالة الموعد *").fill("ألغى المريض الموعد");
  await dialog.getByRole("button", { name: "تأكيد التغيير" }).click();
  await expect(dialog).not.toBeVisible();
  await expect(row.getByText("ملغى", { exact: true })).toBeVisible();
  await expect(row).toContainText("ألغى المريض الموعد");
  await expect(row.getByRole("button", { name: "تسجيل الوصول" })).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test("UX12 status: lost committed response retries the same frozen request, not a second transition", async ({ page }) => {
  const session = await login(page);
  const headers = { Authorization: "Bearer " + session.token, "Idempotency-Key": crypto.randomUUID() };
  const name = "UxStatusRetry" + crypto.randomUUID().slice(0, 7);
  const patient = await page.request.post("/api/v1/patients", {
    headers, data: { familyName: name, givenName: "Fictif", isSynthetic: true },
  });
  expect(patient.status()).toBe(201);
  const { patient: created } = await patient.json() as { patient: { id: string } };
  const visit = await page.request.post("/api/v1/visits", {
    headers: { ...headers, "Idempotency-Key": crypto.randomUUID() },
    data: { patientId: created.id, scheduledAt: "2098-01-16T09:00:00+01:00" },
  });
  expect(visit.status()).toBe(201);
  await page.getByLabel("Date des rendez-vous", { exact: true }).fill("2098-01-16");
  const row = page.locator(".visit-row").filter({ hasText: name });
  await expect(row).toBeVisible();
  let lost = false;
  const keys: string[] = [];
  const bodies: string[] = [];
  await page.route("**/api/v1/visits/*/status", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    keys.push(route.request().headers()["idempotency-key"] ?? "");
    bodies.push(route.request().postData() ?? "");
    if (!lost) {
      lost = true;
      const committed = await route.fetch();
      expect(committed.status()).toBe(200);
      await route.abort("failed");
    } else await route.continue();
  });
  await row.getByRole("button", { name: "Annuler le rendez-vous" }).click();
  const dialog = page.getByRole("dialog");
  const reason = dialog.getByLabel("Motif de ce changement *");
  await reason.fill("Annulation fictive demandée");
  await dialog.getByRole("button", { name: "Confirmer le changement" }).click();
  await expect(dialog.getByText("Réception non confirmée.", { exact: false })).toBeVisible();
  await expect(reason).toBeDisabled();
  await dialog.getByRole("button", { name: "Réessayer la même demande" }).click();
  await expect(dialog).not.toBeVisible();
  expect(keys).toHaveLength(2);
  expect(keys[0]).toBe(keys[1]);
  expect(bodies[0]).toBe(bodies[1]);
  await expect(row.getByText("Annulé", { exact: true })).toBeVisible();
});

test("UX12 review: Arabic-only duplicate triggers verification, normalized search and list DOB minimization", async ({ page }) => {
  const session = await login(page);
  const headers = () => ({ Authorization: "Bearer " + session.token, "Idempotency-Key": crypto.randomUUID() });
  const suffix = crypto.randomUUID().slice(0, 8);
  const first = await page.request.post("/api/v1/patients", {
    headers: headers(), data: {
      familyName: "ArabicFictionalA" + suffix, givenName: "FictifA",
      nameAr: "أَحْمَد سـليم " + suffix, dateOfBirth: "1982-01-03", isSynthetic: true,
    },
  });
  expect(first.status()).toBe(201);
  const other = {
    familyName: "ArabicFictionalB" + suffix, givenName: "FictifB",
    nameAr: "احمد سليم " + suffix, dateOfBirth: "1994-02-05", isSynthetic: true,
  };
  const denied = await page.request.post("/api/v1/patients", { headers: headers(), data: other });
  expect(denied.status()).toBe(409);
  const second = await page.request.post("/api/v1/patients", {
    headers: headers(), data: { ...other, confirmNotDuplicate: true },
  });
  expect(second.status()).toBe(201);
  await page.getByRole("button", { name: "Patients", exact: true }).click();
  await page.getByPlaceholder("Nom, numéro de dossier ou téléphone").fill("احمد سليم " + suffix);
  await page.getByRole("button", { name: "Rechercher", exact: true }).click();

  await expect(page.locator(".patient-row")).toHaveCount(2);
  const listResponse = await page.request.get("/api/v1/patients?q=" + encodeURIComponent("احمد سليم " + suffix), {
    headers: { Authorization: "Bearer " + session.token },
  });
  expect(listResponse.status()).toBe(200);
  const listed = (await listResponse.json() as {
    patients: Array<{ birthYear: string | null; dateOfBirth?: string }>;
  }).patients;
  expect(listed).toHaveLength(2);
  expect(listed.map(p => p.birthYear).sort()).toEqual(["1982", "1994"]);
  expect(listed.every(p => !Object.hasOwn(p, "dateOfBirth"))).toBe(true);
  const row = page.locator(".patient-row").filter({ hasText: "ArabicFictionalA" + suffix });
  await expect(row).toContainText("Année de naissance");
  await expect(row).toContainText("1982");
  await expect(row).not.toContainText("03/01/1982");
  await row.getByRole("button", { name: "Planifier", exact: true }).click();
  const verify = page.getByRole("dialog");
  await expect(verify).toContainText("Noms identiques");
  await expect(verify).toContainText("03/01/1982");
  await verify.getByRole("button", { name: "Fermer", exact: true }).click();
});



test("UX12 privacy: failed selected patient detail never opens identity confirmation or schedules", async ({ page }) => {
  const session = await login(page);
  const suffix = crypto.randomUUID().slice(0, 8);
  const headers = () => ({ Authorization: "Bearer " + session.token, "Idempotency-Key": crypto.randomUUID() });
  const first = await page.request.post("/api/v1/patients", {
    headers: headers(), data: {
      familyName: "PrivateFirst" + suffix, givenName: "Fictif",
      nameAr: "اسم مشترك " + suffix, dateOfBirth: "1981-02-03", isSynthetic: true,
    },
  });
  expect(first.status()).toBe(201);
  const second = await page.request.post("/api/v1/patients", {
    headers: headers(), data: {
      familyName: "PrivateSecond" + suffix, givenName: "Fictif",
      nameAr: "اسم مشترك " + suffix, dateOfBirth: "1992-03-04",
      confirmNotDuplicate: true, isSynthetic: true,
    },
  });
  expect(second.status()).toBe(201);
  await page.getByRole("button", { name: "Patients", exact: true }).click();
  await page.getByPlaceholder("Nom, numéro de dossier ou téléphone").fill(suffix);
  await page.getByRole("button", { name: "Rechercher", exact: true }).click();
  await expect(page.locator(".patient-row")).toHaveCount(2);
  await page.route("**/api/v1/patients/*", route => route.abort("failed"));
  await page.locator(".patient-row").first().getByRole("button", { name: "Planifier", exact: true }).click();
  await expect(page.locator(".error-box")).toContainText("Connexion indisponible");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByText("Patient sélectionné")).toHaveCount(0);
});

test("UX12 status: typed documented-visit rejection explains the blocked desk action", async ({ page }) => {
  const session = await login(page);
  const name = "TypedConflict" + crypto.randomUUID().slice(0, 7);
  const headers = () => ({ Authorization: "Bearer " + session.token, "Idempotency-Key": crypto.randomUUID() });
  const created = await page.request.post("/api/v1/patients", {
    headers: headers(), data: { familyName: name, givenName: "Fictif", isSynthetic: true },
  });
  expect(created.status()).toBe(201);
  const patientId = (await created.json() as { patient: { id: string } }).patient.id;
  const scheduled = await page.request.post("/api/v1/visits", {
    headers: headers(), data: { patientId, scheduledAt: "2098-01-19T09:00:00+01:00" },
  });
  expect(scheduled.status()).toBe(201);
  await page.getByLabel("Date des rendez-vous", { exact: true }).fill("2098-01-19");
  const row = page.locator(".visit-row").filter({ hasText: name });
  await expect(row).toBeVisible();
  await page.route("**/api/v1/visits/*/status", route =>
    route.fulfill({
      status: 409,
      contentType: "application/json",
      body: JSON.stringify({ error: {
        code: "CONFLICT", message: "Visit documented",
        details: { reason: "VISIT_HAS_DOCUMENTED_CARE" },
      } }),
    }),
  );
  await row.getByRole("button", { name: "Annuler le rendez-vous" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Motif de ce changement *").fill("Annulation fictive");
  await dialog.getByRole("button", { name: "Confirmer le changement" }).click();
  await expect(dialog).toContainText("Le praticien a déjà enregistré des soins");
  await expect(dialog).toBeVisible();
});

test("UX12 follow-on: receptionist dayboard filters by patient, file and dentist in FR/AR mobile", async ({ page }) => {
  await login(page);
  const rows = page.locator(".visit-row");
  const search = page.getByRole("searchbox", { name: "Filtrer par nom ou numéro de dossier" });
  await search.fill("Amira");
  await expect(rows.filter({ hasText: "Amira Ben Salem" }).first()).toBeVisible();
  await expect(rows.filter({ hasText: "Youssef Trabelsi" })).toHaveCount(0);
  await search.fill("");
  const dentist = page.getByRole("combobox", { name: "Praticien", exact: true });
  const options = dentist.locator("option");
  expect(await options.count()).toBeGreaterThan(1);
  const selectedName = await options.nth(1).textContent();
  await dentist.selectOption({ index: 1 });
  await expect(rows.first()).toContainText(selectedName!);
  await page.getByRole("button", { name: "العربية", exact: true }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole("searchbox", { name: "تصفية حسب الاسم أو رقم الملف" })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test("UX12 Muse F1: filtered-empty never claims empty day; clear filters restores all in FR/AR 390px", async ({ page }) => {
  await login(page);
  const rows = page.locator(".visit-row");
  const total = await rows.count();
  expect(total).toBeGreaterThan(0);
  const count = page.getByTestId("dayboard-result-count");
  await expect(count).toContainText(String(total));
  await expect(count).not.toContainText("/");

  const search = page.getByRole("searchbox", { name: "Filtrer par nom ou numéro de dossier" });
  await search.fill("NoMatchingFictionalPatientZZ");
  await expect(rows).toHaveCount(0);
  await expect(page.getByText("Aucun rendez-vous ne correspond aux filtres.")).toBeVisible();
  await expect(page.getByText("Une page blanche pour cette journée.")).toHaveCount(0);
  await expect(count).toContainText("0 / " + total);
  await page.getByRole("button", { name: "Effacer les filtres" }).click();
  await expect(search).toBeFocused();
  await expect(search).toHaveValue("");
  await expect(rows).toHaveCount(total);
  await expect(count).not.toContainText("/");

  const dentist = page.getByRole("combobox", { name: "Praticien", exact: true });
  await dentist.selectOption({ index: 1 });
  await search.fill("NoMatchingFictionalPatientZZ");
  await expect(rows).toHaveCount(0);
  await page.getByRole("button", { name: "العربية", exact: true }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
  await expect(page.getByText("لا توجد مواعيد تطابق عوامل التصفية.")).toBeVisible();
  await expect(count).toContainText("0 / " + total);
  await page.getByRole("button", { name: "مسح عوامل التصفية" }).click();
  await expect(page.getByRole("searchbox", { name: "تصفية حسب الاسم أو رقم الملف" })).toBeFocused();
  await expect(rows).toHaveCount(total);
  await expect(page.getByRole("combobox", { name: "الطبيب", exact: true })).toHaveValue("all");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test("UX12 follow-on: booking picker requires a focus-managed nested identity dialog", async ({ page }) => {
  const session = await login(page);
  const headers = () => ({
    Authorization: "Bearer " + session.token,
    "Idempotency-Key": crypto.randomUUID(),
  });
  const suffix = crypto.randomUUID().slice(0, 8);
  const nameAr = "محمد تجريبي " + suffix;
  const first = await page.request.post("/api/v1/patients", {
    headers: headers(), data: {
      familyName: "PickerFirst" + suffix, givenName: "Fictif",
      nameAr, dateOfBirth: "1982-01-03", isSynthetic: true,
    },
  });
  expect(first.status()).toBe(201);
  const second = await page.request.post("/api/v1/patients", {
    headers: headers(), data: {
      familyName: "PickerSecond" + suffix, givenName: "Fictif",
      nameAr, dateOfBirth: "1994-02-05", confirmNotDuplicate: true, isSynthetic: true,
    },
  });
  expect(second.status()).toBe(201);
  await page.getByRole("button", { name: "Nouveau rendez-vous" }).click();
  const scheduling = page.getByRole("dialog").first();
  await scheduling.locator("#picker-search").fill(suffix);
  await scheduling.getByRole("button", { name: "Rechercher", exact: true }).click();
  await expect(scheduling.locator(".picker-results button")).toHaveCount(2);
  await scheduling.locator(".picker-results button").filter({ hasText: "PickerFirst" + suffix }).click();
  const dialogs = page.locator("dialog");
  await expect(dialogs).toHaveCount(2);
  const verify = dialogs.last();
  await expect(verify).toContainText("Noms identiques");
  await expect(verify).toContainText("03/01/1982");
  expect(await page.evaluate(() => {
    const ds = [...document.querySelectorAll("dialog")];
    return ds.length === 2 &&
      ds[0]!.getAttribute("aria-labelledby") !== ds[1]!.getAttribute("aria-labelledby") &&
      ds[1]!.contains(document.activeElement);
  })).toBe(true);
  const verifyClose = verify.getByRole("button", { name: "Fermer le formulaire", exact: true });
  const verifyConfirm = verify.getByRole("button", { name: /Confirmer ce dossier pour le rendez-vous/ });
  await verifyClose.focus();
  await expect(verifyClose).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(verifyConfirm).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(verifyClose).toBeFocused();
  await verifyClose.click();
  await expect(dialogs).toHaveCount(1);
  await scheduling.locator(".picker-results button").filter({ hasText: "PickerFirst" + suffix }).click();
  await dialogs.last().getByRole("button", { name: /Confirmer ce dossier pour le rendez-vous/ }).click();
  await expect(dialogs).toHaveCount(1);
  await expect(scheduling).toContainText("Patient sélectionné");
  await expect(scheduling).toContainText("PickerFirst" + suffix);
});
