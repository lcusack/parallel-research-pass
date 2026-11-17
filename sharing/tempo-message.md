Built a small World ID × Parallel × Tempo reference prototype to make the identity + payments flow tangible.

The idea: verify with World ID (Selfie Check or stronger), unlock up to 10 sponsored Parallel research answers, and inspect the MPP receipt on Tempo. The allowance follows the account across browser and agent sessions.

Try it: https://parallel-research-pass.foundry-world.workers.dev
90-second walkthrough: https://parallel-research-pass.foundry-world.workers.dev/walkthrough
Code + MCP setup: https://github.com/lcusack/parallel-research-pass

No invitation, provider API key, or user wallet is needed for the sponsored flow. It has a tiny $1 shared sponsorship budget, so the free allowance is subject to that pool lasting. Start with “What does Parallel.ai do? Cite its official website,” then open the receipt and check the remaining count. You can also install the MCP client and verify the same account in a second session to see the shared allowance.

The native MCP flow has completed a real World ID → Parallel → MPP call: a fresh approval picked up the existing 9-answer allowance, the query reduced it to 8, and replay returned the saved answer and receipt without paying again. The agent now uses the native challenge/prover flow from mppx PR #1271: Research Pass returns Identity-Attestation-Required, World.Client.prover gets human approval, and the SDK retries with Identity-Attestation. This is demo-funded: Research Pass enforces World ID eligibility, while Parallel receives a standard paid MPP request. A provider-side World ID offer would be a further integration.

Would love your feedback on where the identity check should sit in a production provider integration and whether this is the right reference flow for other services.
