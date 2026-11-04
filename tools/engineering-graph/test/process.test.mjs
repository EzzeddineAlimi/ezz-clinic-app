import test from 'node:test';
import assert from 'node:assert/strict';
import { runProcess } from '../src/process.mjs';

test('failed command preserves stdout evidence for diagnosis', async () => {
  await assert.rejects(
    () => runProcess(process.execPath, [
      '-e', 'process.stdout.write("EXPECTED-FAILURE-EVIDENCE"); process.exitCode = 7;',
    ]),
    /EXPECTED-FAILURE-EVIDENCE/,
  );
});
