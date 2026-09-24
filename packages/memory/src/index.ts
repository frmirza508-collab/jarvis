import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { newId } from '@jarvis/shared';
import { redactString } from '@jarvis/security';

/**
 * Memory layers. Scope ids qualify a layer (project path, agent id, department,
 * session id). "global" and "preference" layers have no scope id.
 */
export const MEMORY_SCOPES = ['session', 'preference', 'project', 'task', 'agent', 'department', 'global', 'knowledge', 'lesson'] as const;
export type MemoryScope = (typeof MEMORY_SCOPES)[number];

export interface MemoryItem {
  id: string;
  scope: MemoryScope;
  scopeId: string;
  kind: string; // fact | note | preference | lesson | document | summary
  content: string;
  tags: string[];
  source: string;
  verified: boolean;
  evidence?: string;
  importance: number; // 0..1
  createdAt: string;
  updatedAt: string;
  lastUsedAt?: string;
  useCount: number;
  expiresAt?: string;
}

export interface RememberInput {
  scope: MemoryScope;
  scopeId?: string;
  kind?: string;
  content: string;
  tags?: string[];
  source?: string;
  verified?: boolean;
  evidence?: string;
  importance?: number;
  ttlDays?: number;
}

export interface TaskHistoryRecord {
  id: string;
  request: string;
  language?: string;
  status: 'succeeded' | 'failed' | 'cancelled';
  summary: string;
  agents: string[];
  startedAt: string;
  finishedAt: string;
}

type Row = Record<string, unknown>;

function rowToItem(r: Row): MemoryItem {
  return {
    id: String(r.id),
    scope: r.scope as MemoryScope,
    scopeId: String(r.scope_id),
    kind: String(r.kind),
    content: String(r.content),
    tags: JSON.parse(String(r.tags)) as string[],
    source: String(r.source),
    verified: r.verified === 1,
    evidence: (r.evidence as string | null) ?? undefined,
    importance: Number(r.importance),
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
    lastUsedAt: (r.last_used_at as string | null) ?? undefined,
    useCount: Number(r.use_count),
    expiresAt: (r.expires_at as string | null) ?? undefined,
  };
}

/**
 * Persistent local memory on SQLite (node:sqlite) with FTS5 trigram search,
 * which works for English, Urdu and Chinese text alike. Secrets are redacted
 * before storage.
 */
export class MemoryStore {
  private db: DatabaseSync;

