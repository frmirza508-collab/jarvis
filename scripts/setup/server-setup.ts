/**
 * One-time license server setup. Run on your own machine or server:
 *
 *   DATABASE_URL=postgres://... ADMIN_EMAIL=you@example.com ADMIN_PASSWORD='...' pnpm setup:server
 *
 * 1. Generates the Ed25519 license signing keypair in ./.secrets/ (never committed)
 * 2. Applies database migrations
 * 3. Creates the first admin account
 * 4. Prints the values to put in your hosting provider and in the desktop release build
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { generateSigningKeys } from '../../packages/licensing/src/index.js';
import { createPool, migrate } from '../../services/license-api/src/db.js';
import { createUser } from '../../services/license-api/src/services/auth.js';

const root = path.resolve(import.meta.dirname, '../..');
const dir = path.join(root, '.secrets');
const priv = path.join(dir, 'license-private.pem');
const pub = path.join(dir, 'license-public.pem');

async function main() {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (!existsSync(priv)) {
    const k = await generateSigningKeys();
    writeFileSync(priv, k.privateKeyPem, { mode: 0o600 });
    writeFileSync(pub, k.publicKeyPem);
    console.log('✔ Generated license signing keys in .secrets/ (back up license-private.pem safely!)');
  } else {
    console.log('✔ Using existing keys in .secrets/');
  }

  const url = process.env.DATABASE_URL;
  if (url) {
    const db = createPool(url);
    try {
      const ran = await migrate(db, path.join(root, 'infra/database/migrations'));
      console.log(ran.length ? `✔ Applied migrations: ${ran.join(', ')}` : '✔ Database already up to date');
      const email = process.env.ADMIN_EMAIL;
      const password = process.env.ADMIN_PASSWORD;
      if (email && password) {
        const exists = await db.query('SELECT 1 FROM users WHERE email = $1', [email.toLowerCase()]);
        if (exists.rowCount) console.log(`✔ Admin ${email} already exists`);
        else {
          await createUser(db, { email, password, name: 'Administrator', role: 'admin' });
          console.log(`✔ Created admin ${email}`);
        }
      } else console.log('• Skipped admin creation (set ADMIN_EMAIL and ADMIN_PASSWORD, min 10 chars)');
    } finally {
      await db.end();
    }
  } else console.log('• Skipped database steps (set DATABASE_URL)');

  const oneLine = (p: string) => readFileSync(p, 'utf8').trim().replace(/\n/g, '\\n');
  console.log(`
────────────────────────────────────────────────────────────────
License server (hosting provider environment variables — SECRET):
  LICENSE_SIGNING_PRIVATE_KEY=${'<contents of .secrets/license-private.pem, one line with \\n>'}
  DATABASE_URL=<your database URL>
  ADMIN_ORIGINS=<your admin portal URL>

Desktop release build (safe to share):
  JARVIS_LICENSE_PUBLIC_KEY="${oneLine(pub)}"
  JARVIS_LICENSE_API_URL=<https URL of your license server>

Private key as one line (copy into the hosting provider only):
  ${oneLine(priv)}
────────────────────────────────────────────────────────────────`);
}

main().catch((e) => {
  console.error(`Setup failed: ${(e as Error).message}`);
  process.exit(1);
});
