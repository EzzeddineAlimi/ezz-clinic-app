import assert from "node:assert/strict";
import test from "node:test";
import { clinicPaymentTime } from "../src/time.ts";

test("payment history follows the clinic zone, not the browser zone", () => {
  const instant = "2026-01-15T12:34:00Z";
  const tunis = clinicPaymentTime(instant, "fr", "Africa/Tunis");
  const toronto = clinicPaymentTime(instant, "fr", "America/Toronto");
  assert.match(tunis, /13:34/);
  assert.match(toronto, /07:34/);
  assert.notEqual(tunis, toronto);
  assert.equal(clinicPaymentTime("invalid", "fr", "Africa/Tunis"), "—");
});

test("Arabic payment timestamps retain Latin numerals and the selected zone", () => {
  const shown = clinicPaymentTime("2026-01-15T12:34:00Z", "ar", "Africa/Tunis");
  assert.match(shown, /13:34/);
  assert.doesNotMatch(shown, /[٠-٩]/);
});
