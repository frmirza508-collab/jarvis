import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync, chmodSync } from 'node:fs';
import path from 'node:path';

/**
 * Encrypted secret storage (AES-256-GCM).
 *
 * The 32-byte master key is supplied by a KeyProvider. On the desktop the key
 * lives in the OS credential vault (Windows Credential Manager via the Tauri
 * `keyring` integration) and is handed to the local core over its private
 * stdin channel; it is never written next to the ciphertext.
 */
export interface KeyProvider {
  getKey(): Buffer;
}

export class StaticKeyProvider implements KeyProvider {
  private readonly key: Buffer;
  constructor(key: Buffer | string) {
    const buf = typeof key === 'string' ? decodeKey(key) : key;
    if (buf.length !== 32) throw new Error('Master key must be 32 bytes');
    this.key = buf;
  }
  getKey(): Buffer {
    return this.key;
  }
}

/** Derive a key from a passphrase (for headless/server use). */
export class PassphraseKeyProvider implements KeyProvider {
  private readonly key: Buffer;
  constructor(passphrase: string, salt: Buffer) {
    this.key = scryptSync(passphrase, salt, 32, { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  }
  getKey(): Buffer {
    return this.key;
  }
}

function decodeKey(s: string): Buffer {
  if (/^[0-9a-f]{64}$/i.test(s)) return Buffer.from(s, 'hex');
  return Buffer.from(s, 'base64');
}

export function generateMasterKey(): string {
  return randomBytes(32).toString('base64');
}

interface Envelope {
  v: 1;
  iv: string;
  tag: string;
  data: string;
}

export function encrypt(key: Buffer, plaintext: string, aad = 'jarvis-secrets'): Envelope {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key, iv);
  c.setAAD(Buffer.from(aad));
  const data = Buffer.concat([c.update(plaintext, 'utf8'), c.final()]);
  return {
    v: 1,
    iv: iv.toString('base64'),
    tag: c.getAuthTag().toString('base64'),
    data: data.toString('base64'),
  };
}

export function decrypt(key: Buffer, env: Envelope, aad = 'jarvis-secrets'): string {
  const d = createDecipheriv('aes-256-gcm', key, Buffer.from(env.iv, 'base64'));
  d.setAAD(Buffer.from(aad));
  d.setAuthTag(Buffer.from(env.tag, 'base64'));
  return Buffer.concat([d.update(Buffer.from(env.data, 'base64')), d.final()]).toString('utf8');
}

export interface SecretStore {
  get(name: string): string | undefined;
  set(name: string, value: string): void;
  delete(name: string): void;
  has(name: string): boolean;
  /** Names only - values are never listed. */
  list(): string[];
}

export class EncryptedFileSecretStore implements SecretStore {
  private cache: Record<string, string> | null = null;

  constructor(
    private readonly filePath: string,
    private readonly keys: KeyProvider,
  ) {}

  private load(): Record<string, string> {
    if (this.cache) return this.cache;
    if (!existsSync(this.filePath)) {
      this.cache = {};
      return this.cache;
    }
    const env = JSON.parse(readFileSync(this.filePath, 'utf8')) as Envelope;
    this.cache = JSON.parse(decrypt(this.keys.getKey(), env)) as Record<string, string>;
    return this.cache;
  }

  private persist(): void {
    mkdirSync(path.dirname(this.filePath), { recursive: true });
    const env = encrypt(this.keys.getKey(), JSON.stringify(this.cache ?? {}));
    const tmp = `${this.filePath}.tmp`;
    writeFileSync(tmp, JSON.stringify(env), { mode: 0o600 });
    renameSync(tmp, this.filePath);
    try {
      chmodSync(this.filePath, 0o600);
    } catch {
      /* not supported on all filesystems */
    }
  }

  get(name: string): string | undefined {
    return this.load()[name];
  }
  has(name: string): boolean {
    return name in this.load();
  }
  set(name: string, value: string): void {
    this.load()[name] = value;
    this.persist();
  }
  delete(name: string): void {
    delete this.load()[name];
    this.persist();
  }
  list(): string[] {
    return Object.keys(this.load());
  }
}

export class MemorySecretStore implements SecretStore {
  private readonly m = new Map<string, string>();
  get(n: string) {
    return this.m.get(n);
  }
  set(n: string, v: string) {
    this.m.set(n, v);
  }
  delete(n: string) {
    this.m.delete(n);
  }
  has(n: string) {
    return this.m.has(n);
  }
  list() {
    return [...this.m.keys()];
  }
}
