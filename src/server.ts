import { createServer } from 'node:http';
import { join } from 'node:path';
import { World } from 'mppx/extensions/identity';
import { config, projectRoot, settings, signingKey } from './config.ts';
import { State } from './state.ts';
import { authorized, createApp } from './app.ts';
import { paidAnswer } from './parallel.ts';
import { ResearchService } from './research.ts';
import { acceptedAcr } from './policy.ts';

const runtime = await settings();
const env = config();
if (runtime.worldIssuer !== env.WORLD_ID_ISSUER) throw new Error('This state belongs to another World ID environment. Use a separate project copy and state volume.');
const state = new State(join(projectRoot, 'data/backend.sqlite'), runtime.encryptionKey);
const issuer = env.WORLD_ID_CLIENT_ID && env.WORLD_ID_CLIENT_SECRET ? World.Issuer.create({
  url: runtime.origin, clientId: env.WORLD_ID_CLIENT_ID, clientSecret: env.WORLD_ID_CLIENT_SECRET,
  clientAuthentication: env.WORLD_ID_CLIENT_AUTH, worldIssuer: env.WORLD_ID_ISSUER,
  acr: acceptedAcr,
  signingKey: await signingKey(runtime), secretKey: runtime.encryptionKey, store: state.atomicStore(),
  audiences: [runtime.origin], authorize: request => authorized(request, runtime.token),
  limit: { key: () => 'local-operator', max: 5, window: 900 }, ttl: 3600,
}) : null;
const research = new ResearchService(state, env.SPONSOR_BUDGET_CENTS, question => paidAnswer(env.TEMPO_BIN, question));
const handle = createApp({ settings: runtime, state, issuer, research });
const server = createServer({ maxHeaderSize: 16384, requestTimeout: 100000, headersTimeout: 10000 }, async (req, res) => {
  try {
    if (req.headers.host !== new URL(runtime.origin).host) { res.writeHead(400).end(); return; }
    const chunks: Buffer[] = [];
    let length = 0;
    for await (const chunk of req) {
      const bytes = Buffer.from(chunk);
      length += bytes.length;
      if (length > 20000) { res.writeHead(413).end(); return; }
      chunks.push(bytes);
    }
    const headers = new Headers();
    for (const [name, value] of Object.entries(req.headers)) if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(', ') : value);
    const request = new Request(new URL(req.url ?? '/', runtime.origin), {
      method: req.method, headers,
      ...(length > 0 && { body: Buffer.concat(chunks) }),
    });
    const response = await handle(request);
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(Buffer.from(await response.arrayBuffer()));
  } catch { if (!res.headersSent) res.writeHead(500); res.end(); }
});
server.listen(Number(new URL(runtime.origin).port), '127.0.0.1', () => {
  console.error(`Parallel Research Pass listening at ${runtime.origin}`);
  console.error(`World ID: ${issuer ? env.WORLD_ID_ISSUER : 'needs client credentials in .env'}. Sponsor cap: $${(env.SPONSOR_BUDGET_CENTS / 100).toFixed(2)} total.`);
});
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => { server.close(() => { state.close(); process.exit(0); }); });
