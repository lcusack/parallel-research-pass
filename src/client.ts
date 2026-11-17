import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { World } from 'mppx/extensions/identity';
import { State } from './state.ts';
import { config, projectRoot, settings, type Settings } from './config.ts';
import { ResearchError, ResearchInput, type Job } from './research.ts';
import { paidAnswer } from './parallel.ts';

type Pending = { id: string; url: string; userCode: string; expires: number; interval: number; next: number };
type Token = { value: string; expires: number };
export class ResearchClient {
  private constructor(private runtime: Settings, private state: State, private profile: string, private tempo: string) {}
  static async create() {
    const runtime = await settings();
    const env = config();
    return new ResearchClient(runtime, new State(join(projectRoot, 'data/clients.sqlite'), runtime.encryptionKey), env.RESEARCH_PROFILE, env.TEMPO_BIN);
  }
  close() { this.state.close(); }
  private key(suffix: string) { return `client:${this.profile}:${suffix}`; }
  private token() {
    const token = this.state.get<Token>(this.key('token'));
    return token && token.expires > Date.now() ? token.value : undefined;
  }
  private issuerFetch: typeof fetch = async (input, init) => {
    const req = new Request(input, init);
    if (new URL(req.url).origin !== this.runtime.origin) throw new Error('Unexpected identity issuer');
    req.headers.set('authorization', `Bearer ${this.runtime.token}`);
    return fetch(req, { redirect: 'error', signal: AbortSignal.timeout(15000) });
  };
  private async api(path: string, body?: unknown) {
    const headers = new Headers({ authorization: `Bearer ${this.runtime.token}` });
    const token = this.token();
    if (token) headers.set('Identity-Attestation', token);
    if (body) headers.set('content-type', 'application/json');
    const response = await fetch(`${this.runtime.origin}${path}`, {
      method: body ? 'POST' : 'GET', headers, ...(body ? { body: JSON.stringify(body) } : {}),
      redirect: 'error', signal: AbortSignal.timeout(95000),
    });
    const result = await response.json() as Record<string, unknown>;
    if (!response.ok) throw new ResearchError(String(result.error ?? 'request_failed'), String(result.message ?? 'Verification is required.'), response.status);
    return result;
  }
  async status() {
    try { return await this.api('/api/status'); }
    catch (error) {
      if (error instanceof ResearchError && error.status === 401) return { verified: false, next: 'Call verify_human to begin World ID verification.' };
      throw error;
    }
  }
  async verify() {
    const status = await this.status();
    if (status.verified) return status;
    let pending = this.state.get<Pending>(this.key('pending'));
    if (!pending || pending.expires <= Date.now()) {
      const device = await World.Client.startDevice({ issuer: this.runtime.origin, audience: this.runtime.origin, fetch: this.issuerFetch });
      const url = device.verificationUriComplete ?? device.verificationUri;
      // Never show an approval link from an unexpected environment or origin.
      if (new URL(url).origin !== this.runtime.worldIssuer) throw new Error('Unexpected World ID approval origin');
      pending = { id: device.id, url, userCode: device.userCode, expires: device.expiresAt.getTime(), interval: Math.max(1, device.interval), next: Date.now() + Math.max(1, device.interval) * 1000 };
      this.state.put(this.key('pending'), pending);
    }
    return { status: 'approval_required', url: pending.url, userCode: pending.userCode,
      expiresAt: new Date(pending.expires).toISOString(),
      instruction: 'Open this exact link, check that the displayed code matches, and approve with World ID. Then call check_verification.' };
  }
  async check() {
    const pending = this.state.get<Pending>(this.key('pending'));
    if (!pending) return this.status();
    if (pending.expires <= Date.now()) { this.state.delete(this.key('pending')); return { status: 'expired', next: 'Call verify_human to intentionally start again.' }; }
    if (pending.next > Date.now()) return { status: 'pending', retryAfterSeconds: Math.ceil((pending.next - Date.now()) / 1000) };
    pending.next = Date.now() + pending.interval * 1000;
    this.state.put(this.key('pending'), pending);
    try {
      const result = await World.Client.pollDevice({ issuer: this.runtime.origin, id: pending.id, fetch: this.issuerFetch });
      if (result.status === 'approved') {
        this.state.put(this.key('token'), { value: result.attestation, expires: result.expiresAt.getTime() } satisfies Token);
        this.state.delete(this.key('pending'));
        return await this.status();
      }
      if (result.status === 'slow_down') { pending.interval += 5; pending.next = Date.now() + pending.interval * 1000; this.state.put(this.key('pending'), pending); }
      return { status: result.status, retryAfterSeconds: pending.interval };
    } catch (error) {
      this.state.delete(this.key('pending'));
      throw error;
    }
  }
  async research(question: string, requestId: string = randomUUID()) {
    const input = ResearchInput.parse({ question, requestId });
    try { return await this.api('/api/research', input); }
    catch (error) {
      if (error instanceof ResearchError) throw new ResearchError(error.code, `${error.message} Request ID: ${requestId}`, error.status);
      throw new ResearchError('outcome_unknown', `The connection ended. Reuse request ID ${requestId}; do not create a new one for the same operation.`, 502);
    }
  }
  async paidResearch(question: string, requestId: string) {
    const input = ResearchInput.parse({ question, requestId });
    const key = `paid:${requestId}`;
    const fingerprint = this.state.id(input.question);
    const cached = this.state.transaction(() => {
      const job = this.state.get<Job>(key);
      if (job) {
        if (job.fingerprint !== fingerprint) throw new ResearchError('request_conflict', 'This request ID belongs to another question.');
        if (job.status === 'complete') return job.result;
        throw new ResearchError('outcome_unknown', `This paid call already started. Reconcile request ${requestId} before another payment.`);
      }
      this.state.put(key, { fingerprint, status: 'pending' } satisfies Job);
    });
    if (cached) return { requestId, ...cached, reused: true };
    try {
      const result = await paidAnswer(this.tempo, input.question);
      this.state.put(key, { fingerprint, status: 'complete', result } satisfies Job);
      return { requestId, ...result, reused: false, funding: 'caller_tempo_wallet' };
    } catch (error) {
      if (error instanceof ResearchError && error.code === 'payment_not_started') { this.state.delete(key); throw error; }
      this.state.put(key, { fingerprint, status: 'unknown' } satisfies Job);
      throw new ResearchError('outcome_unknown', `No confirmed result. Do not repay automatically. Reconcile request ${requestId}.`, 502);
    }
  }
}
