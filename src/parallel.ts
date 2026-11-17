import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ResearchError, type ResearchResult } from './research.ts';

const exec = promisify(execFile);
export const parallelEndpoint = 'https://parallelmpp.dev/api/responses';
const paymentToken = '0x20c000000000000000000000b9537d11c60e8b50';

export { parseAnswer } from './answer.ts';
import { parseAnswer } from './answer.ts';

export async function walletReady(binary: string) {
  try {
    const { stdout } = await exec(binary, ['wallet', 'whoami', '--network', 'mainnet', '--format', 'json'], { timeout: 20000, maxBuffer: 100000 });
    const result = JSON.parse(stdout);
    return result.ready === true;
  } catch { return false; }
}

export async function paidAnswer(binary: string, question: string): Promise<ResearchResult> {
  // Only a readiness failure is definitely before payment and safe to release from the allowance.
  if (!await walletReady(binary)) throw new ResearchError('payment_not_started', 'The Tempo wallet is not ready. Refresh its mainnet authorization before researching.', 503);
  const dir = await mkdtemp(join(tmpdir(), 'parallel-research-'));
  const body = join(dir, 'body.json');
  const meta = join(dir, 'meta.json');
  try {
    await exec(binary, ['request', parallelEndpoint,
      '--network', 'mainnet', '--max-spend', '0.01', '--payment-intent', 'charge', '--payment-token', paymentToken,
      '--request', 'POST', '--json', JSON.stringify({ input: question, reasoning: { effort: 'low' } }),
      '--timeout', '75', '--retries', '0', '--output', body, '--write-meta', meta, '--json-output'],
    { timeout: 90000, maxBuffer: 2_000_000 });
    const metadata = JSON.parse(await readFile(meta, 'utf8'));
    const headers = metadata.headers ?? {};
    const receipt = metadata.payment_receipt ?? metadata.paymentReceipt ?? headers['payment-receipt'];
    if (metadata.status !== 200 || typeof receipt !== 'string' || !receipt) throw new Error('Missing settled response');
    const data = JSON.parse(await readFile(body, 'utf8'));
    return { ...parseAnswer(data), payment: { status: 'confirmed', maxSpendUsd: '0.01', currency: 'USDC.e', network: 'tempo', receipt } };
  } finally { await rm(dir, { recursive: true, force: true }); }
}
