import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';

export const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SettingsSchema = z.object({
  origin: z.url(), token: z.string().min(40), encryptionKey: z.string().min(40),
  worldIssuer: z.enum(['https://auth.world.org', 'https://sandbox.auth.world.org']),
  privateKey: z.record(z.string(), z.unknown()), publicKey: z.record(z.string(), z.unknown()),
});
export type Settings = z.infer<typeof SettingsSchema>;

export async function settings(): Promise<Settings> {
  const dir = join(projectRoot, 'data');
  const path = join(dir, 'runtime.json');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const origin = 'http://127.0.0.1:8791';
  if (existsSync(path)) { chmodSync(path, 0o600); return SettingsSchema.parse(JSON.parse(readFileSync(path, 'utf8'))); }
  const pair = await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify']) as CryptoKeyPair;
  const value: Settings = {
    origin, worldIssuer: config().WORLD_ID_ISSUER, token: randomBytes(32).toString('hex'), encryptionKey: randomBytes(32).toString('base64'),
    privateKey: await crypto.subtle.exportKey('jwk', pair.privateKey) as Record<string, unknown>,
    publicKey: await crypto.subtle.exportKey('jwk', pair.publicKey) as Record<string, unknown>,
  };
  // Exclusive creation prevents simultaneous harness starts from replacing identity secrets.
  try { writeFileSync(path, JSON.stringify(value), { mode: 0o600, flag: 'wx' }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; return SettingsSchema.parse(JSON.parse(readFileSync(path, 'utf8'))); }
  return value;
}

export function config(env = process.env) {
  return z.object({
    WORLD_ID_CLIENT_ID: z.string().default(''), WORLD_ID_CLIENT_SECRET: z.string().default(''),
    WORLD_ID_CLIENT_AUTH: z.enum(['client_secret_basic', 'client_secret_post']).default('client_secret_basic'),
    // Keep sandbox and production identity/allowance stores in separate project copies.
    WORLD_ID_ISSUER: z.enum(['https://auth.world.org', 'https://sandbox.auth.world.org']).default('https://auth.world.org'),
    SPONSOR_BUDGET_CENTS: z.coerce.number().int().min(0).max(100).default(10),
    TEMPO_BIN: z.string().default(join(homedir(), '.tempo/bin/tempo')),
    RESEARCH_PROFILE: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/).default('default'),
  }).parse(env);
}

export async function signingKey(value: Settings): Promise<CryptoKeyPair> {
  return {
    privateKey: await crypto.subtle.importKey('jwk', value.privateKey, 'Ed25519', false, ['sign']),
    publicKey: await crypto.subtle.importKey('jwk', value.publicKey, 'Ed25519', true, ['verify']),
  };
}
