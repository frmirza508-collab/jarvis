import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { EncryptedFileSecretStore, StaticKeyProvider } from '@jarvis/security';
import { Logger } from '@jarvis/shared';
import { createJarvisCore, type CoreSettings } from './core.js';
import { createServer } from './server.js';
import { LicenseClient } from './license-client.js';
import { APP_VERSION, DEVELOPMENT_LICENSE_MODE, IS_RELEASE, LICENSE_API_URL, LICENSE_PUBLIC_KEY } from './build-info.js';

/**
 * JARVIS local core entry point (runs as the Tauri sidecar).
 *
 * Bootstrap: the desktop shell writes ONE JSON line to stdin:
 *   {"token": "<per-launch session token>", "masterKey": "<base64 32 bytes from Windows Credential Manager>"}
 * The core binds 127.0.0.1 on a random port and prints:
 *   JARVIS_READY {"port": 12345}
 * For development without the shell, set JARVIS_DEV=1 (token/key from env or generated).
 */
interface Bootstrap {
  token: string;
  masterKey: string;
  dataDir?: string;
  port?: number;
}

const log = new Logger('core');

function dataDirDefault(): string {
  const base = process.platform === 'win32' ? (process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming')) : path.join(os.homedir(), '.local', 'share');
  return path.join(base, 'JARVIS');
}

async function readBootstrap(): Promise<Bootstrap> {
  if (process.env.JARVIS_DEV === '1' && !IS_RELEASE) {
    const dataDir = process.env.JARVIS_DATA_DIR ?? path.join(process.cwd(), '.jarvis-data');
    mkdirSync(dataDir, { recursive: true });
    const keyFile = path.join(dataDir, 'dev-master.key');
    if (!existsSync(keyFile)) writeFileSync(keyFile, randomBytes(32).toString('base64'), { mode: 0o600 });
    return {
      token: process.env.JARVIS_DEV_TOKEN ?? 'dev-token-change-me',
      masterKey: process.env.JARVIS_MASTER_KEY ?? readFileSync(keyFile, 'utf8').trim(),
      dataDir,
      port: Number(process.env.JARVIS_PORT ?? 7801),
    };
  }
  const rl = readline.createInterface({ input: process.stdin });
  const line = await new Promise<string>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('No bootstrap received on stdin')), 30_000);
    rl.once('line', (l) => {
      clearTimeout(t);
      resolve(l);
    });
  });
  rl.close();
  const b = JSON.parse(line) as Bootstrap;
  if (!b.token || b.token.length < 32 || !b.masterKey) throw new Error('Invalid bootstrap');
  return b;
}

async function main(): Promise<void> {
  const boot = await readBootstrap();
  const dataDir = boot.dataDir ?? process.env.JARVIS_DATA_DIR ?? dataDirDefault();
  mkdirSync(dataDir, { recursive: true });
  const secrets = new EncryptedFileSecretStore(path.join(dataDir, 'secrets.enc.json'), new StaticKeyProvider(boot.masterKey));
  // Allow first-run seeding from environment for headless/dev use (never logged).
  for (const n of ['OPENROUTER_API_KEY', 'BRAVE_SEARCH_API_KEY', 'TAVILY_API_KEY'] as const) if (process.env[n] && !secrets.has(n)) secrets.set(n, process.env[n]!);

  let saved: Partial<CoreSettings> = {};
  const settingsFile = path.join(dataDir, 'settings.json');
  if (existsSync(settingsFile)) saved = JSON.parse(readFileSync(settingsFile, 'utf8')) as Partial<CoreSettings>;
  const workspace = saved.workspace ?? path.join(os.homedir(), 'Documents', 'JARVIS');
  mkdirSync(workspace, { recursive: true });

  let license: LicenseClient | undefined;
  if (LICENSE_PUBLIC_KEY) {
    license = new LicenseClient({ apiUrl: LICENSE_API_URL, publicKeyPem: LICENSE_PUBLIC_KEY, secrets, appVersion: APP_VERSION, developmentMode: DEVELOPMENT_LICENSE_MODE });
    await license.init();
    license.start();
    if (secrets.get('LICENSE_KEY')) void license.refresh().catch((e) => log.warn('license refresh failed', { error: (e as Error).message }));
  } else if (IS_RELEASE) {
    throw new Error('Release build is missing the license public key');
  } else if (!DEVELOPMENT_LICENSE_MODE) {
    log.warn('No JARVIS_LICENSE_PUBLIC_KEY configured: premium execution is blocked. Set JARVIS_LICENSE_MODE=development for local development.');
  }

  const core = createJarvisCore({
    dataDir,
    secrets,
    settings: { ...saved, workspace },
    hooks: {
      checkEntitlement: () => (license ? license.checkEntitlement() : DEVELOPMENT_LICENSE_MODE ? { premium: true } : { premium: false, reason: 'Licensing is not configured in this build.' }),
    },
  });
  const server = await createServer({ core, license, token: boot.token, dataDir, version: APP_VERSION });

  const address = await server.listen({ host: '127.0.0.1', port: boot.port ?? 0 });
  const port = Number(new URL(address).port);
  process.stdout.write(`JARVIS_READY ${JSON.stringify({ port, version: APP_VERSION, dataDir })}\n`);
  log.info('JARVIS core ready', { port, release: IS_RELEASE, dev: DEVELOPMENT_LICENSE_MODE });

  const shutdown = async () => {
    license?.stop();
    await server.close();
    await core.shutdown();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  // The shell closing our stdin means the desktop app exited.
  if (process.env.JARVIS_DEV !== '1') process.stdin.on('end', shutdown);
  process.on('uncaughtException', (e) => log.error('uncaught exception', { error: e.message, stack: e.stack }));
  process.on('unhandledRejection', (e) => log.error('unhandled rejection', { error: String(e) }));
}

main().catch((e) => {
  console.error(`JARVIS_FATAL ${(e as Error).message}`);
  process.exit(1);
});
