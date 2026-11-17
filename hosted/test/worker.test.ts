import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/worker.ts';

const origin = 'https://demo.example';
const env = { APP_ORIGIN: origin, ASSETS: { fetch: async () => new Response('<!doctype html><title>Research Pass</title>') } } as unknown as Env;

test('unconfigured public backend fails closed before sessions, identity, or payment', async () => {
  for (const path of ['/api/session', '/api/status', '/api/research']) {
    const response = await worker.fetch(new Request(origin + path), env);
    assert.equal(response.status, 503);
    assert.equal((await response.json() as { error: string }).error, 'activation_pending');
    assert.equal(response.headers.get('set-cookie'), null);
  }
});

test('public POST routes reject cross-origin requests before using secrets or storage', async () => {
  for (const suppliedOrigin of [null, 'https://attacker.example']) {
    const response = await worker.fetch(new Request(origin + '/api/research', { method: 'POST', headers: suppliedOrigin ? { origin: suppliedOrigin } : {} }), env);
    assert.equal(response.status, 403);
  }
});

test('static public responses retain the browser security policy', async () => {
  const response = await worker.fetch(new Request(origin), env);
  assert.equal(response.status, 200);
  assert.ok(response.headers.get('content-security-policy')?.includes("frame-ancestors 'none'"));
  assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
});
