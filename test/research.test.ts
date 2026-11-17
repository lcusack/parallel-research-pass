import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { State } from '../src/state.ts';
import { ResearchError, ResearchService, type ResearchResult } from '../src/research.ts';

const key = () => randomBytes(32).toString('base64');
export const answer: ResearchResult = { answer: 'A researched answer.', citations: [{ url: 'https://parallel.ai', title: 'Parallel' }], payment: { status: 'confirmed', maxSpendUsd: '0.01', currency: 'USDC.e', network: 'tempo', receipt: 'fixture-receipt' } };
const input = () => ({ question: 'What does Parallel do?', requestId: randomUUID() });

test('one human shares 10 answers across concurrent sessions; an eleventh never reaches Parallel', async () => {
  const state = new State(':memory:', key());
  let paidCalls = 0;
  const service = new ResearchService(state, 100, async () => { paidCalls++; await new Promise(resolve => setTimeout(resolve, 1)); return answer; });
  const results = await Promise.allSettled(Array.from({ length: 30 }, () => service.run('issuer', 'same-human', input())));
  assert.equal(results.filter(x => x.status === 'fulfilled').length, 10);
  assert.equal(paidCalls, 10);
  assert.deepEqual(service.allowance('issuer', 'same-human'), { total: 10, used: 10, remaining: 0 });
  assert.equal(service.allowance('issuer', 'different-human').remaining, 10);
  state.close();
});

test('the global sponsor cap is shared across humans', async () => {
  const state = new State(':memory:', key());
  let calls = 0;
  const service = new ResearchService(state, 2, async () => { calls++; return answer; });
  await service.run('issuer', 'human-a', input());
  await service.run('issuer', 'human-b', input());
  await assert.rejects(service.run('issuer', 'human-c', input()), { code: 'sponsor_budget_exhausted' });
  assert.equal(calls, 2);
  state.close();
});

test('same request is paid once, cached after restart, and conflicts if its question changes', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'research-state-'));
  const path = join(dir, 'state.sqlite');
  const encryptionKey = key();
  let state = new State(path, encryptionKey);
  let calls = 0;
  let service = new ResearchService(state, 10, async () => { calls++; return answer; });
  const request = input();
  await service.run('issuer', 'human', request);
  state.close();
  state = new State(path, encryptionKey);
  service = new ResearchService(state, 10, async () => { calls++; return answer; });
  const cached = await service.run('issuer', 'human', request);
  assert.equal(cached.reused, true);
  assert.equal(calls, 1);
  await assert.rejects(service.run('issuer', 'human', { ...request, question: 'Different question' }), { code: 'request_conflict' });
  assert.equal(service.allowance('issuer', 'human').used, 1);
  state.close();
  assert.equal(readFileSync(path).includes(Buffer.from('A researched answer.')), false);
  assert.equal(readFileSync(path).includes(Buffer.from('same-human')), false);
  rmSync(dir, { recursive: true, force: true });
});

test('parallel retries of one request cannot duplicate the external payment', async () => {
  const state = new State(':memory:', key());
  let release!: () => void;
  let calls = 0;
  const waiting = new Promise<void>(resolve => { release = resolve; });
  const service = new ResearchService(state, 10, async () => { calls++; await waiting; return answer; });
  const request = input();
  const first = service.run('issuer', 'human', request);
  await assert.rejects(service.run('issuer', 'human', request), { code: 'request_in_progress' });
  release(); await first;
  assert.equal(calls, 1);
  state.close();
});

test('unknown payment outcomes retain the slot and block automatic repayment', async () => {
  const state = new State(':memory:', key());
  let calls = 0;
  const service = new ResearchService(state, 10, async () => { calls++; throw new Error('Connection lost after payment'); });
  const request = input();
  await assert.rejects(service.run('issuer', 'human', request), { code: 'payment_outcome_unknown' });
  await assert.rejects(service.run('issuer', 'human', request), { code: 'payment_outcome_unknown' });
  assert.equal(service.allowance('issuer', 'human').used, 1);
  assert.equal(calls, 1);
  state.close();
});

test('a wallet readiness failure releases the reservation because payment did not start', async () => {
  const state = new State(':memory:', key());
  const service = new ResearchService(state, 10, async () => { throw new ResearchError('payment_not_started', 'Wallet expired'); });
  await assert.rejects(service.run('issuer', 'human', input()), { code: 'payment_not_started' });
  assert.equal(service.allowance('issuer', 'human').used, 0);
  state.close();
});
