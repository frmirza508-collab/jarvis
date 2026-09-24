import path from 'node:path';

/** Paths JARVIS never writes to or deletes, regardless of grants. */
const PROTECTED_WINDOWS = [
  /^[a-z]:\\windows(\\|$)/i,
  /^[a-z]:\\program files( \(x86\))?(\\|$)/i,
  /^[a-z]:\\programdata\\microsoft(\\|$)/i,
  /^[a-z]:\\\$recycle\.bin/i,
  /^[a-z]:\\?$/i,
];
const PROTECTED_POSIX = [/^\/(bin|sbin|boot|dev|etc|lib|lib64|proc|sys|usr)(\/|$)/, /^\/$/];

export function isProtectedPath(p: string): boolean {
  const abs = path.resolve(p);
  const list = process.platform === 'win32' ? PROTECTED_WINDOWS : PROTECTED_POSIX;
  return list.some((re) => re.test(abs));
}

const CREDENTIAL_FILES = [
  /[\\/]\.ssh[\\/]/i,
  /[\\/]\.aws[\\/]credentials$/i,
  /[\\/]\.env(\.|$)/i,
  /\.(pem|key|pfx|p12|kdbx)$/i,
  /[\\/](Login Data|Cookies|Web Data)$/i,
  /[\\/]Microsoft[\\/]Credentials[\\/]/i,
  /[\\/]Microsoft[\\/]Protect[\\/]/i,
];

/** Credential-bearing files require SENSITIVE permission. */
export function isSensitivePath(p: string): boolean {
  const abs = path.resolve(p);
  return CREDENTIAL_FILES.some((re) => re.test(abs));
}

/** Resolve target within root; throws when it escapes (path traversal). */
export function resolveWithin(root: string, target: string): string {
  const r = path.resolve(root);
  const t = path.resolve(r, target);
  const rel = path.relative(r, t);
  if (rel.startsWith('..') || path.isAbsolute(rel)) throw new Error(`Path escapes workspace: ${target}`);
  return t;
}
