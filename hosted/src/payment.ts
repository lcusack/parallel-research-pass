import { Mppx, tempo } from 'mppx/client';
import { privateKeyToAccount } from 'viem/accounts';
import { parseAnswer } from '../../src/answer.ts';

export const endpoint = 'https://parallelmpp.dev/api/responses';
export const usdc = '0x20c000000000000000000000b9537d11c60e8b50' as const;
export type PaidResult = ReturnType<typeof parseAnswer> & {
  payment: { status: 'confirmed'; maxServiceChargeUsd: '0.01'; currency: 'USDC.e'; network: 'tempo'; receipt: string; reference: string | null };
};

async function boundedJson(response: Response) {
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Empty provider response');
  const chunks: Uint8Array[] = []; let length = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > 1000000) { await reader.cancel(); throw new Error('Provider response too large'); }
    chunks.push(value);
  }
  const all = new Uint8Array(length); let offset = 0;
  for (const chunk of chunks) { all.set(chunk, offset); offset += chunk.length; }
  return JSON.parse(new TextDecoder().decode(all));
}

export async function researchPayment(secret: `0x${string}`, question: string, rawFetch: typeof fetch = globalThis.fetch): Promise<PaidResult> {
  const account = privateKeyToAccount(secret);
  const client = Mppx.create({
    polyfill: false, maxPaymentRetries: 1, fetch: rawFetch,
    methods: [tempo.charge({ account, expectedChainId: 4217, allowedChainIds: [4217], currencies: [usdc], maxAtomicAmount: '10000', feeToken: usdc, autoSwap: false })],
  });
  const response = await client.fetch(endpoint, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ input: question, reasoning: { effort: 'low' } }),
    // Workers supports manual/follow, not redirect:error. Never forward a payment to a redirect.
    redirect: 'manual', signal: AbortSignal.timeout(75000),
  });
  const receipt = response.headers.get('payment-receipt');
  if (response.status !== 200 || !receipt) { await response.body?.cancel(); throw new Error('No confirmed provider result'); }
  const answer = parseAnswer(await boundedJson(response));
  if (answer.answer.length > 50000) throw new Error('Answer exceeds prototype limit');
  let reference: string | null = null;
  try {
    const parsed = JSON.parse(Buffer.from(receipt, 'base64url').toString());
    if (parsed.status !== 'success') throw new Error('Unsuccessful receipt');
    if (typeof parsed.reference === 'string' && /^0x[0-9a-fA-F]{64}$/.test(parsed.reference)) reference = parsed.reference;
  } catch { throw new Error('Invalid payment receipt'); }
  return { ...answer, payment: { status: 'confirmed', maxServiceChargeUsd: '0.01', currency: 'USDC.e', network: 'tempo', receipt, reference } };
}
