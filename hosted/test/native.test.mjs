import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { generateKeyPair, exportJWK, SignJWT } from 'jose';
import * as World from 'mppx/extensions/identity/world';
import * as Attestation from 'mppx/extensions/identity/attestation';
import { createWorker } from '../src/worker.ts';
import { encryptedStore, opaqueId } from '../src/store.ts';
import { createNativePass } from '../../bin/native-pass.mjs';

const origin = 'https://demo.example';
async function fixture() {
  const db = new DatabaseSync(':memory:');
  const keys = await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify']);
  const rsa = await generateKeyPair('RS256', { extractable: true });
  const jwk = { ...await exportJWK(rsa.publicKey), kid: 'world-test', alg: 'RS256' };
  const env = {
    APP_ORIGIN: origin, ASSETS: { fetch: async () => new Response('static') },
    STATE_KEY: randomBytes(32).toString('base64'), WORLD_ID_CLIENT_ID: 'fixture-client',
    WORLD_ID_CLIENT_SECRET: 'fixture', WORLD_ID_CLIENT_AUTH: 'client_secret_basic',
    WORLD_ID_ISSUER: 'https://auth.world.org', SPONSOR_PRIVATE_KEY: 'fixture', SPONSOR_CALL_CAP: '90',
    ATTESTATION_PRIVATE_JWK: JSON.stringify(await crypto.subtle.exportKey('jwk', keys.privateKey)),
    ATTESTATION_PUBLIC_JWK: JSON.stringify(await crypto.subtle.exportKey('jwk', keys.publicKey)),
    DB: { prepare: sql => ({ bind: (...args) => ({ all: async () => ({ results: db.prepare(sql).all(...args) }) }) }) },
  };
  let polls = 0, payments = 0, devices = 0;
  const worldFetch = async (input, init) => {
    const request = new Request(input, init);
    assert.equal(new URL(request.url).origin, env.WORLD_ID_ISSUER);
    const path = new URL(request.url).pathname;
    if (path === '/.well-known/openid-configuration') return Response.json({ issuer: env.WORLD_ID_ISSUER, device_authorization_endpoint: env.WORLD_ID_ISSUER + '/device', token_endpoint: env.WORLD_ID_ISSUER + '/token', jwks_uri: env.WORLD_ID_ISSUER + '/keys' });
    if (path === '/device') {
      devices++;
      return Response.json({ device_code: 'private-device-fixture', user_code: 'ABCD-EFGH', verification_uri: env.WORLD_ID_ISSUER + '/approve', expires_in: 30, interval: 1 });
    }
    if (path === '/keys') return Response.json({ keys: [jwk] });
    if (path === '/token') {
      polls++;
      if (polls === 1) return Response.json({ error: 'authorization_pending' }, { status: 400 });
      const idToken = await new SignJWT({ acr: World.Constants.acr.selfie, amr: ['world_id'], auth_time: Math.floor(Date.now() / 1000) }).setProtectedHeader({ alg: 'RS256', kid: jwk.kid }).setIssuer(env.WORLD_ID_ISSUER).setAudience(env.WORLD_ID_CLIENT_ID).setSubject('private-world-subject').setIssuedAt().setExpirationTime('5m').sign(rsa.privateKey);
      return Response.json({ id_token: idToken });
    }
    throw new Error('Unexpected World fixture path');
  };
  const app = createWorker({ worldFetch, pay: async () => {
    payments++;
    return { answer: 'Fixture research answer', citations: [], payment: { status: 'confirmed', receipt: 'fixture', transaction: '0xfixture' } };
  } });
  const traces = [];
  const fetch = async (input, init) => {
    const request = new Request(input, init);
    const response = await app.fetch(request, env);
    traces.push({ path: new URL(request.url).pathname, method: request.method, proof: request.headers.has('identity-attestation'), cookie: request.headers.has('cookie'), status: response.status, challenge: response.headers.get('identity-attestation-required') });
    return response;
  };
  const sign = overrides => Attestation.sign({ iss: origin, aud: origin, sub: 'fixture-human', type: 'world-id', acr: World.Constants.acr.selfie, iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 3600, jti: randomUUID(), ...overrides }, { key: keys });
  return { db, env, keys, fetch, sign, traces, counts: () => ({ payments, polls, devices }) };
}

