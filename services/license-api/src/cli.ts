import path from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { generateSigningKeys } from '@jarvis/licensing';
import { createPool, migrate } from './db.js';
import { createUser } from './services/auth.js';

/**
 * Operator CLI:
 *   generate-keys                       print a new Ed25519 license signing keypair
 *   migrate                             apply database migrations (DATABASE_URL)
 *   create-admin <email> <name>         create an admin (password from ADMIN_PASSWORD env)
 */
async function main() {
  const [cmd, ...args] = process.argv.slice(2);
  if (cmd === 'generate-keys') {
    const k = await generateSigningKeys();
    process.stdout.write(`# Keep the PRIVATE key only on the license server (secret manager).\nLICENSE_SIGNING_PRIVATE_KEY="${k.privateKeyPem.trim().replace(/\n/g, '\\n')}"\n\n# Embed the PUBLIC key in desktop release builds.\nJARVIS_LICENSE_PUBLIC_KEY="${k.publicKeyPem.trim().replace(/\n/g, '\\n')}"\n`);
    return;
  }
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is required');
  const db = createPool(url);
  try {
    if (cmd === 'migrate') {
      const here = path.dirname(fileURLToPath(import.meta.url));
      const dir = process.env.MIGRATIONS_DIR ?? [path.join(here, 'migrations'), path.resolve(here, '../../../infra/database/migrations')].find((d) => existsSync(d))!;
      const ran = await migrate(db, dir);
      process.stdout.write(ran.length ? `Applied: ${ran.join(', ')}\n` : 'Database up to date\n');
    } else if (cmd === 'create-admin') {
      const [email, name] = args;
      const password = process.env.ADMIN_PASSWORD;
      if (!email || !password) throw new Error('Usage: ADMIN_PASSWORD=... create-admin <email> [name]');
      const u = await createUser(db, { email, name: name ?? 'Administrator', password, role: 'admin' });
      process.stdout.write(`Created admin ${u.email} (${u.id})\n`);
    } else {
      throw new Error(`Unknown command ${cmd ?? ''}. Use generate-keys | migrate | create-admin`);
    }
  } finally {
    await db.end();
  }
}

main().catch((e) => {
  console.error((e as Error).message);
  process.exit(1);
});
