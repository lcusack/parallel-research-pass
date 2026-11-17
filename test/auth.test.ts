import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { World, Attestation } from 'mppx/extensions/identity';
import { generateKeyPair, exportJWK, SignJWT } from 'jose';
import { createApp, authorized } from '../src/app.ts';
import type { Settings } from '../src/config.ts';
import { State } from '../src/state.ts';
import { ResearchService, type ResearchResult } from '../src/research.ts';
import { acceptedAcr } from '../src/policy.ts';

async function fixture() {
  const key = await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify']) as CryptoKeyPair;
  const settings: Settings = { origin: 'http://127.0.0.1:8791', worldIssuer: 'https://auth.world.org', token: randomBytes(32).toString('hex'), encryptionKey: randomBytes(32).toString('base64'), privateKey: {}, publicKey: {} };
  const state = new State(':memory:', settings.encryptionKey);
  const issuer = World.Issuer.create({ url: settings.origin, clientId: 'test-client', clientSecret: 'test-secret', acr: acceptedAcr, signingKey: key, secretKey: settings.encryptionKey, store: state.atomicStore(), audiences: [settings.origin], authorize: req => authorized(req, settings.token) });
  let calls = 0;
  const result: ResearchResult = { answer: 'Test answer', citations: [], payment: { status: 'confirmed', maxSpendUsd: '0.01', currency: 'USDC.e', network: 'tempo', receipt: 'fixture' } };
  const handle = createApp({ settings, state, issuer, research: new ResearchService(state, 10, async () => { calls++; return result; }) });
  const token = (overrides: Record<string, unknown> = {}, signing = key) => Attestation.sign({ iss: settings.origin, aud: settings.origin, sub: 'human-a', type: 'world-id', acr: World.Constants.acr.selfie, iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 3600, jti: randomUUID(), ...overrides }, { key: signing });
  const request = (proof?: string, auth = true) => new Request(`${settings.origin}/api/research`, { method: 'POST', headers: { 'content-type': 'application/json', ...(auth && { authorization: `Bearer ${settings.token}` }), ...(proof && { 'Identity-Attestation': proof }) }, body: JSON.stringify({ question: 'What does Parallel do?', requestId: randomUUID() }) });
  return { key, settings, state, issuer, handle, token, request, calls: () => calls };
}

test('a local API token alone cannot unlock sponsored research', async () => {
  const f = await fixture();
  assert.equal((await f.handle(f.request())).status, 401);
  assert.equal((await f.handle(f.request(await f.token(), false))).status, 401);
  assert.equal(f.calls(), 0);
  f.state.close();
});

test('valid signed Selfie Check attestations unlock research and fresh tokens share one allowance', async () => {
  const f = await fixture();
  const one = await f.handle(f.request(await f.token()));
  const two = await f.handle(f.request(await f.token()));
  assert.equal(one.status, 200);
  assert.equal(two.status, 200);
  assert.equal((await two.json()).allowance.remaining, 8);
  assert.equal(f.calls(), 2);
  f.state.close();
});

test('reject expired, wrong-audience, wrong-issuer, wrong-type, unverified, and forged proofs before payment', async () => {
  const f = await fixture();
  const otherKey = await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify']) as CryptoKeyPair;
  for (const token of [
    await f.token({ exp: Math.floor(Date.now() / 1000) - 1 }),
    await f.token({ aud: 'https://other.example' }),
    await f.token({ iss: 'https://other.example' }),
    await f.token({ type: 'email' }),
    await f.token({ acr: undefined }),
    await f.token({}, otherKey),
  ]) assert.ok([401, 403].includes((await f.handle(f.request(token))).status));
  assert.equal(f.calls(), 0);
  f.state.close();
});

test('Selfie Check with Face Auth and stronger Orb credentials also satisfy the minimum level', async () => {
  const f = await fixture();
  for (const acr of [World.Constants.acr.selfieFace, World.Constants.acr.orb, World.Constants.acr.orbFace]) {
    const response = await f.handle(f.request(await f.token({ acr })));
    assert.equal(response.status, 200);
  }
  assert.equal(f.calls(), 3);
  f.state.close();
});

