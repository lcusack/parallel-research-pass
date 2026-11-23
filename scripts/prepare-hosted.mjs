import { randomBytes } from 'node:crypto';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { spawn } from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const staging = process.argv.includes('--staging');
const path = resolve(root, staging ? 'hosted/.secrets.staging.json' : 'hosted/.secrets.json');
mkdirSync(dirname(path), { recursive: true });
if (!existsSync(path)) {
  const keys = await crypto.subtle.generateKey('Ed25519', true, ['sign','verify']);
  writeFileSync(path, JSON.stringify({
    STATE_KEY: randomBytes(32).toString('base64'),
    ATTESTATION_PRIVATE_JWK: JSON.stringify(await crypto.subtle.exportKey('jwk', keys.privateKey)),
    ATTESTATION_PUBLIC_JWK: JSON.stringify(await crypto.subtle.exportKey('jwk', keys.publicKey)),
    SPONSOR_PRIVATE_KEY: generatePrivateKey(),
  }), { mode: 0o600, flag: 'wx' });
}
chmodSync(path, 0o600);
const secrets = JSON.parse(readFileSync(path, 'utf8'));
const account = privateKeyToAccount(secrets.SPONSOR_PRIVATE_KEY);
console.log(JSON.stringify({ environment: staging ? 'staging' : 'production', sponsorWallet: account.address, network: 'tempo-mainnet', maximumFundingUsd: staging ? '0.05' : '0.99' }));
if (process.argv.includes('--upload')) {
  const clientId = process.env.WORLD_ID_CLIENT_ID;
  const secret = process.env.WORLD_ID_CLIENT_SECRET;
  if (!clientId || !secret) throw new Error(`Run with --env-file=${staging ? '.env.staging' : '.env'} to load the matching World ID client`);
  const payload = { ...secrets, WORLD_ID_CLIENT_ID: clientId, WORLD_ID_CLIENT_SECRET: secret, WORLD_ID_CLIENT_AUTH: process.env.WORLD_ID_CLIENT_AUTH || 'client_secret_basic' };
  const child = spawn(process.execPath, [resolve(root, 'node_modules/wrangler/bin/wrangler.js'), 'secret', 'bulk', '--config', resolve(root, 'hosted/wrangler.jsonc'), '--env', staging ? 'staging' : ''], { cwd: root, stdio: ['pipe','inherit','inherit'] });
  child.stdin.end(JSON.stringify(payload));
  const code = await new Promise(resolve => child.once('exit', resolve));
  if (code !== 0) throw new Error('Secret upload failed');
}
