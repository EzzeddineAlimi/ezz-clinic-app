import { test } from "node:test";
import { strict as assert } from "node:assert";
import { clinicInstant, shiftDay } from "../src/time.ts";

// Pure booking-calendar regression tests. All examples are fictional; no patient data.
// clinicInstant must resolve in the clinic's IANA zone, not the receptionist's device zone.
test("Tunisia booking uses clinic wall time, not device-local time", () => {
  assert.equal(clinicInstant("2026-10-30", "09:15", "Africa/Tunis"), "2026-10-30T08:15:00.000Z");
  assert.equal(clinicInstant("2026-01-15", "09:15", "Africa/Tunis"), "2026-01-15T08:15:00.000Z");
});

test("Toronto booking distinguishes winter and summer offsets", () => {
  assert.equal(clinicInstant("2026-01-15", "09:15", "America/Toronto"), "2026-01-15T14:15:00.000Z");
  assert.equal(clinicInstant("2026-07-01", "09:15", "America/Toronto"), "2026-07-01T13:15:00.000Z");
});

test("spring-forward nonexistent booking time fails closed; adjacent hours resolve", () => {
  assert.equal(clinicInstant("2026-03-08", "01:30", "America/Toronto"), "2026-03-08T06:30:00.000Z");
  assert.throws(() => clinicInstant("2026-03-08", "02:30", "America/Toronto"), { message: "AMBIGUOUS_TIME" });
  assert.equal(clinicInstant("2026-03-08", "03:30", "America/Toronto"), "2026-03-08T07:30:00.000Z");
});

test("fall-back repeated booking time fails closed; unambiguous next hour resolves", () => {
  assert.throws(() => clinicInstant("2026-11-01", "01:30", "America/Toronto"), { message: "AMBIGUOUS_TIME" });
  assert.equal(clinicInstant("2026-11-01", "02:30", "America/Toronto"), "2026-11-01T07:30:00.000Z");
});

test("invalid calendar days and clock input are rejected instead of normalized", () => {
  for (const [day, time] of [
    ["2026-02-29", "09:00"], ["2026-04-31", "09:00"],
    ["2026-10-30", "24:00"], ["2026-10-30", "09:60"],
    ["2026-10-30", "9:05"], ["30/10/2026", "09:00"],
  ] as const) {
    assert.throws(() => clinicInstant(day, time, "Africa/Tunis"), { message: "INVALID_TIME" });
  }
  assert.equal(clinicInstant("2024-02-29", "09:00", "Africa/Tunis"), "2024-02-29T08:00:00.000Z");
});

test("non-hour timezone offsets are resolved exactly, not rounded", () => {
  assert.equal(clinicInstant("2026-10-30", "09:15", "Asia/Kathmandu"), "2026-10-30T03:30:00.000Z");
});

test("calendar day navigation preserves leap day and year rollover", () => {
  assert.equal(shiftDay("2024-02-28", 1), "2024-02-29");
  assert.equal(shiftDay("2024-02-29", 1), "2024-03-01");
  assert.equal(shiftDay("2026-01-01", -1), "2025-12-31");
  assert.equal(shiftDay("2026-12-31", 1), "2027-01-01");
});
