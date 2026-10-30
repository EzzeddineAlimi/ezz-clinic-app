import { test } from "node:test";
import { strict as assert } from "node:assert";
import {
  parseDrawerMillimes, ownerCashPeriodSchema, submittedCashCountSchema, cashReviewSchema,
} from "../src/cash-contracts.ts";

test("exact TND millimes: zero and comma supported, rounding and overflow rejected", () => {
  assert.equal(parseDrawerMillimes("0"), 0);
  assert.equal(parseDrawerMillimes("0,500"), 500);
  assert.equal(parseDrawerMillimes("125.5"), 125500);
  assert.equal(parseDrawerMillimes("1000000.000"), 1_000_000_000);
  for (const invalid of ["", "-1", "1.0009", "1e3", "1 000", "010", "1000000.001", "1,200.5"]) {
    assert.throws(() => parseDrawerMillimes(invalid), { message: "INVALID_DRAWER_AMOUNT" });
  }
});
test("owner's blind current-period contract cannot carry comparison amounts", () => {
  const period = ownerCashPeriodSchema.parse({
    period: {
      id: "11111111-1111-4111-8111-111111111111", periodNo: 1,
      status: "OPEN", openedAt: "2026-10-29T00:00:00Z",
      countAttempts: 0, blind: true, note: "hidden",
      expectedMillimes: 999000, differenceMillimes: 5000,
    },
  });
  assert.equal("expectedMillimes" in period.period!, false);
  assert.equal("differenceMillimes" in period.period!, false);
  assert.equal(ownerCashPeriodSchema.safeParse({period:{...period.period,blind:false}}).success,false);
});
test("a count response is blind, owner review is only parsed through separate contract", () => {
  const submitted = submittedCashCountSchema.parse({
    count: {
      id: "22222222-2222-4222-8222-222222222222",
      periodId: "11111111-1111-4111-8111-111111111111",
      attemptNo: 1, submittedAt: "2026-10-29T12:00:00Z",
      expectedMillimes: 110000, differenceMillimes: -10000,
    },
    status: "RECORDED_PENDING_OWNER_REVIEW",
  });
  assert.equal("expectedMillimes" in submitted.count, false);
  assert.equal("differenceMillimes" in submitted.count, false);
  assert.equal(cashReviewSchema.safeParse({ period: {}, attempts: [] }).success, false);
});
