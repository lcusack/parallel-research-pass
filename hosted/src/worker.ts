import * as World from 'mppx/extensions/identity/world';
import type { Store } from 'mppx';
import { z } from 'zod';
import { acceptedAcr } from '../../src/policy.ts';
import { encryptedStore, opaqueId } from './store.ts';
import { DemoError, LedgerService } from './ledger.ts';
import { researchPayment, type PaidResult } from './payment.ts';

type Pending = { id: string; url: string; userCode: string; expires: number; interval: number; next: number };
type Session = { expires: number; attestation?: string; pending?: Pending; startingUntil?: number };
const inputSchema = z.object({ question: z.string().trim().min(3).max(4000), requestId: z.uuid() });
const cookieName = '__Host-research_pass';
const json = (value: unknown, status = 200, headers: HeadersInit = {}) => {
  const outputHeaders = new Headers(headers);
  outputHeaders.set('cache-control', 'no-store');
  outputHeaders.set('x-content-type-options', 'nosniff');
  return Response.json(value, { status, headers: outputHeaders });
};

async function jsonBody(request: Request) {
  const reader = request.body?.getReader();
  if (!reader) throw new DemoError('invalid_request', 'A JSON request is required.', 400);
  const chunks: Uint8Array[] = []; let size = 0;
  while (true) {
    const { done, value } = await reader.read(); if (done) break;
    size += value.byteLength;
    if (size > 20000) { await reader.cancel(); throw new DemoError('too_large', 'Request is too large.', 413); }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  try { return JSON.parse(new TextDecoder().decode(bytes)); }
  catch { throw new DemoError('invalid_json', 'A JSON request is required.', 400); }
}

async function limit(store: Store.AtomicStore, key: string, max: number, seconds: number) {
  const allowed = await store.update(`rate:${key}`, current => {
    const record = current as { reset: number; count: number } | null;
    const next = record && record.reset > Date.now() ? record : { reset: Date.now() + seconds * 1000, count: 0 };
    if (next.count >= max) return { op: 'noop', result: false };
    next.count++;
    return { op: 'set', value: next, result: true };
  });
  if (!allowed) throw new DemoError('rate_limited', 'Please wait before trying again.', 429);
}

async function signingKey(env: Env): Promise<CryptoKeyPair> {
  const jwk = (serialized: string): JsonWebKey => {
    const value: JsonWebKey = JSON.parse(serialized);
    if (value.kty !== 'OKP' || value.crv !== 'Ed25519') throw new TypeError('Expected an Ed25519 signing key');
    // Node and Workers export different optional JWK `alg` labels for the same curve.
    // The explicit import algorithm and curve validation keep the key pinned to Ed25519.
    delete value.alg;
    return value;
  };
  return {
    privateKey: await crypto.subtle.importKey('jwk', jwk(env.ATTESTATION_PRIVATE_JWK), 'Ed25519', false, ['sign']),
    publicKey: await crypto.subtle.importKey('jwk', jwk(env.ATTESTATION_PUBLIC_JWK), 'Ed25519', true, ['verify']),
  };
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/auth/world/callback') return new Response('Parallel Research Pass uses device verification. Return to your agent or demo page to continue.', { headers: { 'content-type': 'text/plain', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' } });
    if (!url.pathname.startsWith('/api/')) {
      const response = await env.ASSETS.fetch(request);
      const headers = new Headers(response.headers);
      headers.set('content-security-policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; media-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'");
      headers.set('referrer-policy', 'no-referrer');
      headers.set('x-content-type-options', 'nosniff');
      headers.set('permissions-policy', 'camera=(), microphone=(), geolocation=()');
      return new Response(response.body, { status: response.status, headers });
    }
    try {
      if (url.origin !== env.APP_ORIGIN) return json({ error: 'invalid_origin' }, 400);
      if (!['GET', 'POST'].includes(request.method)) return json({ error: 'method_not_allowed' }, 405);
      if (request.method === 'POST' && request.headers.get('origin') !== env.APP_ORIGIN) return json({ error: 'invalid_origin' }, 403);
      if (!env.STATE_KEY || !env.WORLD_ID_CLIENT_SECRET || !env.SPONSOR_PRIVATE_KEY) {
        return json({ error: 'activation_pending', message: 'The public prototype is prepared. Verification and sponsored research will open after hosting setup is complete.' }, 503);
      }
      const store = encryptedStore(env.DB, env.STATE_KEY);
      const ip = opaqueId(env.STATE_KEY, request.headers.get('cf-connecting-ip') ?? 'local');
      const cookie = request.headers.get('cookie')?.split(';').map(s => s.trim()).find(s => s.startsWith(`${cookieName}=`))?.slice(cookieName.length + 1);
      let sessionKey = cookie && /^[a-f0-9]{64}$/.test(cookie) ? `session:${opaqueId(env.STATE_KEY, cookie)}` : null;
      let session = sessionKey ? await store.get(sessionKey) as Session | null : null;
      if (session && session.expires <= Date.now()) session = null;
      if (url.pathname === '/api/session' && request.method === 'GET') {
        const headers = new Headers();
        if (!session) {
          await limit(store, `session:${ip}`, 30, 3600);
          const id = Array.from(crypto.getRandomValues(new Uint8Array(32)), n => n.toString(16).padStart(2, '0')).join('');
          sessionKey = `session:${opaqueId(env.STATE_KEY, id)}`;
          session = { expires: Date.now() + 86400000 };
          await store.put(sessionKey, session);
          headers.set('set-cookie', `${cookieName}=${id}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=86400`);
        }
        return json({ ready: true, sourceUrl: env.SOURCE_URL }, 200, headers);
      }
      if (!session || !sessionKey) return json({ error: 'session_required', message: 'Reload the demo to start a session.' }, 401);
      const key = sessionKey;
      const issuer = World.Issuer.create({
        url: env.APP_ORIGIN, clientId: env.WORLD_ID_CLIENT_ID, clientSecret: env.WORLD_ID_CLIENT_SECRET,
        clientAuthentication: env.WORLD_ID_CLIENT_AUTH, worldIssuer: env.WORLD_ID_ISSUER,
        signingKey: await signingKey(env), secretKey: env.STATE_KEY, store, acr: acceptedAcr,
        audiences: [env.APP_ORIGIN], authorize: () => true,
        limit: { key: () => ip, max: 8, window: 3600 }, ttl: 3600,
      });
      // Issuer routes are called only in process. Device handles never go to browser/model output.
      const issuerFetch: typeof fetch = async (input, init) => {
        const req = new Request(input, init);
        if (new URL(req.url).origin !== env.APP_ORIGIN) throw new Error('Unexpected issuer');
        return await issuer.handle(req) ?? new Response(null, { status: 404 });
      };
      const verifier = World.Server.verifier({ issuer: env.APP_ORIGIN, audience: env.APP_ORIGIN, keyResolver: issuer.keyResolver, acr: acceptedAcr, clockTolerance: 0 });
      const identity = async (value: Session) => {
        if (!value.attestation) return null;
        const result = await verifier.verify(new Request(`${env.APP_ORIGIN}/api/status`, { headers: { 'Identity-Attestation': value.attestation } }));
        if (result.status === 'unavailable') throw new DemoError('identity_unavailable', 'Verification is temporarily unavailable.', 503);
        return result.status === 'valid' ? result.value : null;
      };
      const ledger = new LedgerService(store, Number(env.SPONSOR_CALL_CAP));
      const status = async (value: Session) => {
        const proof = await identity(value);
        if (!proof) return { verified: false, sponsorship: '10 answers per World ID account while the shared demo budget lasts' };
        const account = opaqueId(env.STATE_KEY, JSON.stringify([proof.issuer, proof.subject]));
        return { verified: true, authenticationLevel: proof.acr?.includes('/orb') ? 'Orb' : 'Selfie Check', allowance: await ledger.allowance(account), servicePriceUsd: '0.01' };
      };
      if (url.pathname === '/api/status' && request.method === 'GET') return json(await status(session));
      if (url.pathname === '/api/verify/start' && request.method === 'POST') {
        if (await identity(session)) return json(await status(session));
        await limit(store, `start-global`, 100, 3600);
        const now = Date.now();
        const existing = await store.update(key, current => {
          const value = current as Session;
          if (value.pending && value.pending.expires > now) return { op: 'noop', result: value.pending };
          if (value.startingUntil && value.startingUntil > now) throw new DemoError('starting', 'Verification is starting. Please wait.', 429);
          value.startingUntil = now + 30000;
          return { op: 'set', value, result: null };
        });
        let pending = existing;
        if (!pending) {
          const device = await World.Client.startDevice({ issuer: env.APP_ORIGIN, audience: env.APP_ORIGIN, fetch: issuerFetch });
          const link = device.verificationUriComplete ?? device.verificationUri;
          if (new URL(link).origin !== env.WORLD_ID_ISSUER) throw new Error('Unexpected approval origin');
          pending = { id: device.id, url: link, userCode: device.userCode, expires: device.expiresAt.getTime(), interval: Math.max(1, device.interval), next: now + Math.max(1, device.interval) * 1000 };
          const saved = pending;
          await store.update(key, current => ({ op: 'set', value: { ...(current as Session), pending: saved, startingUntil: undefined }, result: undefined }));
        }
        return json({ status: 'approval_required', url: pending.url, userCode: pending.userCode, expiresAt: new Date(pending.expires).toISOString(), retryAfterSeconds: pending.interval });
      }
      if (url.pathname === '/api/verify/check' && request.method === 'POST') {
        const pending = await store.update<string, Pending | { wait: number } | null>(key, current => {
          const value = current as Session;
          if (!value.pending) return { op: 'noop', result: null };
          if (value.pending.expires <= Date.now()) {
            delete value.pending;
            return { op: 'set', value, result: null };
          }
          if (value.pending.next > Date.now()) return { op: 'noop', result: { wait: Math.ceil((value.pending.next - Date.now()) / 1000) } };
          value.pending.next = Date.now() + value.pending.interval * 1000;
          return { op: 'set', value, result: value.pending };
        });
        if (!pending) return json(await status(await store.get(key) as Session));
        if ('wait' in pending) return json({ status: 'pending', retryAfterSeconds: pending.wait });
        try {
          const result = await World.Client.pollDevice({ issuer: env.APP_ORIGIN, id: pending.id, fetch: issuerFetch });
          if (result.status === 'approved') {
            const value = await store.update(key, current => {
              const value = current as Session;
              value.attestation = result.attestation; delete value.pending;
              return { op: 'set', value, result: value };
            });
            return json(await status(value));
          }
          if (result.status === 'slow_down') await store.update(key, current => {
            const value = current as Session;
            const active = value.pending;
            if (active && active.id === pending.id) { active.interval += 5; active.next = Date.now() + active.interval * 1000; }
            return { op: 'set', value, result: undefined };
          });
          return json({ status: result.status, retryAfterSeconds: pending.interval + (result.status === 'slow_down' ? 5 : 0) });
        } catch {
          await store.update(key, current => { const value = current as Session; delete value.pending; return { op: 'set', value, result: undefined }; });
          throw new DemoError('verification_ended', 'Verification was declined or expired. Start again when ready.', 401);
        }
      }
      if (url.pathname === '/api/research' && request.method === 'POST') {
        const proof = await identity(session);
        if (!proof) throw new DemoError('verification_required', 'Verify with World ID before researching.', 401);
        const parsed = inputSchema.safeParse(await jsonBody(request));
        if (!parsed.success) throw new DemoError('invalid_request', 'Enter a question (3–4000 characters) and a UUID request ID.', 400);
        const { question, requestId } = parsed.data;
        const account = opaqueId(env.STATE_KEY, JSON.stringify([proof.issuer, proof.subject]));
        const jobKey = opaqueId(env.STATE_KEY, JSON.stringify([account, requestId]));
        const fingerprint = opaqueId(env.STATE_KEY, question);
        const reserved = await ledger.reserve(account, jobKey, fingerprint);
        if (reserved === 'cached') {
          const saved = await store.get(`answer:${jobKey}`) as PaidResult | null;
          if (!saved) throw new DemoError('outcome_unknown', 'The saved result is unavailable; do not repay automatically.', 503);
          return json({ ...saved, requestId, reused: true, allowance: await ledger.allowance(account) });
        }
        try {
          const result = await researchPayment(env.SPONSOR_PRIVATE_KEY, question);
          await store.put(`answer:${jobKey}`, result);
          await ledger.finish(jobKey, 'complete');
          return json({ ...result, requestId, reused: false, allowance: await ledger.allowance(account) });
        } catch {
          await ledger.finish(jobKey, 'unknown');
          throw new DemoError('outcome_unknown', 'No confirmed result was returned. This request is held for reconciliation; do not submit it again under a new ID.', 502);
        }
      }
      return json({ error: 'not_found' }, 404);
    } catch (error) {
      if (error instanceof DemoError) return json({ error: error.code, message: error.message }, error.status);
      console.error(JSON.stringify({ event: 'request_failed', path: url.pathname, type: error instanceof Error ? error.name : 'unknown', frames: error instanceof Error ? error.stack?.split('\n').slice(1, 6).map(line => line.trim()) : undefined }));
      return json({ error: 'temporarily_unavailable', message: 'The prototype is temporarily unavailable. Please try again later.' }, 503);
    }
  },
} satisfies ExportedHandler<Env>;
