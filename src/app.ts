import { timingSafeEqual } from 'node:crypto';
import { World } from 'mppx/extensions/identity';
import type { State } from './state.ts';
import type { Settings } from './config.ts';
import { ResearchError, ResearchInput, ResearchService } from './research.ts';
import { acceptedAcr } from './policy.ts';

type Issuer = ReturnType<typeof World.Issuer.create>;
export function authorized(request: Request, token: string) {
  const actual = Buffer.from(request.headers.get('authorization') ?? '');
  const expected = Buffer.from(`Bearer ${token}`);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function createApp(options: {
  settings: Settings; state: State; issuer: Issuer | null; research: ResearchService;
}) {
  const { settings, issuer, research } = options;
  const verifier = issuer ? World.Server.verifier({
    audience: settings.origin, issuer: issuer.url, keyResolver: issuer.keyResolver,
    acr: acceptedAcr, clockTolerance: 0,
  }) : null;
  return async function handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const json = (value: unknown, status = 200, headers: HeadersInit = {}) => Response.json(value, {
      status, headers: { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...headers },
    });
    if (url.origin !== settings.origin) return json({ error: 'invalid_origin' }, 400);
    if (request.method === 'GET' && url.pathname === '/health') return json({ service: 'Parallel Research Pass', identityConfigured: !!issuer });
    if (!authorized(request, settings.token)) return json({ error: 'unauthorized' }, 401);
    if (!issuer || !verifier) return json({ error: 'world_id_setup_required', message: 'Configure WORLD_ID_CLIENT_ID and WORLD_ID_CLIENT_SECRET in the backend .env, then restart.' }, 503);
    try {
      const identityResponse = await issuer.handle(request.clone());
      if (identityResponse) return identityResponse;
      if (!['/api/status', '/api/research'].includes(url.pathname)) return json({ error: 'not_found' }, 404);
      if (request.method !== (url.pathname === '/api/status' ? 'GET' : 'POST')) return json({ error: 'method_not_allowed' }, 405);
      const verified = await verifier.verify(request);
      if (verified.status !== 'valid') return json({ error: verified.status, message: verified.reason }, verified.status === 'forbidden' ? 403 : verified.status === 'unavailable' ? 503 : 401, verified.headers);
      const { issuer: identityIssuer, subject } = verified.value;
      if (url.pathname === '/api/status') return json({ verified: true, allowance: research.allowance(identityIssuer, subject), paidPriceUsd: '0.01' });
      const text = await request.text();
      if (Buffer.byteLength(text) > 20000) return json({ error: 'request_too_large' }, 413);
      const parsed = ResearchInput.safeParse(JSON.parse(text));
      if (!parsed.success) return json({ error: 'invalid_request', message: 'Provide a question (3–4000 characters) and a UUID requestId.' }, 400);
      return json({ requestId: parsed.data.requestId, ...await research.run(identityIssuer, subject, parsed.data) });
    } catch (error) {
      if (error instanceof ResearchError) return json({ error: error.code, message: error.message }, error.status);
      if (error instanceof SyntaxError) return json({ error: 'invalid_json' }, 400);
      return json({ error: 'service_unavailable', message: 'The request could not be completed. No automatic retry was made.' }, 503);
    }
  };
}
