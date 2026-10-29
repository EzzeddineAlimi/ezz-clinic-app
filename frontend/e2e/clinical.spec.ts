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
  await signIn(page,"desk");
  await expect(page.getByRole("button",{name:"Dossier clinique"})).toHaveCount(0);
  await page.getByRole("button",{name:"Se déconnecter"}).click();
  await signIn(page,"dentist");
  const row = page.locator(".visit-row").filter({hasText:familyName});
  await row.getByRole("button",{name:"Dossier clinique"}).click();
  const dialog=page.getByRole("dialog");
  await expect(dialog).toContainText(familyName);
  await dialog.getByRole("button",{name:/Plan de traitement/}).click();
  await expect(dialog).toContainText("FICPLAN");
  await expect(dialog).toContainText("150.000 TND");
  await dialog.getByRole("button",{name:/Notes signées/}).click();
  await dialog.getByLabel("subjective").fill("Contexte fictif");
  const signed=page.waitForResponse(r=>r.url().endsWith("/visits/"+visitId+"/clinical-notes") && r.status()===201);
  await dialog.getByRole("button",{name:"Signer et enregistrer"}).click();
  const saved=await (await signed).json();
  expect(saved.note.kind).toBe("NOTE");
  await expect(dialog.getByText("Contexte fictif")).toBeVisible();
  await dialog.getByRole("button",{name:"Actualiser"}).click();
  await expect(dialog.getByText("Contexte fictif")).toBeVisible();
  await expect(dialog.getByRole("button",{name:/Notes signées/})).toContainText("(1)");
});
