import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { newId } from '@jarvis/shared';
import { redact } from '@jarvis/security';

export type AuditOutcome = 'allowed' | 'denied' | 'success' | 'failure' | 'info';

export interface AuditEntry {
  id: string;
  ts: string;
  actor: string;
  action: string;
  target?: string;
  outcome: AuditOutcome;
  details?: Record<string, unknown>;
  prevHash: string;
  hash: string;
}

export type AuditInput = Omit<AuditEntry, 'id' | 'ts' | 'prevHash' | 'hash'>;

const GENESIS = '0'.repeat(64);

function hashEntry(e: Omit<AuditEntry, 'hash'>): string {
  const { id, ts, actor, action, target, outcome, details, prevHash } = e;
  return createHash('sha256')
    .update(JSON.stringify({ id, ts, actor, action, target, outcome, details, prevHash }))
    .digest('hex');
}

/**
 * Append-only, hash-chained audit log. Every entry commits to the previous
 * entry's hash so silent edits or deletions are detectable via verify().
 * Details are redacted before persistence.
 */
export class AuditLog {
  private entries: AuditEntry[] = [];
  private lastHash = GENESIS;
  private listeners = new Set<(e: AuditEntry) => void>();

  constructor(private readonly filePath?: string) {
    if (filePath && existsSync(filePath)) {
      const lines = readFileSync(filePath, 'utf8').split('\n').filter(Boolean);
      this.entries = lines.map((l) => JSON.parse(l) as AuditEntry);
      this.lastHash = this.entries.at(-1)?.hash ?? GENESIS;
    }
  }

  record(input: AuditInput): AuditEntry {
    const base = {
      id: newId('aud'),
      ts: new Date().toISOString(),
      ...input,
      details: input.details ? redact(input.details) : undefined,
      prevHash: this.lastHash,
    };
    const entry: AuditEntry = { ...base, hash: hashEntry(base) };
    this.entries.push(entry);
    this.lastHash = entry.hash;
    if (this.filePath) {
      mkdirSync(path.dirname(this.filePath), { recursive: true });
      appendFileSync(this.filePath, JSON.stringify(entry) + '\n', { mode: 0o600 });
    }
    for (const l of this.listeners) l(entry);
    return entry;
  }

  onEntry(fn: (e: AuditEntry) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  list(filter?: { actor?: string; action?: string; limit?: number }): AuditEntry[] {
    let out = this.entries;
    if (filter?.actor) out = out.filter((e) => e.actor === filter.actor);
    if (filter?.action) out = out.filter((e) => e.action.startsWith(filter.action!));
    return filter?.limit ? out.slice(-filter.limit) : [...out];
  }

  /** Returns index of the first broken entry, or -1 when the chain is intact. */
  verify(): number {
    let prev = GENESIS;
    for (let i = 0; i < this.entries.length; i++) {
      const e = this.entries[i]!;
      const { hash, ...rest } = e;
      if (e.prevHash !== prev || hashEntry(rest) !== hash) return i;
      prev = hash;
    }
    return -1;
  }
}
