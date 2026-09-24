import pg from 'pg';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

export type Db = pg.Pool;
export type Queryable = pg.Pool | pg.PoolClient;

export function createPool(connectionString: string): Db {
  return new pg.Pool({ connectionString, max: 10 });
}

export async function tx<T>(db: Db, fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const c = await db.connect();
  try {
    await c.query('BEGIN');
    const r = await fn(c);
    await c.query('COMMIT');
    return r;
  } catch (e) {
    await c.query('ROLLBACK');
    throw e;
  } finally {
    c.release();
  }
}

/** Applies infra/database/migrations/*.sql in order, once each. */
export async function migrate(db: Db, dir: string): Promise<string[]> {
  await db.query(
    'CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())',
  );
  const applied = new Set(
    (await db.query<{ name: string }>('SELECT name FROM schema_migrations')).rows.map((r) => r.name),
  );
  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort();
  const ran: string[] = [];
  for (const f of files) {
    if (applied.has(f)) continue;
    await tx(db, async (c) => {
      await c.query(readFileSync(path.join(dir, f), 'utf8'));
      await c.query('INSERT INTO schema_migrations (name) VALUES ($1)', [f]);
    });
    ran.push(f);
  }
  return ran;
}
