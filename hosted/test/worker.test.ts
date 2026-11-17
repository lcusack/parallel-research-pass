import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import worker from '../src/worker.ts';

const origin = 'https://demo.example';
const env = { APP_ORIGIN: origin, ASSETS: { fetch: async () => new Response('<!doctype html><title>Research Pass</title>') } } as unknown as Env;

test('unconfigured public backend fails closed before sessions, identity, or payment', async () => {
  for (const path of ['/api/session', '/api/status', '/api/research', '/api/agent/status', '/api/agent/research', '/world/device', '/world/token', '/.well-known/jwks.json']) {
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

test('configured hosted sessions set a secure cookie, round-trip encrypted storage, and reject anonymous research', async () => {
  const db = new DatabaseSync(':memory:');
  const signing = await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify']);
  assert.ok('privateKey' in signing && 'publicKey' in signing);
  const configured = {
    ...env, STATE_KEY: randomBytes(32).toString('base64'),
    WORLD_ID_CLIENT_ID: 'fixture', WORLD_ID_CLIENT_SECRET: 'fixture', WORLD_ID_CLIENT_AUTH: 'client_secret_basic', WORLD_ID_ISSUER: 'https://auth.world.org',
    SPONSOR_PRIVATE_KEY: 'fixture', SPONSOR_CALL_CAP: '90',
    ATTESTATION_PRIVATE_JWK: JSON.stringify(await crypto.subtle.exportKey('jwk', signing.privateKey)),
    ATTESTATION_PUBLIC_JWK: JSON.stringify(await crypto.subtle.exportKey('jwk', signing.publicKey)),
    DB: { prepare: (sql: string) => ({ bind: (...args: (string | number | null)[]) => ({ all: async () => ({ results: db.prepare(sql).all(...args) }) }) }) },
  } as unknown as Env;
  try {
    const created = await worker.fetch(new Request(origin + '/api/session'), configured);
    assert.equal(created.status, 200);
    const header = created.headers.get('set-cookie');
    assert.match(header ?? '', /^__Host-research_pass=[a-f0-9]{64}; Path=\/; HttpOnly; Secure; SameSite=Lax/);
    const cookie = header!.split(';')[0];
    const status = await worker.fetch(new Request(origin + '/api/status', { headers: { cookie } }), configured);
    assert.equal(status.status, 200);
    assert.equal((await status.json() as { verified: boolean }).verified, false);
    const research = await worker.fetch(new Request(origin + '/api/research', { method: 'POST', headers: { origin, cookie }, body: '{}' }), configured);
    assert.equal(research.status, 401);
    assert.equal((await research.json() as { error: string }).error, 'verification_required');
    const records = JSON.stringify(db.prepare('SELECT key, value FROM mppx_store').all());
    assert.equal(records.includes(cookie.slice(cookie.indexOf('=') + 1)), false);
    assert.equal(records.includes('expires'), false);
    const missing = await worker.fetch(new Request(origin + '/api/status'), configured);
    assert.equal(missing.status, 401);
  } finally { db.close(); }
});
