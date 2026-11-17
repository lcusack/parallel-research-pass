import { Mppx, Transport } from 'mppx/client';
import * as World from 'mppx/extensions/identity/world';

/** Native MPP identity transport. Only approval links and status cross the MCP boundary. */
export function createNativePass({ origin, fetch: rawFetch = globalThis.fetch, attestation, onAttestation = () => {}, approvalOrigin = 'https://auth.world.org' }) {
  if (new URL(origin).origin !== origin || !origin.startsWith('https://')) throw new Error('Research Pass requires an HTTPS origin.');
  let token = attestation;
  let active;
  let verificationError;
  const transport = async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (url.origin !== origin || !['/api/agent/status', '/api/agent/research', '/world/device', '/world/token'].includes(url.pathname)) throw new Error('Unexpected Research Pass destination.');
    const signal = AbortSignal.any([request.signal, AbortSignal.timeout(url.pathname === '/api/agent/research' ? 95000 : 15000)]);
    const response = await rawFetch(new Request(request, { redirect: 'manual', signal }));
    if (response.status >= 300 && response.status < 400) throw new Error('Research Pass refused a redirect.');
    // Persist only a credential this server has accepted, never the private device handle.
    const accepted = request.headers.get('identity-attestation');
    if (response.ok && url.pathname.startsWith('/api/agent/') && accepted && accepted !== token) {
      onAttestation(accepted);
      token = accepted;
    }
    return response;
  };
  const prover = World.Client.prover({
    scope: [origin], issuers: [origin], attestations: token ? [token] : [], fetch: transport,
    verification({ url, userCode, expiresAt }) {
      if (!active) return false;
      if (new URL(url).origin !== approvalOrigin) throw new Error('Unexpected World ID approval destination.');
      active.notice = { status: 'approval_required', url, userCode, expiresAt: expiresAt.toISOString(), retryAfterSeconds: 5 };
      active.show(active.notice);
    },
  });
  // No payment method is installed here. Only the hosted sponsor can pay Parallel.
  const client = Mppx.create({
    methods: [], identity: [prover], polyfill: false, fetch: transport,
    // The sponsored hop negotiates identity only. Preserve a quota 402 as the
    // service's final response; payment happens solely on the server → Parallel hop.
    transport: { ...Transport.http(), isPaymentRequired: () => false },
  });
  const send = client.fetch;
  async function decode(response) {
    const value = await response.json();
    if (!response.ok) {
      const error = new Error(value.message || `Research Pass answered ${response.status}.`);
      error.code = value.error; throw error;
    }
    return value;
  }
  async function allowance() {
    const response = await transport(origin + '/api/agent/status', { headers: token ? { 'Identity-Attestation': token } : {}, signal: AbortSignal.timeout(15000) });
    if (response.status === 401) return { verified: false, sponsorship: '10 answers per World ID account while the shared demo budget lasts' };
    return decode(response);
  }
  async function verify() {
    if (active) {
      const value = await Promise.race([active.shown, active.completion]);
      if (verificationError) throw verificationError;
      return value;
    }
    verificationError = undefined;
    let show;
    const attempt = { shown: new Promise(resolve => { show = resolve; }), show: value => show(value) };
    active = attempt;
    attempt.completion = (async () => {
      try {
        return await decode(await send(origin + '/api/agent/status'));
      } catch {
        verificationError = new Error('World ID verification ended or is temporarily unavailable. Wait 60 seconds, then run verify_human again.');
        verificationError.code = 'verification_ended';
        return { status: 'verification_ended' };
      } finally {
        if (active === attempt) active = undefined;
      }
    })();
    const value = await Promise.race([attempt.shown, attempt.completion]);
    if (verificationError) throw verificationError;
    return value;
  }
  async function check() {
    if (active) return active.notice ?? { status: 'pending', retryAfterSeconds: 5 };
    if (verificationError) throw verificationError;
    return allowance();
  }
  async function research(question, requestId) {
    if (active || !(await allowance()).verified) {
      const error = new Error('Run verify_human and complete World ID approval before researching.');
      error.code = 'verification_required'; throw error;
    }
    return decode(await send(origin + '/api/agent/research', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ question, requestId }),
      signal: AbortSignal.timeout(95000),
    }));
  }
  return { verify, check, allowance, research };
}
