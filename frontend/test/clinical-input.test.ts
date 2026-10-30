import { test } from "node:test";
import { strict as assert } from "node:assert";
import { findingInput, planInput, statusInput, plannedFeeMillimes } from "../src/clinical-input.ts";

const data = (fields: Record<string,string>) => {
  const f = new FormData();
  for (const [key,value] of Object.entries(fields)) f.append(key,value);
  return f;
};
test("clinical quote is integer millimes, never an accidental payment or rounded amount", () => {
  assert.equal(plannedFeeMillimes("0"),0);
  assert.equal(plannedFeeMillimes("150,500"),150500);
  assert.equal(plannedFeeMillimes("100000.000"),100000000);
  for (const invalid of ["-1","1.0001","1e3","010.000","100000.001"]) {
    assert.throws(() => plannedFeeMillimes(invalid));
  }
});
test("chart finding enforces FDI and bounded condition code before server", () => {
  assert.deepEqual(findingInput(data({kind:"FINDING",toothFdi:"16",conditionCode:"caries",note:"Simulation"})),{
    kind:"FINDING",toothFdi:16,conditionCode:"CARIES",note:"Simulation",
  });
  assert.throws(() => findingInput(data({kind:"FINDING",toothFdi:"19",conditionCode:"CARIES"})));
  assert.throws(() => findingInput(data({kind:"INVALID",toothFdi:"16",conditionCode:"CARIES"})));
});
test("planned treatment stores proposal as quote, no care confirmation or charge", () => {
  const p=planInput(data({procedureCode:"plan01",procedureLabel:"Test",phaseNo:"2",
    toothFdi:"21",estimatedFee:"0",note:"Fictional"}),"11111111-1111-4111-8111-111111111111");
  assert.equal(p.estimatedFeeMillimes,0);
  assert.equal(p.procedureCode,"PLAN01");
  assert.equal(p.toothFdi,21);
  assert.equal("feeMillimes" in p,false);
  assert.throws(() => planInput(data({procedureCode:"X",procedureLabel:"Test",phaseNo:"2"}),"v"));
});
test("status events require reasons for decline/cancel, accept may omit", () => {
  assert.deepEqual(statusInput("ACCEPTED",""),{status:"ACCEPTED"});
  assert.deepEqual(statusInput("DECLINED","  Not wanted "),{status:"DECLINED",reason:"Not wanted"});
  assert.throws(() => statusInput("CANCELLED","No"));
});
