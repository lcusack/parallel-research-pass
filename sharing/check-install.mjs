// Run on a clean CI runner; never load the operator's .env or sponsor keys.
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const state = await mkdtemp(join(tmpdir(), 'research-pass-install-'));
const transport = new StdioClientTransport({
  command: 'npx',
  args: ['--yes', '--package', 'github:lcusack/parallel-research-pass', 'parallel-research-pass'],
  env: { PATH: process.env.PATH, RESEARCH_PASS_STATE_DIR: state },
  stderr: 'pipe',
});
transport.stderr?.on('data', chunk => process.stderr.write(chunk));
const client = new Client({ name: 'public-install-check', version: '1.0.0' });
try {
  await client.connect(transport, { timeout: 120000 });
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map(tool => tool.name).sort(), ['verify_human', 'check_verification', 'research_allowance', 'research', 'paid_research'].sort());
  console.log('Five published MCP tools found.');
  const status = await client.callTool({ name: 'research_allowance', arguments: {} });
  const texts = status.content.filter(item => item.type === 'text').map(item => item.text);
  if (status.isError) assert.ok(texts.some(text => text.startsWith('activation_pending:')));
  else assert.equal(JSON.parse(texts[0]).verified, false);
  console.log('Hosted status read successfully; no identity approval or payment requested.');
} finally {
  await client.close();
  await rm(state, { recursive: true, force: true });
}
