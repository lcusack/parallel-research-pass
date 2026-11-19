# Research Pass

Verify with World ID, ask Parallel a research question, and inspect its MPP payment on Tempo. The demo sponsors up to **10 answers per World ID account**, across browser and agent sessions, while a small shared budget lasts. Selfie Check or stronger is accepted.

**[Open the public demo](https://parallel-research-pass.foundry-world.workers.dev)** · **[MCP configuration](mcp.json)**

No invitation, API key, or user wallet is needed for sponsored research. This is an independent reference prototype; the allowance is funded by this demo and is not a Parallel promotion. Hosted verification and sponsorship are enabled and have completed a real World ID → Parallel → MPP transaction through the MCP client.

## Try in a browser

1. Open the demo and choose **Verify to unlock research**.
2. Open the World ID link, compare the displayed code, and approve. Selfie Check is the minimum; Orb accounts also qualify.
3. Ask “What does Parallel.ai do? Give a concise answer and cite its official website.”
4. Inspect the cited answer, remaining allowance, and payment receipt.

World ID is the only account connection. The backend pays Parallel through MPP. After sponsorship ends, you can continue using your own Tempo wallet; the page provides a request file and command, and the MCP client exposes an explicitly approved paid tool.

## Try with an agent

Requires Node **22.22+** and an agent harness that supports stdio MCP. Add this configuration and refresh the tool list:

```json
{
  "mcpServers": {
    "research-pass": {
      "command": "npx",
      "args": ["--yes", "--package", "github:lcusack/parallel-research-pass", "parallel-research-pass"]
    }
  }
}
```

Then ask:

> Use Research Pass to verify my World ID, research what Parallel does, and show my remaining allowance.

The tools are `verify_human`, `check_verification`, `research_allowance`, `research`, and `paid_research`. The agent should show you the exact approval URL and matching code, respect the polling interval, and reuse a research request’s UUID after an interruption. It must obtain approval before spending from your own wallet.

The client uses `World.Client.prover` to answer Research Pass’s standard MPP identity challenge. Keep the MCP server connected during approval: the SDK polls in the background, and `check_verification` reports its progress. The client stores its short-lived, audience-bound attestation in a private local file under `~/.local/state/parallel-research-pass`. Do not share that directory. To demonstrate another harness, use `RESEARCH_PASS_PROFILE=second-harness`. Separate profiles and browser sessions each require approval; signing in to the same World ID account shares its remaining allowance on this backend. Different OIDC app registrations do not share an allowance.

## What the prototype demonstrates

```text
Agent → Research Pass: no identity proof
  ← 401 + Identity-Attestation-Required: world-id;issuer="https://…"
  → World.Client.prover: issuer device flow + human approval
  → retry with signed, audience-bound Identity-Attestation
  → backend checks the account’s allowance
  → sponsored MPP charge to Parallel on Tempo
  → cited answer + receipt + remaining allowance
```

The hosted agent path exercises the challenge/prover flow from [mppx PR #1271](https://github.com/wevm/mppx/pull/1271), using the released `mppx@0.20.1` World ID extension. Research Pass is both the identity issuer and the sponsor’s enforcement point. **Parallel receives a standard paid MPP request; Research Pass consumes the World ID attestation and grants the allowance.** Provider-side World ID eligibility would require a Parallel integration.

The browser retains its HttpOnly session flow and uses the same SDK issuer, verifier, account mapping, and allowance ledger. Starting verification renews an expired demo session and requests fresh World ID authentication (`max_age=0`) to satisfy the SDK’s per-attempt `auth_time` check. Temporary failures preserve the pending approval; expired links, incomplete approvals, and rejected identity proofs produce distinct messages.

### Native identity protocol

- `GET /api/agent/status` and `POST /api/agent/research` require an explicit `Identity-Attestation`. Missing or invalid proofs receive the SDK’s `401` and `Identity-Attestation-Required` header. These routes do not accept a browser cookie as identity.
- `POST /world/device`, `POST /world/token`, and `GET /.well-known/jwks.json` expose the SDK issuer. Issuance accepts only this demo’s audience, enforces the Selfie Check minimum, and is rate-limited by IP and globally.
- The MCP client pins both prover scope and trusted issuer to this demo’s HTTPS origin. It uses `Mppx.create({ identity: [World.Client.prover(…)], methods: [], polyfill: false })` for identity negotiation, with payment negotiation disabled on this sponsored hop. A quota `402` is returned to the agent as an allowance error. The agent transport has no payment method and cannot pay a challenge itself. Only `verify_human` may start or renew device approval; research pauses for explicit renewal when a cached proof approaches expiry.
- `verify_human` starts a challenged status request and returns the human approval link as soon as the SDK supplies it. The SDK performs polling and retries the status request. Only a later, explicit `research` call can consume a sponsored answer. `research_allowance` is passive and never launches approval.

Inspect the challenge without signing in or spending:

```sh
curl -i https://parallel-research-pass.foundry-world.workers.dev/api/agent/status
```

The portable implementation is in `bin/native-pass.mjs`; the issuer and gate are in `hosted/src/worker.ts`.

Selfie Check identifies an eligible account here; this prototype does not claim Orb-level uniqueness or require a fresh selfie for each answer. Signed proofs are checked for issuer, audience, expiry, type, and accepted authentication class. The live tests used an Orb account; Selfie Check acceptance is covered by signed-token and complete device-flow fixtures.

## Budget and payment behavior

- **$1 total sponsorship budget**, including network fees. The dedicated hosted wallet received $0.99; the funding transfer cost $0.000325 in network fees, for a total initial debit of $0.990325. It has no access to the operator’s main wallet.
- At most **90 sponsored requests globally** and 10 per account. Each low-tier Parallel service charge is capped at $0.01; the wallet pays network fees too. Gas variation can exhaust the wallet before the call ceiling. There is no automatic refill.
- Requests pin the production Parallel Responses endpoint, Tempo mainnet (4217), USDC.e (`0x20c000000000000000000000b9537d11c60e8b50`), and one-time charge intent. No provider API key is used.
- One atomic ledger reservation covers the account, global cap, and request ID. Replaying a completed request returns its saved answer and receipt. Reusing its ID for another question is rejected.
- Unknown outcomes retain their slot and block repayment with the same ID. An operator must reconcile them; this is not a guarantee of exactly-once upstream execution. Do not create a new ID merely to retry an uncertain payment.
- The public backend serializes payment attempts. A busy response happens before reservation and can be retried. This deliberately favors a small demo over throughput.

Paid continuation uses the caller’s locally authorized Tempo CLI wallet and requires explicit spending approval. It is separate from the hosted sponsorship.

## Run and deploy your own

```sh
npm ci
npm run types:hosted
npm run typecheck
npm run typecheck:hosted
npm test
```

The public backend is a Cloudflare Worker with D1 and static assets. See `hosted/src/worker.ts` for routes, `ledger.ts` for quota/idempotency policy, and `payment.ts` for the MPP payment adapter. `bin/parallel-research-pass.mjs` is the portable agent client. The earlier Node/SQLite backend and CLI remain available in [LOCAL.md](LOCAL.md).

For your own deployment:

1. Set your Cloudflare account, Worker name, D1 binding, public origin, and repository URL in `hosted/wrangler.jsonc`. Create a new D1 database. The SDK initializes its store table.
2. Register your own confidential [World ID OIDC app](https://auth.world.org/portal), with Selfie Check accepted and `client_secret_basic`. Register `https://YOUR-HOST/auth/world/callback`; the device grant does not redirect to this page, but registration still requires an HTTPS callback.
3. Save the client ID and secret in a private root `.env`, using `.env.example`. Run `node scripts/prepare-hosted.mjs` to generate local encryption, attestation, and dedicated sponsor keys. **Keep `hosted/.secrets.json` private.**
4. Review the helper and destination, then run `node --env-file=.env scripts/prepare-hosted.mjs --upload` to store the app credentials and generated keys as server-side Cloudflare secrets. This step exports them to your chosen Cloudflare account.
5. Fund only that dedicated sponsor wallet within your approved budget. Set the call ceiling conservatively; the wallet balance is the hard spending limit. Deploy with `npm run deploy`.
6. Update the frontend and MCP client defaults to your origin. Complete a real World ID approval and inspect one paid result before inviting testers.

Attestations last one hour; sessions last one day. Session state, device handles, attestations, questions, answers, and the quota ledger are encrypted in D1 with HMAC-derived storage keys. The browser receives an HttpOnly session cookie; agents privately retain the one-hour audience-bound attestation needed for their own requests. Existing installations need one fresh approval when upgrading from the earlier cookie-based client. An interrupted approval can be restarted; a completed attestation survives MCP restarts until expiry. World ID subjects, client secrets, private device handles, and sponsor keys are not returned in tool output. The app logs error categories rather than query bodies or tokens. Parallel receives submitted questions for research.

This reference has no administrative UI, scheduled state deletion, automatic reconciliation, or production availability guarantee. Rotating identity/encryption keys or deleting D1 can reset or invalidate state; keep them stable during a demo.

## Validation and sources

Thirty-one automated tests cover proof validation, a complete SDK device flow against a local RS256 IdP fixture, native HTTP challenge/prover negotiation with background approval and credential reuse, explicit renewal of nearly expired credentials, shared browser/native replay, issuer audience and rate limits, shared and concurrent quotas, replay/conflict handling, the global cap, uncertain payments, secure hosted session cookies and encrypted storage, renewal of expired browser sessions, fresh authentication despite an existing World ID sign-in, accurate verification errors, recovery after an approval-time storage outage, Workers redirect handling, and CLI payment constraints. They do not spend funds.

The earlier session-based hosted MCP flow completed a real World ID approval and cited Parallel query on November 17, 2026. The allowance went from 10 to 9. The service charge was $0.01 and the confirmed Tempo network fee was $0.000178, for a total of $0.010178. Replaying the same request returned the identical saved answer and receipt with `reused: true`, kept 9 answers remaining, and left the sponsor balance unchanged at $0.979822. Transaction reference: `0x8d5e4473a7a9a2b5d5e038fe4295dd594acc944aba7e6f7d55f16c18ee1e6b23`.

The native challenge/prover upgrade also completed a real hosted MCP flow on November 17, 2026: the SDK handled the `401` challenge, World ID approval, and automatic retry with an attestation. It resolved to the existing account with 9 answers remaining; a new sponsored query reduced that to 8. The service charge plus network fee was $0.010031 ($0.01 + $0.000031). Replay returned the same saved answer and receipt with `reused: true`, kept 8 remaining, and left the balance unchanged at $0.969791. Transaction reference: `0x3f3ff9bcdb397d0b5deab5ea233875352fc71fbd2b140cf477153dc97a7df438`. This live approval used the same Orb account; the native device-flow fixture covers Selfie Check.


References: [Parallel agentic payments](https://docs.parallel.ai/integrations/agentic-payments), [Parallel Responses](https://docs.parallel.ai/responses-api/responses-quickstart), [World ID OIDC](https://auth.world.org/docs/guides/oidc), [MPP World ID extension](https://github.com/wevm/mppx/pull/1271).
