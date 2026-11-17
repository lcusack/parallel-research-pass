import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { paidAnswer, parseAnswer } from '../src/parallel.ts';

test('preserve answer and citations, rejecting executable source URLs', () => {
  const result = parseAnswer({ output: [{ type: 'message', content: [{ type: 'output_text', text: 'Answer.', annotations: [{ type: 'url_citation', url: 'https://parallel.ai', title: 'Parallel' }, { url: 'javascript:alert(1)' }] }] }] });
  assert.equal(result.answer, 'Answer.');
  assert.deepEqual(result.citations, [{ url: 'https://parallel.ai', title: 'Parallel' }]);
});

test('payment execution pins the endpoint, chain, token, charge intent, retries and one-cent cap', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tempo-fixture-'));
  const executable = join(dir, 'tempo.cjs');
  writeFileSync(executable, `#!/usr/bin/env node
const fs = require('node:fs');
const assert = require('node:assert/strict');
const a = process.argv.slice(2); const flag = n => a[a.indexOf(n) + 1];
if (a[0] === 'wallet') { console.log(JSON.stringify({ready:true})); process.exit(0); }
assert.equal(a[1], 'https://parallelmpp.dev/api/responses');
assert.equal(flag('--max-spend'), '0.01'); assert.equal(flag('--network'), 'mainnet');
assert.equal(flag('--payment-token'), '0x20c000000000000000000000b9537d11c60e8b50');
assert.equal(flag('--payment-intent'), 'charge'); assert.equal(flag('--retries'), '0');
assert.equal(JSON.parse(flag('--json')).reasoning.effort, 'low');
fs.writeFileSync(flag('--output'), JSON.stringify({output_text:'Answer from fixture'}));
fs.writeFileSync(flag('--write-meta'), JSON.stringify({status:200, headers:{'payment-receipt':'settled-fixture'}}));
`, { mode: 0o700 });
  chmodSync(executable, 0o700);
  try {
    const result = await paidAnswer(executable, 'What does Parallel do?');
    assert.equal(result.answer, 'Answer from fixture');
    assert.equal(result.payment.receipt, 'settled-fixture');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
