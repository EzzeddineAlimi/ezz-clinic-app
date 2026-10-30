import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validate } from './check.mjs';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
const data=JSON.parse(readFileSync(join(root,'docs/harness/scenarios.json'),'utf8'));
const copy=()=>structuredClone(data);

test('existing referenced positive and negative test declarations are verifiable',()=>{
  const result=validate(data);
  assert.equal(result.valid,true,result.errors.join('\n'));
  assert.equal(result.testsExecuted,false);
  assert.equal(result.v1Accepted,0);
  assert.equal(result.humanTrials,0);
});
test('rejects stale or invented source test titles',()=>{
  const d=copy();d.scenarios[0].refs[0].title='This test title does not exist in the source';
  assert.equal(validate(d).valid,false);
});
test('rejects file path traversal',()=>{
  const d=copy();d.scenarios[0].refs[0].file='../../.env';
  assert.equal(validate(d).valid,false);
});
test('rejects fake acceptance and fabricated human trials',()=>{
  const d=copy();d.scenarios[0].v1Status='ACCEPTED';d.scenarios[0].humanTrials=9;
  assert.equal(validate(d).valid,false);
});
test('rejects missing negative cases and duplicate scenarios',()=>{
  const d=copy();d.scenarios[0].refs=d.scenarios[0].refs.filter(x=>x.kind==='positive');
  d.scenarios[1].id=d.scenarios[0].id;
  assert.equal(validate(d).valid,false);
});
