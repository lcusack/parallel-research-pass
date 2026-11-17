import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'node:crypto';
import { Store } from 'mppx';

/** Encrypt SDK tokens, sessions and results before D1 persistence; updates retain D1 CAS atomicity. */
export function encryptedStore(db: D1Database, secret: string): Store.AtomicStore {
  const key = Buffer.from(secret, 'base64');
  if (key.length !== 32) throw new Error('Invalid encryption key');
  const inner = Store.d1(db);
  const storageKey = (name: string) => createHmac('sha256', key).update(name).digest('hex');
  const seal = (name: string, value: unknown) => {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(Buffer.from(name));
    const body = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64');
  };
  const open = (name: string, value: unknown): unknown => {
    if (value === null) return null;
    if (typeof value !== 'string') throw new Error('Invalid encrypted record');
    const bytes = Buffer.from(value, 'base64');
    const cipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12));
    cipher.setAAD(Buffer.from(name)); cipher.setAuthTag(bytes.subarray(12, 28));
    return JSON.parse(Buffer.concat([cipher.update(bytes.subarray(28)), cipher.final()]).toString());
  };
  return {
    get: async name => open(name, await inner.get(storageKey(name))),
    put: async (name, value) => inner.put(storageKey(name), seal(name, value)),
    delete: async name => inner.delete(storageKey(name)),
    update: async (name, fn) => inner.update(storageKey(name), current => {
      const change = fn(open(name, current));
      if (change.op === 'set') return { ...change, value: seal(name, change.value) };
      return change;
    }),
  };
}

export function opaqueId(secret: string, value: string) {
  return createHmac('sha256', Buffer.from(secret, 'base64')).update(value).digest('hex');
}
