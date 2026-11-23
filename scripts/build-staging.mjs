import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const output = resolve(root, 'hosted/.staging-public');
rmSync(output, { recursive: true, force: true });
mkdirSync(output, { recursive: true });
cpSync(resolve(root, 'hosted/public'), output, { recursive: true });
const path = resolve(output, 'index.html');
let html = readFileSync(path, 'utf8')
  .replace('Research Pass — Free research for verified humans', 'Research Pass Staging — Proof of Presence')
  .replace('<span class="demo-label">Demo</span>', '<span class="demo-label">Staging</span>')
  .replace('Free research for<br>verified humans.', 'Test Proof<br>of Presence.')
  .replace('Try up to 10 research answers from Parallel.<br class="wide-break"> Verify with World ID to get started.', 'Use your staging Proof of Presence credential.<br class="wide-break"> Verify with World ID Staging to get started.')
  .replace('Selfie Check or stronger. No wallet or API key needed.', 'World ID Staging only. Proof of Presence (Selfie Check) required.')
  .replace('Selfie Check or stronger is accepted.', 'This staging test accepts only the Proof of Presence (Selfie Check) credential, including its Face Auth class. An Orb credential alone is not accepted.')
  .replace('Verify with World ID</', 'Verify with World ID Staging</');
html = html.replace(/(<pre id="mcp-config">)([\s\S]*?)(<\/pre>)/, (_, start, text, end) => {
  const config = JSON.parse(text);
  config.mcpServers['research-pass'].env = {
    RESEARCH_PASS_URL: 'https://parallel-research-pass-staging.foundry-world.workers.dev',
    RESEARCH_PASS_WORLD_ID_ISSUER: 'https://auth.worldcoin.dev',
  };
  return start + JSON.stringify(config, null, 2) + end;
});
writeFileSync(path, html);
const appPath = resolve(output, 'app.js');
const app = readFileSync(appPath, 'utf8').replace("link.origin !== 'https://auth.world.org'", "link.origin !== 'https://auth.worldcoin.dev'");
writeFileSync(appPath, app);
console.log('Built separate staging assets.');