test('native identity gate returns SDK challenges and rejects bad proofs before any payment', async () => {
  const f = await fixture();
  try {
    for (const path of ['/api/agent/status', '/api/agent/research']) {
      const response = await f.fetch(origin + path, { method: path.endsWith('research') ? 'POST' : 'GET' });
      assert.equal(response.status, 401);
      assert.equal(response.headers.get('identity-attestation-required'), `world-id;issuer="${origin}"`);
      assert.equal(response.headers.get('set-cookie'), null);
    }
    for (const overrides of [{ exp: 1 }, { aud: 'https://other.example' }, { iss: 'https://other.example' }, { type: 'email' }]) {
      const response = await f.fetch(origin + '/api/agent/research', { method: 'POST', headers: { 'identity-attestation': await f.sign(overrides) }, body: '{}' });
      assert.equal(response.status, 401);
      assert.ok(response.headers.get('identity-attestation-required'));
    }
    const forbidden = await f.fetch(origin + '/api/agent/status', { headers: { 'identity-attestation': await f.sign({ acr: 'unverified' }) } });
    assert.equal(forbidden.status, 403);
    assert.equal(forbidden.headers.get('identity-attestation-required'), null);
    const jwks = await f.fetch(origin + '/.well-known/jwks.json');
    assert.equal(jwks.status, 200);
    const publicKeys = JSON.stringify(await jwks.json());
    assert.equal(publicKeys.includes('"d":'), false);
    assert.equal(f.counts().payments, 0);
  } finally { f.db.close(); }
});

test('native World prover completes the wire challenge, caches privately, shares browser quota, and replays without paying', async () => {
  const f = await fixture();
  try {
    let credential;
    const client = createNativePass({ origin, fetch: f.fetch, onAttestation: value => { credential = value; } });
    assert.equal((await client.allowance()).verified, false);
    await assert.rejects(client.research('What does Parallel do?', randomUUID()), { code: 'verification_required' });
    assert.equal(f.counts().devices, 0, 'passive tools must not launch approval');
    const [approval, concurrent] = await Promise.all([client.verify(), client.verify()]);
    assert.deepEqual(approval, concurrent);
    assert.equal(approval.status, 'approval_required');
    assert.equal(approval.userCode, 'ABCD-EFGH');
    assert.equal(f.counts().devices, 1);
    assert.equal(f.counts().payments, 0);
    assert.equal(JSON.stringify(approval).includes('private-'), false);
    for (let i = 0; i < 80 && !(await client.check()).verified; i++) await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal((await client.check()).verified, true);
    assert.ok(credential);
    assert.equal(f.counts().polls, 2, 'SDK polls pending approval and retries');
    const requestId = randomUUID(), question = 'What does Parallel do?';
    const answer = await client.research(question, requestId);
    assert.equal(answer.reused, false);
    assert.equal(answer.allowance.remaining, 9);
    const replay = await client.research(question, requestId);
    assert.equal(replay.reused, true);
    assert.equal(replay.allowance.remaining, 9);
    assert.equal(f.counts().payments, 1);
    await assert.rejects(client.research('Different question', requestId), { code: 'request_conflict' });
    const restarted = createNativePass({ origin, fetch: f.fetch, attestation: credential });
    assert.equal((await restarted.verify()).allowance.remaining, 9);
    assert.equal(f.counts().devices, 1, 'accepted attestation is reused after restart');
    const secondProfile = createNativePass({ origin, fetch: f.fetch });
    assert.equal((await secondProfile.verify()).status, 'approval_required');
    for (let i = 0; i < 60 && !(await secondProfile.check()).verified; i++) await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal((await secondProfile.allowance()).allowance.remaining, 9, 'a fresh approval resolves to the same existing account quota');
    // A browser session holding the same issuer credential resolves to the existing account ledger.
    const cookie = 'a'.repeat(64);
    const store = encryptedStore(f.env.DB, f.env.STATE_KEY);
    await store.put(`session:${opaqueId(f.env.STATE_KEY, cookie)}`, { expires: Date.now() + 60000, attestation: credential });
    const browser = await f.fetch(origin + '/api/research', { method: 'POST', headers: { origin, cookie: '__Host-research_pass=' + cookie }, body: JSON.stringify({ question, requestId }) });
    assert.equal((await browser.json()).reused, true);
    assert.equal(f.counts().payments, 1);
    f.env.SPONSOR_CALL_CAP = '1';
    await assert.rejects(client.research('A new question', randomUUID()), { code: 'sponsor_budget_exhausted' });
    assert.equal(f.counts().payments, 1, 'exhausted sponsorship never falls back to caller payment');
    const nativeOnlyCookie = await f.fetch(origin + '/api/agent/status', { headers: { cookie: '__Host-research_pass=' + cookie } });
    assert.equal(nativeOnlyCookie.status, 401, 'native gate must not accept ambient browser cookies');
    assert.ok(f.traces.some(t => t.path === '/api/agent/status' && t.status === 401 && t.challenge));
    assert.ok(f.traces.some(t => t.path === '/api/agent/status' && t.proof && t.status === 200 && !t.cookie));
    assert.ok(f.traces.some(t => t.path === '/api/agent/research' && t.proof && t.status === 200 && !t.cookie));
    const disk = JSON.stringify(f.db.prepare('SELECT key, value FROM mppx_store').all());
    for (const privateValue of ['private-world-subject', 'private-device-fixture', credential]) assert.equal(disk.includes(privateValue), false);
  } finally { f.db.close(); }
});

