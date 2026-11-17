import test from 'node:test';
import assert from 'node:assert/strict';
import { researchPayment, endpoint } from '../src/payment.ts';

const fixtureKey = `0x${'11'.repeat(32)}` as const;
test('hosted transport uses a Workers-supported redirect policy and preserves the confirmed result', async () => {
  let requests = 0;
  const receipt = Buffer.from(JSON.stringify({ status: 'success', reference: `0x${'22'.repeat(32)}` })).toString('base64url');
  const fakeFetch: typeof fetch = async (input, init) => {
    const request = new Request(input, init); requests++;
    assert.equal(request.url, endpoint);
    assert.equal(request.redirect, 'manual');
    assert.equal(request.method, 'POST');
    assert.deepEqual(await request.json(), { input: 'What does Parallel do?', reasoning: { effort: 'low' } });
    return Response.json({ output_text: 'A cited research answer.' }, { headers: { 'payment-receipt': receipt } });
  };
  const result = await researchPayment(fixtureKey, 'What does Parallel do?', fakeFetch);
  assert.equal(requests, 1);
  assert.equal(result.payment.status, 'confirmed');
  assert.equal(result.answer, 'A cited research answer.');
});

test('hosted adapter refuses a redirect without forwarding another request', async () => {
  let requests = 0;
  const fakeFetch: typeof fetch = async (input, init) => {
    assert.equal(new Request(input, init).redirect, 'manual'); requests++;
    return new Response(null, { status: 302, headers: { location: 'https://other.example' } });
  };
  await assert.rejects(researchPayment(fixtureKey, 'What does Parallel do?', fakeFetch), /No confirmed provider result/);
  assert.equal(requests, 1);
});