test('unconfigured credentials return setup_required and never grant test access', async () => {
  const f = await fixture();
  const handle = createApp({ settings: f.settings, state: f.state, issuer: null, research: new ResearchService(f.state, 10, async () => { throw new Error('must not pay'); }) });
  const response = await handle(f.request());
  assert.equal(response.status, 503);
  assert.equal((await response.json()).error, 'world_id_setup_required');
  f.state.close();
});

test('real MPP issuer device flow validates an RS256 World token before minting an attestation', async () => {
  const f = await fixture();
  const rsa = await generateKeyPair('RS256', { extractable: true });
  const jwk = { ...await exportJWK(rsa.publicKey), kid: 'world-test', alg: 'RS256' };
  let polls = 0;
  const fetcher: typeof fetch = async input => {
    const req = input instanceof Request ? input : new Request(input);
    const path = new URL(req.url).pathname;
    if (path === '/.well-known/openid-configuration') return Response.json({ issuer: 'https://auth.world.org', device_authorization_endpoint: 'https://auth.world.org/device', token_endpoint: 'https://auth.world.org/token', jwks_uri: 'https://auth.world.org/keys' });
    if (path === '/device') return Response.json({ device_code: 'private-fixture-code', user_code: 'ABCD-EFGH', verification_uri: 'https://auth.world.org/approve', verification_uri_complete: 'https://auth.world.org/approve?code=ABCD-EFGH', expires_in: 60, interval: 1 });
    if (path === '/keys') return Response.json({ keys: [jwk] });
    if (path === '/token') {
      polls++;
      const token = await new SignJWT({ acr: World.Constants.acr.selfie, amr: ['world_id'], auth_time: Math.floor(Date.now() / 1000) }).setProtectedHeader({ alg: 'RS256', kid: 'world-test' }).setIssuer('https://auth.world.org').setAudience('test-client').setSubject('private-world-subject').setIssuedAt().setExpirationTime('5m').sign(rsa.privateKey);
      return Response.json({ id_token: token });
    }
    throw new Error('Unexpected fixture URL');
  };
  // Adapt RequestInit too; World IdP calls fetch(url, init).
  const issuer = World.Issuer.create({ url: f.settings.origin, clientId: 'test-client', clientSecret: 'test-secret', acr: acceptedAcr, signingKey: f.key, secretKey: f.settings.encryptionKey, store: f.state.atomicStore(), audiences: [f.settings.origin], fetch: (input, init) => fetcher(new Request(input, init)) });
  const handle = createApp({ settings: f.settings, state: f.state, issuer, research: new ResearchService(f.state, 10, async () => { throw new Error('No paid call in this test'); }) });
  const appFetch: typeof fetch = (input, init) => {
    const req = new Request(input, init); req.headers.set('authorization', `Bearer ${f.settings.token}`); return handle(req);
  };
  const device = await World.Client.startDevice({ issuer: f.settings.origin, audience: f.settings.origin, fetch: appFetch });
  assert.equal(device.userCode, 'ABCD-EFGH');
  assert.equal(JSON.stringify(device).includes('private-fixture-code'), false);
  assert.equal(polls, 0);
  await new Promise(resolve => setTimeout(resolve, 1050));
  const approval = await World.Client.pollDevice({ issuer: f.settings.origin, id: device.id, fetch: appFetch });
  assert.equal(approval.status, 'approved');
  if (approval.status !== 'approved') throw new Error('Expected approval');
  const response = await handle(new Request(`${f.settings.origin}/api/status`, { headers: { authorization: `Bearer ${f.settings.token}`, 'Identity-Attestation': approval.attestation } }));
  assert.equal(response.status, 200);
  const status = await response.json();
  assert.equal(status.verified, true);
  assert.equal(JSON.stringify(status).includes('private-world-subject'), false);
  f.state.close();
});