  constructor(file: string = ':memory:') {
    if (file !== ':memory:') mkdirSync(path.dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS memories (
        id TEXT PRIMARY KEY, scope TEXT NOT NULL, scope_id TEXT NOT NULL DEFAULT '', kind TEXT NOT NULL,
        content TEXT NOT NULL, tags TEXT NOT NULL DEFAULT '[]', source TEXT NOT NULL DEFAULT 'user',
        verified INTEGER NOT NULL DEFAULT 0, evidence TEXT, importance REAL NOT NULL DEFAULT 0.5,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL, last_used_at TEXT, use_count INTEGER NOT NULL DEFAULT 0,
        expires_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_mem_scope ON memories(scope, scope_id);
      CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(content, tags, id UNINDEXED, tokenize='trigram');
      CREATE TABLE IF NOT EXISTS preferences (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS task_history (
        id TEXT PRIMARY KEY, request TEXT NOT NULL, language TEXT, status TEXT NOT NULL, summary TEXT NOT NULL,
        agents TEXT NOT NULL, started_at TEXT NOT NULL, finished_at TEXT NOT NULL
      );
    `);
  }

  close(): void {
    this.db.close();
  }

  remember(input: RememberInput): MemoryItem {
    const now = new Date().toISOString();
    const id = newId('mem');
    const content = redactString(input.content);
    const tags = input.tags ?? [];
    const expires = input.ttlDays ? new Date(Date.now() + input.ttlDays * 86_400_000).toISOString() : null;
    this.db
      .prepare(
        `INSERT INTO memories (id, scope, scope_id, kind, content, tags, source, verified, evidence, importance, created_at, updated_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.scope,
        input.scopeId ?? '',
        input.kind ?? 'note',
        content,
        JSON.stringify(tags),
        input.source ?? 'user',
        input.verified ? 1 : 0,
        input.evidence ?? null,
        Math.min(1, Math.max(0, input.importance ?? 0.5)),
        now,
        now,
        expires,
      );
    this.db.prepare('INSERT INTO memories_fts (content, tags, id) VALUES (?, ?, ?)').run(content, tags.join(' '), id);
    return this.get(id)!;
  }

  get(id: string): MemoryItem | undefined {
    const r = this.db.prepare('SELECT * FROM memories WHERE id = ?').get(id) as Row | undefined;
    return r ? rowToItem(r) : undefined;
  }

  update(id: string, patch: Partial<Pick<MemoryItem, 'content' | 'tags' | 'verified' | 'evidence' | 'importance'>>): MemoryItem | undefined {
    const cur = this.get(id);
    if (!cur) return undefined;
    const next = { ...cur, ...patch, content: patch.content ? redactString(patch.content) : cur.content };
    this.db
      .prepare('UPDATE memories SET content=?, tags=?, verified=?, evidence=?, importance=?, updated_at=? WHERE id=?')
      .run(next.content, JSON.stringify(next.tags), next.verified ? 1 : 0, next.evidence ?? null, next.importance, new Date().toISOString(), id);
    this.db.prepare('UPDATE memories_fts SET content=?, tags=? WHERE id=?').run(next.content, next.tags.join(' '), id);
    return this.get(id);
  }

  forget(id: string): boolean {
    this.db.prepare('DELETE FROM memories_fts WHERE id = ?').run(id);
    return Number(this.db.prepare('DELETE FROM memories WHERE id = ?').run(id).changes) > 0;
  }

  list(filter: { scope?: MemoryScope; scopeId?: string; verified?: boolean; limit?: number } = {}): MemoryItem[] {
    const where: string[] = ['(expires_at IS NULL OR expires_at > ?)'];
    const args: Array<string | number> = [new Date().toISOString()];
    if (filter.scope) {
      where.push('scope = ?');
      args.push(filter.scope);
    }
    if (filter.scopeId !== undefined) {
      where.push('scope_id = ?');
      args.push(filter.scopeId);
    }
    if (filter.verified !== undefined) {
      where.push('verified = ?');
      args.push(filter.verified ? 1 : 0);
    }
    args.push(filter.limit ?? 200);
    const rows = this.db.prepare(`SELECT * FROM memories WHERE ${where.join(' AND ')} ORDER BY updated_at DESC LIMIT ?`).all(...args) as Row[];
    return rows.map(rowToItem);
  }

  /** Full-text search. Queries shorter than 3 chars (common in Chinese) fall back to LIKE. */
  search(query: string, opts: { scopes?: MemoryScope[]; scopeId?: string; limit?: number; verifiedOnly?: boolean } = {}): MemoryItem[] {
    const q = query.trim();
    if (!q) return [];
    const limit = opts.limit ?? 10;
    const terms = q.split(/\s+/).filter((t) => [...t].length >= 3);
    let ids: string[];
    if (terms.length) {
      const match = terms.map((t) => `"${t.replace(/"/g, '""')}"`).join(' OR ');
      ids = (this.db.prepare('SELECT id FROM memories_fts WHERE memories_fts MATCH ? ORDER BY rank LIMIT ?').all(match, limit * 5) as Row[]).map((r) => String(r.id));
    } else {
      ids = (this.db.prepare('SELECT id FROM memories WHERE content LIKE ? LIMIT ?').all(`%${q}%`, limit * 5) as Row[]).map((r) => String(r.id));
    }
    const now = new Date().toISOString();
    const out: MemoryItem[] = [];
    for (const id of ids) {
      const it = this.get(id);
      if (!it) continue;
      if (it.expiresAt && it.expiresAt <= now) continue;
      if (opts.scopes && !opts.scopes.includes(it.scope)) continue;
      if (opts.scopeId !== undefined && it.scopeId !== opts.scopeId && it.scope !== 'global' && it.scope !== 'preference') continue;
      if (opts.verifiedOnly && !it.verified) continue;
      out.push(it);
      if (out.length >= limit) break;
    }
    const touch = this.db.prepare('UPDATE memories SET last_used_at = ?, use_count = use_count + 1 WHERE id = ?');
    for (const it of out) touch.run(now, it.id);
    return out;
  }

  // ---- Learning loop: lessons are stored unverified and only reused once verified.
  proposeLesson(content: string, source: string, tags: string[] = []): MemoryItem {
    return this.remember({ scope: 'lesson', kind: 'lesson', content, source, tags, verified: false, importance: 0.6 });
  }

  verifyLesson(id: string, evidence: string): MemoryItem | undefined {
    return this.update(id, { verified: true, evidence });
  }

  rejectLesson(id: string): boolean {
    return this.forget(id);
  }

  verifiedLessons(query: string, limit = 5): MemoryItem[] {
    return this.search(query, { scopes: ['lesson'], verifiedOnly: true, limit });
  }

  // ---- Preferences
  setPreference(key: string, value: unknown): void {
    this.db
      .prepare('INSERT INTO preferences (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at')
      .run(key, JSON.stringify(value), new Date().toISOString());
  }

  getPreference<T>(key: string): T | undefined {
    const r = this.db.prepare('SELECT value FROM preferences WHERE key = ?').get(key) as Row | undefined;
    return r ? (JSON.parse(String(r.value)) as T) : undefined;
  }

  preferences(): Record<string, unknown> {
    const rows = this.db.prepare('SELECT key, value FROM preferences').all() as Row[];
    return Object.fromEntries(rows.map((r) => [String(r.key), JSON.parse(String(r.value))]));
  }

  // ---- Task history
  recordTask(t: TaskHistoryRecord): void {
    this.db
      .prepare('INSERT OR REPLACE INTO task_history (id, request, language, status, summary, agents, started_at, finished_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(t.id, redactString(t.request), t.language ?? null, t.status, redactString(t.summary), JSON.stringify(t.agents), t.startedAt, t.finishedAt);
  }

  taskHistory(limit = 50): TaskHistoryRecord[] {
    const rows = this.db.prepare('SELECT * FROM task_history ORDER BY finished_at DESC LIMIT ?').all(limit) as Row[];
    return rows.map((r) => ({
      id: String(r.id),
      request: String(r.request),
      language: (r.language as string | null) ?? undefined,
      status: r.status as TaskHistoryRecord['status'],
      summary: String(r.summary),
      agents: JSON.parse(String(r.agents)) as string[],
      startedAt: String(r.started_at),
      finishedAt: String(r.finished_at),
    }));
  }

  // ---- Retention controls
  purge(opts: { scope?: MemoryScope; olderThanDays?: number; expiredOnly?: boolean }): number {
    const where: string[] = [];
    const args: string[] = [];
    if (opts.expiredOnly) {
      where.push('expires_at IS NOT NULL AND expires_at <= ?');
      args.push(new Date().toISOString());
    }
    if (opts.scope) {
      where.push('scope = ?');
      args.push(opts.scope);
    }
    if (opts.olderThanDays !== undefined) {
      where.push('updated_at < ?');
      args.push(new Date(Date.now() - opts.olderThanDays * 86_400_000).toISOString());
    }
    const cond = where.length ? where.join(' AND ') : '1=1';
    const ids = (this.db.prepare(`SELECT id FROM memories WHERE ${cond}`).all(...args) as Row[]).map((r) => String(r.id));
    for (const id of ids) this.forget(id);
    return ids.length;
  }

  stats(): Record<string, number> {
    const rows = this.db.prepare('SELECT scope, COUNT(*) AS n FROM memories GROUP BY scope').all() as Row[];
    return Object.fromEntries(rows.map((r) => [String(r.scope), Number(r.n)]));
  }
}
