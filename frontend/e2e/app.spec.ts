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
  await d.getByRole("button", { name: "Fermer", exact: true }).click();
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
  await d.getByRole("button", { name: "Fermer", exact: true }).click();
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
  await page.keyboard.press("Escape");
});
