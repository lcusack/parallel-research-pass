import type { Store } from 'mppx';

type Job = { fingerprint: string; state: 'pending' | 'complete' | 'unknown' };
type Ledger = { count: number; accounts: Record<string, number>; jobs: Record<string, Job>; active?: { key: string; until: number } };
export class DemoError extends Error {
  constructor(readonly code: string, message: string, readonly status = 409) { super(message); }
}
const empty = (): Ledger => ({ count: 0, accounts: {}, jobs: {} });

/** One bounded global record gives a single CAS for account, global budget and request claims. */
export class LedgerService {
  constructor(private store: Store.AtomicStore, private cap: number) {
    if (!Number.isInteger(cap) || cap < 0 || cap > 90) throw new Error('Invalid public sponsor cap');
  }
  async allowance(account: string) {
    const ledger = await this.store.get('public:ledger') as Ledger | null ?? empty();
    const used = ledger.accounts[account] ?? 0;
    return { total: 10, used, remaining: Math.max(0, 10 - used), sponsorshipAvailable: ledger.count < this.cap };
  }
  async reserve(account: string, key: string, fingerprint: string) {
    return this.store.update('public:ledger', current => {
      const ledger = (current as Ledger | null) ?? empty();
      const job = ledger.jobs[key];
      if (job) {
        if (job.fingerprint !== fingerprint) throw new DemoError('request_conflict', 'This request ID was already used for a different question.');
        if (job.state === 'complete') return { op: 'noop', result: 'cached' as const };
        throw new DemoError('outcome_unknown', 'This request already started. Its answer or payment needs reconciliation before another attempt.');
      }
      if ((ledger.accounts[account] ?? 0) >= 10) throw new DemoError('allowance_exhausted', 'Your 10 sponsored answers have been used.', 402);
      if (ledger.count >= this.cap) throw new DemoError('sponsor_budget_exhausted', 'The shared prototype sponsorship is used up.', 402);
      if (ledger.active && ledger.active.until > Date.now()) throw new DemoError('busy', 'Another research request is finishing. Please try again in a few seconds.', 503);
      ledger.count++;
      ledger.accounts[account] = (ledger.accounts[account] ?? 0) + 1;
      ledger.jobs[key] = { fingerprint, state: 'pending' };
      ledger.active = { key, until: Date.now() + 120000 };
      return { op: 'set', value: ledger, result: 'reserved' as const };
    });
  }
  async finish(key: string, state: 'complete' | 'unknown') {
    await this.store.update('public:ledger', current => {
      const ledger = current as Ledger | null;
      if (!ledger?.jobs[key]) throw new Error('Missing reservation');
      ledger.jobs[key].state = state;
      if (ledger.active?.key === key) delete ledger.active;
      return { op: 'set', value: ledger, result: undefined };
    });
  }
}
