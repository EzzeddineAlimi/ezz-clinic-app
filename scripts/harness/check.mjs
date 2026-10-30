import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const roles = new Set(['receptionist','dentist','owner','security reviewer']);
const testPath = /^(frontend\/e2e\/[\w.-]+\.spec\.ts|backend\/test\/[\w.-]+\.test\.ts)$/;

export function validate(data, reader = file => readFileSync(join(root,file),'utf8')) {
  const errors=[], ids=new Set();
  if (data?.schemaVersion !== 1 || data?.baseline?.data !== 'FICTIONAL_ONLY' ||
      data?.baseline?.meaning !== 'TEST_SOURCE_REFERENCE_ONLY_NOT_EXECUTION_OR_ACCEPTANCE')
    errors.push('Invalid schema, fictional-only boundary or no-execution disclaimer');
  if (!/^[0-9a-f]{40}$/.test(data?.baseline?.mainSha ?? '')) errors.push('Baseline SHA invalid');
  if (!Array.isArray(data?.scenarios) || data.scenarios.length < 10) errors.push('Too few clinic workflows');
  for (const s of Array.isArray(data?.scenarios) ? data.scenarios : []) {
    const id=s?.id??'undefined';
    if (!/^EVAL-\d{2}$/.test(id) || ids.has(id)) errors.push(id+': duplicate or invalid id');
    ids.add(id);
    if (!roles.has(s?.role)) errors.push(id+': invalid role');
    for (const k of ['task','risk','targetProposal']) if (typeof s?.[k] !== 'string' || s[k].trim().length < 10) errors.push(id+': missing '+k);
    if (s?.humanBaseline !== null || s?.humanTrials !== 0 || s?.humanStatus !== 'NOT_MEASURED' ||
        s?.v1Status !== 'NOT_ACCEPTED' || s?.reviewStatus !== 'PENDING' || s?.exactHeadCi !== null)
      errors.push(id+': fabricated human result, CI, review or V1 acceptance');
    if (!Array.isArray(s?.refs) || !s.refs.some(x=>x.kind==='positive') || !s.refs.some(x=>x.kind==='negative'))
      errors.push(id+': require both positive and negative references');
    for (const r of Array.isArray(s?.refs) ? s.refs : []) {
      if (!testPath.test(r?.file ?? '') || !['positive','negative'].includes(r?.kind)) {
        errors.push(id+': invalid test path/kind');continue;
      }
      if (typeof r?.title !== 'string' || r.title.length < 15) {errors.push(id+': missing test name');continue;}
      try {
        const src=reader(r.file);
        const found=['"', "'"].some(q=>src.includes('test('+q+r.title+q+','));
        if (!found) errors.push(id+': stale test reference '+r.file+' :: '+r.title);
      } catch {errors.push(id+': source test unreadable '+r.file);}
    }
  }
  return {valid:errors.length===0,workflowReferences:data?.scenarios?.length??0,humanTrials:0,v1Accepted:0,testsExecuted:false,errors};
}
if (process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const result=validate(JSON.parse(readFileSync(join(root,'docs/harness/scenarios.json'),'utf8')));
  if (process.argv.includes('--markdown')) {
    console.log('## EZZ harness catalog integrity — NOT a clinic test run');
    console.log('Workflow references: '+result.workflowReferences+'; human task trials: 0; V1 groups accepted by this tool: 0.');
    console.log(result.valid ? 'PASS: exact named test declarations exist. PG16 / Playwright tests NOT run by this job.' : 'FAIL: unsafe or stale catalog references.');
    for (const error of result.errors) console.log('- '+error);
  } else console.log(JSON.stringify(result,null,2));
  if (!result.valid) process.exitCode=1;
}
