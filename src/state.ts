import { DatabaseSync } from 'node:sqlite';
import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'node:crypto';
import { chmodSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Store } from 'mppx';

/** One encrypted SQLite volume; synchronous transactions also serialize other local processes. */
export class State {
  readonly db: DatabaseSync;
  private key: Buffer;
  constructor(path: string, encryptionKey: string) {
    this.key = Buffer.from(encryptionKey, 'base64');
    if (this.key.length !== 32) throw new Error('Invalid state encryption key');
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    if (path !== ':memory:') chmodSync(path, 0o600);
    this.db.exec('PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS records (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
  }
  id(value: string) { return createHmac('sha256', this.key).update(value).digest('hex'); }
  get<T>(key: string): T | null {
    const row = this.db.prepare('SELECT value FROM records WHERE key=?').get(key);
    if (!row) return null;
    const bytes = Buffer.from(String(row.value), 'base64');
    const decipher = createDecipheriv('aes-256-gcm', this.key, bytes.subarray(0, 12));
    decipher.setAAD(Buffer.from(key));
    decipher.setAuthTag(bytes.subarray(12, 28));
    return JSON.parse(Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString());
  }
  put(key: string, value: unknown) {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    cipher.setAAD(Buffer.from(key));
    const body = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()]);
    const encrypted = Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64');
    this.db.prepare('INSERT INTO records VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, encrypted);
  }
  delete(key: string) { this.db.prepare('DELETE FROM records WHERE key=?').run(key); }
  transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const value = fn(); this.db.exec('COMMIT'); return value; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  atomicStore(): Store.AtomicStore {
    return {
      get: async key => this.get(key),
      put: async (key, value) => this.put(key, value),
      delete: async key => this.delete(key),
      update: async (key, fn) => this.transaction(() => {
        const change = fn(this.get(key));
        if (change.op === 'set') this.put(key, change.value);
        if (change.op === 'delete') this.delete(key);
        return change.result;
      }),
    };
  }
  close() { this.db.close(); }
}
