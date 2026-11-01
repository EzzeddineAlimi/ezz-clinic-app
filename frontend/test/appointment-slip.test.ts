import { test } from "node:test";
import assert from "node:assert/strict";
import { printableAppointment, assertPrintableUnchanged } from "../src/appointment-slip.ts";
import { ApiError } from "../src/api.ts";
import type { Board, Visit } from "../src/api.ts";

const scheduled: Visit = {
  id: "visit-demo", localTime: "09:15",
  scheduledAt: "2026-10-31T08:15:00Z", durationMin: 30,
  status: "SCHEDULED", dentist: null, flags: [], waitingMinutes: null,
  patient: { id: "patient-demo", fileNo: 3, givenName: "Fictif", familyName: "Test", contactPreference: "IN_PERSON" },
};
function board(visits: Visit[]): Board {
  return { day: "2026-10-31", timezone: "Africa/Tunis", scope: "all",
    summary: { total: visits.length, byStatus: {}, notArrivedPastStart: 0 }, visits };
}
test("U029 prints fresh scheduled time instead of stale row time", () => {
  assert.equal(printableAppointment(board([{ ...scheduled, localTime: "10:30" }]), scheduled.id, scheduled.patient.id).localTime, "10:30");
});
test("U029 fails closed for cancelled, absent, missing, or mismatched-patient visit", () => {
  const samples: Array<{ visits: Visit[]; patientId: string }> = [
    { visits: [{ ...scheduled, status: "CANCELLED" }], patientId: scheduled.patient.id },
    { visits: [{ ...scheduled, status: "NO_SHOW" }], patientId: scheduled.patient.id },
    { visits: [], patientId: scheduled.patient.id },
    { visits: [scheduled], patientId: "different-patient" },
  ];
  for (const item of samples) {
    assert.throws(() => printableAppointment(board(item.visits), scheduled.id, item.patientId),
      (err: unknown) => err instanceof ApiError && err.code === "CONFLICT" && err.status === 409);
  }
});

const prepared = { visit: scheduled, day: "2026-10-31", timezone: "Africa/Tunis" };
test("U029 rechecks the server immediately before printing and rejects a stale card", () => {
  assert.doesNotThrow(() => assertPrintableUnchanged(board([scheduled]), prepared));
  const changed = [
    board([{ ...scheduled, localTime: "10:30" }]),
    board([{ ...scheduled, scheduledAt: "2026-10-31T09:15:00Z" }]),
    board([{ ...scheduled, status: "CANCELLED" }]),
    board([{ ...scheduled, patient: { ...scheduled.patient, id: "another-file" } }]),
    board([]),
    { ...board([scheduled]), day: "2026-11-01" },
    { ...board([scheduled]), timezone: "UTC" },
  ];
  for (const fresh of changed) {
    assert.throws(() => assertPrintableUnchanged(fresh, prepared),
      (err: unknown) => err instanceof ApiError && err.code === "CONFLICT" && err.status === 409);
  }
});