test('native client refuses redirects and untrusted issuer challenges without sending credentials or starting approval', async () => {
  let calls = 0;
  const redirected = createNativePass({ origin, fetch: async request => {
    calls++;
    assert.equal(new URL(request.url).origin, origin);
    return new Response(null, { status: 307, headers: { location: 'https://attacker.example/collect' } });
  } });
  await assert.rejects(redirected.allowance(), /refused a redirect/);
  assert.equal(calls, 1);
  calls = 0;
  const untrusted = createNativePass({ origin, fetch: async request => {
    calls++;
    assert.equal(new URL(request.url).origin, origin);
    assert.equal(request.headers.has('identity-attestation'), false);
    return Response.json({ error: 'identity_missing' }, { status: 401, headers: { 'identity-attestation-required': 'world-id;issuer="https://attacker.example"' } });
  } });
  await assert.rejects(untrusted.verify(), { code: 'verification_ended' });
  assert.equal(calls, 1, 'the prover never calls an untrusted issuer');
});

test('a nearly expired cached proof requires explicit renewal without silently starting a device attempt or payment', async () => {
  const f = await fixture();
  try {
    const now = Math.floor(Date.now() / 1000);
    const client = createNativePass({ origin, fetch: f.fetch, attestation: await f.sign({ iat: now - 3590, exp: now + 10 }) });
    assert.equal((await client.allowance()).verified, true);
    await assert.rejects(client.research('What does Parallel do?', randomUUID()), { code: 'verification_required' });
    assert.deepEqual(f.counts(), { payments: 0, polls: 0, devices: 0 });
    assert.equal((await client.verify()).status, 'approval_required', 'explicit approval can begin immediately, without a cached decline');
    for (let i = 0; i < 60 && !(await client.check()).verified; i++) await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal((await client.check()).verified, true);
    assert.equal(f.counts().payments, 0);
  } finally { f.db.close(); }
});

test('public issuer is audience-pinned, rate-limited, and rejects foreign browser origins', async () => {
  const f = await fixture();
  try {
    const badAudience = await f.fetch(origin + '/world/device', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ audience: 'https://attacker.example' }) });
    assert.equal(badAudience.ok, false);
    assert.equal(f.counts().devices, 0);
    for (const path of ['/world/device', '/world/token', '/api/agent/research']) {
      const foreign = await f.fetch(origin + path, { method: 'POST', headers: { origin: 'https://attacker.example' }, body: '{}' });
      assert.equal(foreign.status, 403);
    }
    for (let i = 0; i < 8; i++) {
      const device = await f.fetch(origin + '/world/device', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ audience: origin }) });
      assert.equal(device.status, 200);
    }
    const blocked = await f.fetch(origin + '/world/device', { method: 'POST', body: JSON.stringify({ audience: origin }) });
    assert.equal(blocked.status, 429);
    assert.equal(f.counts().devices, 8);
    assert.equal(f.counts().payments, 0);
  } finally { f.db.close(); }
});
