import { marked } from '/vendor/marked.esm.js';
import DOMPurify from '/vendor/purify.es.mjs';

const $ = id => document.getElementById(id);
let verified = false, busy = false, pollTimer, verificationGeneration = 0, receipt = '', remaining = 10, pendingRequest = null;
const form = $('research-form'), submit = $('submit');

function message(text = '', error = false) { $('message').hidden = !text; $('message').textContent = text; $('message').classList.toggle('error', error); }
async function api(path, body) {
  const response = await fetch(path, { method: body === undefined ? 'GET' : 'POST', credentials: 'same-origin', headers: body === undefined ? {} : { 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const value = await response.json();
  if (!response.ok) { const error = new Error(value.message || 'The request could not complete.'); error.code = value.error; error.status = response.status; throw error; }
  return value;
}
function updateStatus(value) {
  verified = !!value.verified;
  $('connection').textContent = verified ? `Connected · ${value.authenticationLevel}` : 'Not connected';
  $('connection').classList.toggle('connected', verified);
  $('step-verify').classList.toggle('done', verified);
  $('step-verify').classList.toggle('current', !verified);
  $('step-research').classList.toggle('current', verified);
  if (verified) {
    remaining = value.allowance.remaining;
    $('allowance').textContent = `${remaining} of 10 answers left`;
    submit.querySelector('span').textContent = 'Research this question';
    submit.classList.add('ready');
    $('charge-note').textContent = 'One sponsored answer · Parallel charge capped at $0.01 · the demo pays network fees.';
    $('verification').hidden = true;
    if (remaining === 0 || value.allowance.sponsorshipAvailable === false) {
      $('continue').hidden = false;
      message(remaining === 0 ? 'Your sponsored answers have been used.' : 'The shared demo sponsorship is currently used up.');
    }
  } else { submit.querySelector('span').textContent = 'Verify to unlock research'; submit.classList.remove('ready'); }
}
function setBusy(value) { busy = value; submit.disabled = value; $('question').disabled = value; }
function nextPoll(seconds) { clearTimeout(pollTimer); const generation = verificationGeneration; pollTimer = setTimeout(() => checkVerification(generation), Math.max(5, seconds || 5) * 1000); }
async function checkVerification(generation) {
  try {
    const value = await api('/api/verify/check', {});
    if (generation !== verificationGeneration) return;
    if (value.verified) { updateStatus(value); message('World ID is connected. Your research allowance is ready.'); return; }
    if (!value.status) { $('verification').hidden = true; message('Verification expired. Start again when you’re ready.', true); return; }
    $('verification-detail').textContent = value.status === 'unavailable' ? 'World ID is temporarily unavailable. Waiting before checking again…' : 'Waiting for your approval…';
    nextPoll(value.retryAfterSeconds);
  } catch (error) {
    if (generation !== verificationGeneration) return;
    if (error instanceof TypeError || error.status >= 500 || error.status === 429) {
      $('verification-detail').textContent = 'Connection interrupted. Keeping your approval link and checking again…';
      nextPoll(10); return;
    }
    $('verification').hidden = true; message(error.message, true);
  }
}
async function startVerification() {
  verificationGeneration++; clearTimeout(pollTimer);
  setBusy(true); message();
  try {
    // A tab can outlive its one-day session. Renew before starting a new approval.
    await api('/api/session');
    const value = await api('/api/verify/start', {});
    if (value.verified) { updateStatus(value); return; }
    $('user-code').textContent = value.userCode;
    const link = new URL(value.url);
    if (link.origin !== 'https://auth.world.org') throw new Error('Unexpected verification link.');
    $('verification-link').href = value.url;
    $('verification').hidden = false;
    nextPoll(value.retryAfterSeconds);
  } catch (error) { message(error.message, true); }
  finally { setBusy(false); }
}
function showResult(value) {
  $('empty-state').hidden = true; $('result').hidden = false;
  $('answer').innerHTML = DOMPurify.sanitize(marked.parse(value.answer), { ALLOWED_TAGS: ['p','h1','h2','h3','h4','strong','em','ul','ol','li','a','code','pre','blockquote','br','hr','table','thead','tbody','tr','th','td'], ALLOWED_ATTR: ['href','title'] });
  for (const a of $('answer').querySelectorAll('a')) {
    try { if (!['http:', 'https:'].includes(new URL(a.href).protocol)) a.removeAttribute('href'); }
    catch { a.removeAttribute('href'); }
    a.target = '_blank'; a.rel = 'noopener noreferrer';
  }
  $('sources').replaceChildren();
  for (const source of value.citations || []) {
    let url; try { url = new URL(source.url); if (!['https:', 'http:'].includes(url.protocol)) continue; } catch { continue; }
    const link = document.createElement('a'); link.className = 'source-card'; link.href = url.href; link.target = '_blank'; link.rel = 'noopener noreferrer';
    const title = document.createElement('span'); title.textContent = source.title || url.hostname;
    const arrow = document.createElement('b'); arrow.textContent = '↗'; link.append(title, arrow); $('sources').append(link);
  }
  receipt = value.payment.receipt;
  $('transaction').textContent = value.payment.reference || 'See full receipt';
  $('reused-label').hidden = !value.reused;
  $('step-payment').classList.add('done'); $('step-research').classList.add('done');
  remaining = value.allowance.remaining; $('allowance').textContent = `${remaining} of 10 answers left`;
  if (remaining === 0 || !value.allowance.sponsorshipAvailable) $('continue').hidden = false;
}
form.addEventListener('submit', async event => {
  event.preventDefault(); if (busy) return;
  if (!verified) { await startVerification(); return; }
  const question = $('question').value.trim();
  if (question.length < 3) { message('Enter a research question first.', true); $('question').focus(); return; }
  if (pendingRequest && pendingRequest.question !== question) { message('The previous request has an uncertain outcome. Reload to check your allowance before intentionally asking a new question.', true); return; }
  pendingRequest ||= { question, requestId: crypto.randomUUID() };
  setBusy(true); message(); $('loading').hidden = false; $('empty-state').hidden = true;
  try {
    const value = await api('/api/research', pendingRequest);
    showResult(value); pendingRequest = null;
  } catch (error) {
    message(error.message, true);
    if (['busy','allowance_exhausted','sponsor_budget_exhausted','verification_required','invalid_request'].includes(error.code)) pendingRequest = null;
    if (['allowance_exhausted','sponsor_budget_exhausted'].includes(error.code)) $('continue').hidden = false;
    if (error.code === 'verification_required') updateStatus({ verified: false });
  } finally { setBusy(false); $('loading').hidden = true; }
});
for (const button of document.querySelectorAll('[data-question]')) button.addEventListener('click', () => { if (!busy) { $('question').value = button.dataset.question; $('question').focus(); } });
for (const which of ['browser','agent']) $(which + '-tab').addEventListener('click', () => {
  for (const name of ['browser','agent']) { $(name + '-tab').setAttribute('aria-selected', String(name === which)); $(name + '-panel').hidden = name !== which; }
});
async function copy(text, button) { try { await navigator.clipboard.writeText(text); const old = button.textContent; button.textContent = 'Copied ✓'; setTimeout(() => button.textContent = old, 1800); } catch { message('Clipboard access is unavailable. Select and copy the text manually.', true); } }
$('copy-config').addEventListener('click', () => copy($('mcp-config').textContent, $('copy-config')));
$('copy-receipt').addEventListener('click', () => copy(receipt, $('copy-receipt')));
$('download-request').addEventListener('click', () => {
  const question = $('question').value.trim(); if (question.length < 3) { message('Enter a question before downloading the request.', true); return; }
  const url = URL.createObjectURL(new Blob([JSON.stringify({ input: question, reasoning: { effort: 'low' } }, null, 2)], { type: 'application/json' }));
  const a = document.createElement('a'); a.href = url; a.download = 'parallel-request.json'; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
});
try { await api('/api/session'); updateStatus(await api('/api/status')); }
catch (error) { message(error.message, true); if (error.code === 'activation_pending') { submit.disabled = true; submit.querySelector('span').textContent = 'Hosted setup in progress'; } }
