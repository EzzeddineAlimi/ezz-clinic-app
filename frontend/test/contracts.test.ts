import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { clinicInstant, shiftDay } from "../src/time.ts";
import {
  ApiError,
  WriteIntent,
  boardSchema,
  patientSchema,
} from "../src/api.ts";

test("Clinic wall time is independent of device/server zone; DST folds and gaps refused", () => {
  assert.equal(
    clinicInstant("2026-10-29", "09:00", "Africa/Tunis"),
    "2026-10-29T08:00:00.000Z",
  );
  assert.equal(
    clinicInstant("2026-10-29", "09:00", "America/Toronto"),
    "2026-10-29T13:00:00.000Z",
  );
  assert.throws(() => clinicInstant("2026-03-08", "02:30", "America/Toronto"));
  assert.throws(() => clinicInstant("2026-11-01", "01:30", "America/Toronto"));
  assert.throws(() => clinicInstant("2026-02-30", "09:00", "Africa/Tunis"));
  assert.equal(shiftDay("2026-03-01", -1), "2026-02-28");
});
test("Unknown write outcome freezes body/key; confirmed rejection allows explicit correction", () => {
  const intent = new WriteIntent(),
    key = intent.key;
  assert.deepEqual(intent.payload({ a: 1 }), { a: 1 });
  intent.failed(new ApiError("NETWORK"));
  assert.deepEqual(intent.payload({ a: 2 }), { a: 1 });
  assert.equal(intent.key, key);
  intent.failed(new ApiError("CONFLICT", 409));
  assert.deepEqual(intent.payload({ a: 2 }), { a: 2 });
});
test("Client schemas distinguish patient search projection and integer financial values", () => {
  assert.ok(
    patientSchema.safeParse({
      id: "p",
      fileNo: 1,
      familyName: "Fictif",
      givenName: "Test",
      contactPreference: "IN_PERSON",
    }).success,
  );
  const base = {
    day: "2026-10-29",
    timezone: "Africa/Tunis",
    scope: "all",
    summary: { total: 1, byStatus: { SCHEDULED: 1 }, notArrivedPastStart: 0 },
    visits: [
      {
        id: "v",
        localTime: "09:00",
        scheduledAt: "2026-10-29T08:00:00Z",
        durationMin: 30,
        status: "SCHEDULED",
        patient: {
          id: "p",
          fileNo: 1,
          familyName: "Fictif",
          givenName: "Test",
          contactPreference: "IN_PERSON",
        },
        dentist: null,
        flags: [],
        waitingMinutes: null,
        balanceDueMillimes: 1.5,
      },
    ],
  };
  assert.equal(boardSchema.safeParse(base).success, false);
});
test("Every first-slice endpoint exists in checked-in OpenAPI; no proposed clinical endpoints", () => {
  const api = JSON.parse(readFileSync("../docs/api/openapi.json", "utf8")) as {
    paths: Record<string, Record<string, unknown>>;
  };
  for (const [path, methods] of Object.entries({
    "/session/login": ["post"],
    "/session": ["get"],
    "/session/logout": ["post"],
    "/patients": ["get", "post"],
    "/visits": ["post"],
    "/day-board": ["get"],
    "/visits/{id}/status": ["post"],
  }))
    for (const method of methods)
      assert.ok(api.paths["/api/v1" + path]?.[method], path + " " + method);
});

test("Authenticated malformed 401 always expires GET and POST sessions", async (t) => {
  const { Api } = await import("../src/api.ts");
  for (const body of ["<html>unauthorised</html>", "{broken"])
    for (const method of ["GET", "POST"]) {
      let expired = 0;
      const mocked = t.mock.method(
        globalThis,
        "fetch",
        async () => new Response(body, { status: 401 }),
      );
      const api = new Api("test-token", () => expired++);
      await assert.rejects(method === "GET" ? api.session() : api.logout());
      mocked.mock.restore();
      assert.equal(expired, 1, method + " malformed401");
    }
});
test("Parsable REAUTH_REQUIRED, 403 and non-401 parse failures do not expire sessions", async (t) => {
  const { Api } = await import("../src/api.ts");
  for (const [status, body, code] of [
    [
      401,
      JSON.stringify({ error: { code: "REAUTH_REQUIRED" } }),
      "REAUTH_REQUIRED",
    ],
    [
      403,
      JSON.stringify({ error: { code: "FORBIDDEN_ROLE" } }),
      "FORBIDDEN_ROLE",
    ],
    [502, "<html>gateway</html>", "INVALID_RESPONSE"],
  ] as const) {
    let expired = 0;
    const mocked = t.mock.method(
      globalThis,
      "fetch",
      async () => new Response(body, { status }),
    );
    await assert.rejects(
      new Api("test-token", () => expired++).session(),
      (e: unknown) => e instanceof ApiError && e.code === code,
    );
    mocked.mock.restore();
    assert.equal(expired, 0);
  }
});

test("Non-401 malformed POST retains uncertain-write semantics without expiring auth", async (t) => {
  const { Api } = await import("../src/api.ts");
  let expired = 0;
  t.mock.method(
    globalThis,
    "fetch",
    async () => new Response("<html>gateway</html>", { status: 502 }),
  );
  await assert.rejects(
    new Api("test-token", () => expired++).logout(),
    (e: unknown) => e instanceof ApiError && e.code === "NETWORK",
  );
  assert.equal(expired, 0);
});
