Built a small World ID × Parallel × Tempo reference prototype to make the identity + payments flow tangible.

The idea: verify with World ID (Selfie Check or stronger), unlock up to 10 sponsored Parallel research answers, and inspect the MPP receipt on Tempo. The allowance follows the account across browser and agent sessions.

Try it: https://parallel-research-pass.foundry-world.workers.dev
90-second walkthrough: https://parallel-research-pass.foundry-world.workers.dev/walkthrough
Code + MCP setup: https://github.com/lcusack/parallel-research-pass

No invitation, provider API key, or user wallet is needed for the sponsored flow. It has a tiny $1 shared sponsorship budget, so the free allowance is subject to that pool lasting. Start with “What does Parallel.ai do? Cite its official website,” then open the receipt and check the remaining count. You can also install the MCP client and verify the same account in a second session to see the shared allowance.

The hosted MCP flow has completed a real World ID → Parallel → MPP call: the allowance went from 10 to 9, and replaying that request returned its saved answer and receipt without paying again. This is demo-funded: our backend enforces eligibility, while Parallel receives a standard paid MPP request. It is not yet a provider-native World ID offer.

Would love your feedback on where the identity check should sit in a production provider integration and whether this is the right reference flow for other services.
