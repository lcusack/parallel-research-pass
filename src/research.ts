import { z } from 'zod';
import { State } from './state.ts';

export const ResearchInput = z.object({ question: z.string().trim().min(3).max(4000), requestId: z.uuid() });
export const grantSize = 10;
export type ResearchInput = z.infer<typeof ResearchInput>;
export type ResearchResult = {
  answer: string;
  citations: { url: string; title: string }[];
  payment: { status: 'confirmed'; maxSpendUsd: '0.01'; currency: 'USDC.e'; network: 'tempo'; receipt: string };
};
export type Job = { fingerprint: string; status: 'pending' | 'complete' | 'unknown'; result?: ResearchResult };
export class ResearchError extends Error {
  constructor(readonly code: string, message: string, readonly status = 409) { super(message); }
}

export class ResearchService {
  constructor(private state: State, private budgetCents: number, private provider: (question: string) => Promise<ResearchResult>) {}
  private human(issuer: string, subject: string) { return this.state.id(JSON.stringify([issuer, subject])); }
  allowance(issuer: string, subject: string) {
    const used = this.state.get<number>(`allowance:${this.human(issuer, subject)}`) ?? 0;
    return { total: grantSize, used, remaining: Math.max(0, grantSize - used) };
  }
  async run(issuer: string, subject: string, input: ResearchInput) {
    const { question, requestId } = ResearchInput.parse(input);
    const human = this.human(issuer, subject);
    const jobKey = `research:${this.state.id(JSON.stringify([human, requestId]))}`;
    const fingerprint = this.state.id(question);
    const cached = this.state.transaction(() => {
      const job = this.state.get<Job>(jobKey);
      if (job) {
        if (job.fingerprint !== fingerprint) throw new ResearchError('request_conflict', 'This request ID was used for another question.');
        if (job.status === 'complete') return job.result!;
        throw new ResearchError(job.status === 'unknown' ? 'payment_outcome_unknown' : 'request_in_progress', 'This request already started. Do not submit it under a new ID; reconcile its payment first.');
      }
      const used = this.state.get<number>(`allowance:${human}`) ?? 0;
      if (used >= grantSize) throw new ResearchError('allowance_exhausted', 'Your 10 sponsored answers are used. Paid research is $0.01 per answer and requires explicit approval.', 402);
      const spent = this.state.get<number>('sponsor:reserved-cents') ?? 0;
      if (spent >= this.budgetCents) throw new ResearchError('sponsor_budget_exhausted', 'The prototype sponsor budget is exhausted. Paid research is available with explicit approval.', 402);
      this.state.put(`allowance:${human}`, used + 1);
      this.state.put('sponsor:reserved-cents', spent + 1);
      this.state.put(jobKey, { fingerprint, status: 'pending' } satisfies Job);
      return undefined;
    });
    if (cached) return { ...cached, allowance: this.allowance(issuer, subject), reused: true };
    try {
      const result = await this.provider(question);
      if (result.payment.status !== 'confirmed' || !result.payment.receipt) throw new Error('Missing confirmed payment receipt');
      this.state.put(jobKey, { fingerprint, status: 'complete', result } satisfies Job);
      return { ...result, allowance: this.allowance(issuer, subject), reused: false };
    } catch (error) {
      if (error instanceof ResearchError && error.code === 'payment_not_started') {
        this.state.transaction(() => {
          this.state.put(`allowance:${human}`, (this.state.get<number>(`allowance:${human}`) ?? 1) - 1);
          this.state.put('sponsor:reserved-cents', (this.state.get<number>('sponsor:reserved-cents') ?? 1) - 1);
          this.state.delete(jobKey);
        });
        throw error;
      }
      // Unknown outcomes retain their reservation across crashes/restarts, preventing blind repurchase.
      this.state.put(jobKey, { fingerprint, status: 'unknown' } satisfies Job);
      throw new ResearchError('payment_outcome_unknown', 'The research call did not return a confirmed result. Its allowance slot is held; do not retry with a new request ID.', 502);
    }
  }
}
