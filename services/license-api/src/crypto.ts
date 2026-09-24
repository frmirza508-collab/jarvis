import { createHash, randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCb) as (
  pw: string,
  salt: Buffer,
  len: number,
  opts: { N: number; r: number; p: number; maxmem: number },
) => Promise<Buffer>;
const N = 1 << 15;

export async function hashPassword(pw: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await scrypt(pw, salt, 32, { N, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  return `scrypt$${N}$8$1$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export async function verifyPassword(pw: string, stored: string): Promise<boolean> {
  const [alg, n, r, p, salt, hash] = stored.split('$');
  if (alg !== 'scrypt' || !salt || !hash) return false;
  const expected = Buffer.from(hash, 'base64');
  const got = await scrypt(pw, Buffer.from(salt, 'base64'), expected.length, {
    N: Number(n),
    r: Number(r),
    p: Number(p),
    maxmem: 64 * 1024 * 1024,
  });
  return got.length === expected.length && timingSafeEqual(got, expected);
}

export const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

export function newSessionToken(): string {
  return randomBytes(32).toString('base64url');
}

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'; // Crockford base32 (no I, L, O, U)

/** License key: JRV-XXXXX-XXXXX-XXXXX-XXXXX (100 bits of entropy). */
export function newLicenseKey(): string {
  const bytes = randomBytes(20);
  let s = '';
  for (let i = 0; i < 20; i++) s += ALPHABET[bytes[i]! % 32];
  return `JRV-${s.slice(0, 5)}-${s.slice(5, 10)}-${s.slice(10, 15)}-${s.slice(15, 20)}`;
}

export const normaliseKey = (k: string) => k.trim().toUpperCase();
export const hashLicenseKey = (k: string) => sha256(`jarvis-license|${normaliseKey(k)}`);
