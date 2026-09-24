import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { loadConfig } from './config.js';
import { createPool, migrate } from './db.js';
import { buildApp } from './app.js';

function migrationsDir(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [process.env.MIGRATIONS_DIR, path.resolve(here, '../../../infra/database/migrations'), path.resolve(here, 'migrations')].filter(Boolean) as string[];
  const found = candidates.find((c) => existsSync(c));
  if (!found) throw new Error('Migrations directory not found; set MIGRATIONS_DIR');
  return found;
}

async function main() {
  const config = loadConfig();
  const db = createPool(config.DATABASE_URL);
  const ran = await migrate(db, migrationsDir());
  if (ran.length) console.warn(`Applied migrations: ${ran.join(', ')}`);
  const app = await buildApp({ db, config, reconcileIntervalMs: 60_000 });
  await app.listen({ host: config.LICENSE_API_HOST, port: config.LICENSE_API_PORT });
  console.warn(`JARVIS license API listening on ${config.LICENSE_API_HOST}:${config.LICENSE_API_PORT}`);
  const stop = async () => {
    await app.close();
    await db.end();
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
