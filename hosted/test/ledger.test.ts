import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from 'mppx';
import { LedgerService } from '../src/ledger.ts';

test('hosted ledger atomically enforces one active payment, per-account quota, and global cap', async () => {
  const store = Store.memory();
  const ledger = new LedgerService(store, 12);
  await ledger.reserve('account', 'job-0', 'fingerprint');
  await assert.rejects(ledger.reserve('other-account', 'other-job', 'fingerprint'), { code: 'busy' });
  await ledger.finish('job-0', 'complete');
  for (let i = 1; i < 10; i++) { await ledger.reserve('account', `job-${i}`, 'fingerprint'); await ledger.finish(`job-${i}`, 'complete'); }
  assert.equal((await ledger.allowance('account')).remaining, 0);
  await assert.rejects(ledger.reserve('account', 'job-11', 'fingerprint'), { code: 'allowance_exhausted' });
  for (let i = 0; i < 2; i++) { await ledger.reserve('other-account', `other-${i}`, 'fingerprint'); await ledger.finish(`other-${i}`, 'complete'); }
  await assert.rejects(ledger.reserve('third-account', 'third-job', 'fingerprint'), { code: 'sponsor_budget_exhausted' });
});

test('hosted replay is cached, changed input is rejected, and unknown outcomes cannot repay', async () => {
  const ledger = new LedgerService(Store.memory(), 90);
  await ledger.reserve('account', 'job', 'fingerprint');
  await ledger.finish('job', 'complete');
  assert.equal(await ledger.reserve('account', 'job', 'fingerprint'), 'cached');
  await assert.rejects(ledger.reserve('account', 'job', 'changed'), { code: 'request_conflict' });
  await ledger.reserve('account', 'unknown-job', 'fingerprint');
  await ledger.finish('unknown-job', 'unknown');
  await assert.rejects(ledger.reserve('account', 'unknown-job', 'fingerprint'), { code: 'outcome_unknown' });
  assert.equal((await ledger.allowance('account')).used, 2);
});
