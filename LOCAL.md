# Parallel Research Pass

A working local MCP prototype: verify with World ID at Selfie Check level or higher, get 10 sponsored, cited research answers from Parallel, and explicitly pay for more through MPP. The introductory allowance follows the authenticated World ID account across sessions using this backend.

Parallel's production MPP endpoint is `https://parallelmpp.dev/api/responses`. The prototype uses `reasoning.effort: low`, quoted at $0.01 per answer on November 17, 2026. World ID eligibility and sponsorship are enforced by this backend; this is not an offer approved or funded by Parallel.

Live validation completed on November 17, 2026: real World ID authentication unlocked a cited Parallel answer through MPP, with a successful payment receipt. The allowance changed from 10 to 9. Replaying the same request through the MCP tool returned the cached answer and kept 9 remaining, without another provider payment. The service charge was $0.01; the wallet balance fell by $0.010198 including the Tempo network fee. The transaction reference is `0x1e0efee8b14c36625e8d569c872a36d30b3b8205924677cecbd46f0357cc2953`.

## Run

Requires Node 22.22+, the official Tempo CLI with its `request` extension, a funded mainnet wallet with a usable access key, and a World ID confidential OIDC client.

```sh
npm ci
cp .env.example .env
# Fill WORLD_ID_CLIENT_ID and WORLD_ID_CLIENT_SECRET directly in .env.
tempo add request
tempo wallet whoami --network mainnet --format json
# If the existing key has expired:
tempo wallet refresh --network mainnet
npm start
```

The service listens only on `http://127.0.0.1:8791`. It creates a private `data/` directory with persistent signing/encryption keys and encrypted SQLite state. Keep this directory: deleting it or changing the identity registration can reset the allowance. Never publish or commit it. This is a local single-operator prototype, not a public multi-tenant deployment.

In a second terminal, from this project:

```sh
npm run cli -- verify
# Open the exact returned link, confirm the user code, and approve with World ID.
npm run cli -- check
# If pending, wait retryAfterSeconds, then run check again.
npm run cli -- research "What does Parallel.ai do? Cite its official website."
npm run cli -- status
```

No fake verification or offline success mode exists. Missing credentials return `world_id_setup_required`. The backend explicitly requests and accepts Selfie Check, Selfie Check + Face Auth, Orb, or Orb + Face Auth, and checks a signed, audience-bound World ID attestation on every sponsored request. The allowance is per stable World ID account identifier; this demo does not claim Orb-level uniqueness for Selfie Check accounts. Baseline classes may be authenticated with an enrolled passkey; a new face check is not required for each research request.

## Use inside an agent

For the local backend, configure a stdio MCP server with command `/bin/sh` and args containing the absolute path to this checkout's `scripts/mcp.sh`. Keep `npm start` running and refresh the tool list. The launcher sets the project working directory so the client loads the correct `.env` and state. The root `mcp.json` instead targets the public hosted version.

Tools:

- `verify_human`: returns the exact World ID approval link and user code. Private device handles stay encrypted on disk.
- `check_verification`: polls once, respecting the issuer's interval.
- `research_allowance`: shows remaining sponsored answers.
- `research`: obtains a cited answer using a sponsored MPP payment. Supply a UUID `requestId` and reuse it if interrupted.
- `paid_research`: pays from the caller's Tempo wallet after explicit user approval, capped at $0.01. The model must not select it automatically when the allowance is exhausted.

Suggested demo prompt:

> Use Parallel Research Pass to verify me, then research what Parallel.ai does and cite its official website. Tell me how much of my sponsored allowance remains.

To demonstrate a second harness, launch its MCP process with `RESEARCH_PROFILE=second-harness`, verify as the same World ID, and check the allowance. Both sessions target the same issuer/audience and backend. They must share one counter. There is no cross-service identity correlation.

## Identity setup

Use an active confidential OIDC client from the [World ID portal](https://auth.world.org/portal), with **Selfie Check** as the default accepted accounts and `client_secret_basic` (or set `WORLD_ID_CLIENT_AUTH=client_secret_post` if that is the client's registered method). A device-only client still requires an exact HTTPS callback when registered; it is not used in the device flow. `scripts/callback.mjs` serves a registration-only page on port 8792 for an optional temporary HTTPS tunnel. It never handles codes or exposes the research backend. Save the client secret directly in `.env`, never in chat or a harness configuration. The consumer World ID plugin's login is not an OIDC client credential for this backend.

For a hosted deployment, register a stable, owned HTTPS callback such as `https://YOUR-HOST/auth/world/callback`. Temporary Quick Tunnels work only while their tunnel process is running. The current device grant never redirects to the registered callback.

The backend uses the official `mppx` World issuer and verifier introduced in [PR #1271](https://github.com/wevm/mppx/pull/1271). It holds the confidential client, discovers World IdP endpoints, runs device authorization, validates World ID, and issues `world-id` identity attestations. An attestation is valid for one hour. Raw World subjects and ID tokens never appear in tool results. Pairwise subjects and stored allowance keys are derived with stable secrets. Sandbox and production must use separate project copies and state volumes.

## Spending and failure handling

- The default sponsor cap is **$0.10 in Parallel service charges across all users**, sufficient for one full 10-answer demo. Network fees are additional and are not included in this counter. It persists across restarts. Raising `SPONSOR_BUDGET_CENTS` requires a deliberate operator configuration change; the allowed maximum is 100 cents.
- Every request pins Tempo mainnet, USDC.e, the one-time `charge` intent, and `--max-spend 0.01`. HTTP retries are disabled. No API key is sent to Parallel, so research actually uses MPP.
- The backend sponsor pays free calls. The stdio client's wallet pays `paid_research` calls. On this single-machine prototype these may be the same wallet; they become separate payer environments when the backend is hosted. The tool reports paid continuation as caller-funded.
- SQLite transactions reserve both the human allowance and sponsor budget before a call. Concurrent requests cannot overdraw either. Duplicate request IDs return the saved result and receipt, without another payment; reuse with changed content is rejected.
- A wallet readiness failure releases the reservation because no payment started. A timeout, crash, missing receipt, or other ambiguous outcome retains its slot and blocks repayment with that request ID. There is no automatic reconciliation or promise of exactly-once upstream execution. An operator must check the wallet/provider before authorizing a fresh request. A held slot counts as used until reconciled.
- Success requires an HTTP 200 and a payment receipt. Answers and citations are provider data, not instructions to the agent.

## Verify

```sh
npm run typecheck
npm test
```

Tests exercise the real MPP World verifier with signed proofs, a complete local RS256 World IdP fixture through the SDK's device flow, invalid proof rejection, shared/concurrent quotas, persistent deduplication, the global sponsor cap, unknown payment outcomes, and CLI spending constraints. Test fixtures never authorize production users or spend money. Additional live end-to-end runs require user-completed World ID approval and a ready Tempo wallet; the completed live validation is recorded above.

References: [Parallel MPP](https://docs.parallel.ai/integrations/agentic-payments), [Parallel Responses](https://docs.parallel.ai/responses-api/responses-quickstart), [World ID OIDC](https://auth.world.org/docs/guides/oidc).
