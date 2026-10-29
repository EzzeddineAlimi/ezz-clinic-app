/** Disposable fictional clinic for the web app. No real patient data. Stop with Ctrl-C. */
import {
  createTestDb,
  seedClinic,
  STANDARD_STAFF,
  startApi,
} from "../test/helpers.ts";
import { createApp } from "../src/app.ts";
import { localDate } from "../src/modules/settings.ts";
const db = await createTestDb();
const clinic = await seedClinic(db, "web-fictional", [
  ...STANDARD_STAFF,
  { username: "assistant", roles: ["ASSISTANT"] },
]);
await seedClinic(db, "other-fictional", STANDARD_STAFF);
const preparation = await startApi(db.appUrl);
const base = preparation.base + "/api/v1";
async function call(path: string, body: unknown, token?: string) {
  const res = await fetch(base + path, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Idempotency-Key": crypto.randomUUID(),
      ...(token ? { Authorization: "Bearer " + token } : {}),
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`fictional setup ${path}: ${res.status}`);
  return res.json() as Promise<Record<string, unknown>>;
}
const login = await call("/session/login", {
  clinicCode: "web-fictional",
  username: "desk",
  password: "fictional-pass-123",
});
const token = String(login.token);
const day = localDate("Africa/Tunis");
const examples = [
  ["Ben Salem", "Amira", "أميرة بن سالم", "08:30", "ARRIVED"],
  ["Trabelsi", "Youssef", "يوسف الطرابلسي", "09:15", "SCHEDULED"],
  ["Mansour", "Leïla", "ليلى منصور", "10:00", "SCHEDULED"],
  ["Chaabane", "Karim", "كريم شعبان", "11:00", "SCHEDULED"],
  ["Ayadi", "Nour", "نور العيادي", "14:00", "SCHEDULED"],
];
for (const [familyName, givenName, nameAr, time, status] of examples) {
  const r = await call(
    "/patients",
    {
      familyName,
      givenName,
      nameAr,
      isSynthetic: true,
      contactPreference: "IN_PERSON",
      preferredLanguage: "fr",
    },
    token,
  );
  const p = r.patient as { id: string };
  const v = await call(
    "/visits",
    {
      patientId: p.id,
      scheduledAt: `${day}T${time}:00+01:00`,
      durationMin: 30,
      dentistId: clinic.staff.dentist,
    },
    token,
  );
  if (status === "ARRIVED")
    await call(
      `/visits/${(v.visit as { id: string }).id}/status`,
      { status },
      token,
    );
}
await preparation.close();
// Codespaces' private HTTPS origin is the only additional development origin.
// This remains an isolated FICTIONAL data fixture; never broaden to *.app.github.dev.
const codespaceName = process.env.CODESPACES === "true" ? process.env.CODESPACE_NAME : undefined;
if (process.env.CODESPACES === "true" && (!codespaceName || !/^[a-z0-9-]+$/.test(codespaceName))) {
  throw new Error("Codespaces preview requires a valid CODESPACE_NAME");
}
const allowedOrigins = [
  "http://127.0.0.1:5173",
  ...(codespaceName ? [`https://${codespaceName}-5173.app.github.dev`] : []),
];
const { server, db: appDb } = createApp({
  databaseUrl: db.appUrl,
  allowedOrigins,
  log: () => {},
});
await new Promise<void>((resolve) => server.listen(4180, "127.0.0.1", resolve));
console.log(
  "Fictional app API http://127.0.0.1:4180; clinic web-fictional; desk/dentist/owner/assistant; password fictional-pass-123",
);
let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await appDb.close();
  await db.drop();
  process.exit(0);
}
process.on("SIGINT", () => void stop());
process.on("SIGTERM", () => void stop());
