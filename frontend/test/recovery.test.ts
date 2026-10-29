import { test } from "node:test";
import { strict as assert } from "node:assert";
import { cancelledIntentSchema, historyMatchesRecovery, recoverySchema } from "../src/recovery.ts";

const a = "11111111-1111-4111-8111-111111111111";
const b = "22222222-2222-4222-8222-222222222222";
const data = {
  balance: {
    visitId: "33333333-3333-4333-8333-333333333333",
    chargedMillimes: 100000,
    paidMillimes: 30000,
    reducedMillimes: 0,
    returnedMillimes: 0,
    balanceMillimes: 70000,
    careConfirmed: true,
  },
  recoveryVersion: "a".repeat(64),
  paymentIds: [a, b],
  intentions: [],
  automaticRetry: false,
};
test("history acknowledgement compares unique server payment IDs, not display order", () => {
  const recovery = recoverySchema.parse(data);
  assert.equal(historyMatchesRecovery(recovery, [{ id: b }, { id: a }]), true);
  assert.equal(historyMatchesRecovery(recovery, [{ id: a }]), false);
  assert.equal(historyMatchesRecovery(recovery, [{ id: b }, { id: b }]), false);
});
test("never accept automatic payment retry or malformed recovery versions", () => {
  assert.equal(recoverySchema.safeParse({ ...data, automaticRetry: true }).success, false);
  assert.equal(recoverySchema.safeParse({ ...data, recoveryVersion: "local-hash" }).success, false);
});
test("idempotent cancellation may omit paymentRecorded when already resolved", () => {
  assert.equal(cancelledIntentSchema.safeParse({ status: "CANCELLED", recovered: true }).success, true);
});
