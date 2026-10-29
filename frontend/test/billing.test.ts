import { test } from "node:test";
import assert from "node:assert/strict";
import { PaymentIntent, tndToMillimes, amount } from "../src/billing.ts";
test("Exact payment millimes, decimal comma and invalid input without rounding", () => {
  for (const [input, value] of [
    ["70.000", 70000],
    ["0,001", 1],
    ["10.12", 10120],
    ["100000", 100000000],
  ] as const)
    assert.equal(tndToMillimes(input), value);
  for (const input of [
    "0",
    "-1",
    "1.0001",
    "1e3",
    "NaN",
    "Infinity",
    "100000.001",
    "01",
    "1,000.000",
    "٧٠",
  ])
    assert.throws(() => tndToMillimes(input));
  assert.equal(amount(70001), "70.001 TND");
});
test("Payment intent never changes body/key after first send, even after a rejection", () => {
  const i = new PaymentIntent(),
    key = i.key;
  const body = i.payload({ amountMillimes: 70000, tender: "CASH" });
  assert.deepEqual(i.payload({ amountMillimes: 1, tender: "CARD" }), body);
  assert.ok(Object.isFrozen(body));
  assert.equal(i.key, key);
  assert.notEqual(new PaymentIntent().key, key);
});
