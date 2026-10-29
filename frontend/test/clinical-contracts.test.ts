import { test } from "node:test";
import { strict as assert } from "node:assert";
import { isValidFdi, nonemptyNote } from "../src/clinical-contracts.ts";

test("FDI validator checks known tooth codes", () => {
  for (const n of [11,18,21,28,31,48,51,55,61,65,71,75,81,85]) assert.equal(isValidFdi(n),true);
  for (const n of [0,10,19,50,56,86,99,12.5,NaN]) assert.equal(isValidFdi(n),false);
});
test("Clinical note requires a meaningful section", () => {
  assert.equal(nonemptyNote({subjective:" ",objective:"",assessment:"",plan:""}),false);
  assert.equal(nonemptyNote({subjective:"",objective:"Example",assessment:"",plan:""}),true);
});
