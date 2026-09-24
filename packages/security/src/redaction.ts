/**
 * Secret redaction for logs, audit records and model transcripts.
 */
const PATTERNS: Array<[RegExp, string]> = [
  [/sk-or-v1-[A-Za-z0-9]{20,}/g, 'sk-or-v1-[REDACTED]'],
  [/sk-(?:proj-|ant-)?[A-Za-z0-9_-]{20,}/g, 'sk-[REDACTED]'],
  [/(?:rk|pk|sk)_(?:live|test)_[A-Za-z0-9]{10,}/g, '[REDACTED_STRIPE_KEY]'],
  [/whsec_[A-Za-z0-9]{10,}/g, 'whsec_[REDACTED]'],
  [/gh[pousr]_[A-Za-z0-9]{30,}/g, 'gh_[REDACTED]'],
  [/AKIA[0-9A-Z]{16}/g, 'AKIA[REDACTED]'],
  [/AIza[0-9A-Za-z_-]{35}/g, 'AIza[REDACTED]'],
  [/(Bearer\s+)[A-Za-z0-9._~+/=-]{12,}/gi, '$1[REDACTED]'],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '[REDACTED_PRIVATE_KEY]'],
  [/(postgres(?:ql)?:\/\/[^:\s]+:)[^@\s]+@/g, '$1[REDACTED]@'],
];

const SENSITIVE_KEYS =
  /^(api[-_]?key|apikey|secret|password|passwd|token|access[-_]?token|refresh[-_]?token|authorization|private[-_]?key|signing[-_]?key|client[-_]?secret|cookie)$/i;

export function redactString(input: string): string {
  let out = input;
  for (const [re, rep] of PATTERNS) out = out.replace(re, rep);
  return out;
}

export function redact<T>(value: T, depth = 0): T {
  if (depth > 12) return value;
  if (typeof value === 'string') return redactString(value) as T;
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1)) as T;
  if (value && typeof value === 'object') {
    if (value instanceof Error) return redactString(value.message) as T;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SENSITIVE_KEYS.test(k) && v != null && v !== '' ? '[REDACTED]' : redact(v, depth + 1);
    }
    return out as T;
  }
  return value;
}
