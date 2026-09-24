import path from 'node:path';
import { generateSigningKeys } from '@jarvis/licensing';
import { buildApp } from '@jarvis/license-api';
import { createPool, migrate } from '../../services/license-api/src/db.js';
import { loadConfig } from '../../services/license-api/src/config.js';
import { createUser } from '../../services/license-api/src/services/auth.js';
import type { BillingProvider } from '@jarvis/billing-core';

export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://jarvis:jarvis@127.0.0.1:5432/jarvis_test';

export async function startLicenseServer(extra: Record<string, string> = {}, providers?: BillingProvider[]) {
  const keys = await generateSigningKeys();
  const db = createPool(TEST_DATABASE_URL);
  await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await migrate(db, path.resolve(import.meta.dirname, '../../infra/database/migrations'));
  const config = loadConfig({
    DATABASE_URL: TEST_DATABASE_URL,
    LICENSE_SIGNING_PRIVATE_KEY: keys.privateKeyPem,
    ...extra,
  });
  const app = await buildApp({ db, config, providers });
  const address = await app.listen({ host: '127.0.0.1', port: 0 });
  await createUser(db, {
    email: 'admin@jarvis.test',
    password: 'admin-password-123',
    role: 'admin',
    name: 'Admin',
  });
  const call = async (
    method: string,
    url: string,
    body?: unknown,
    token?: string,
    headers: Record<string, string> = {},
  ) => {
    const res = await fetch(`${address}${url}`, {
      method,
      headers: {
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...headers,
      },
      body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
    });
    const text = await res.text();
    let json: unknown = text;
    try {
      json = JSON.parse(text);
    } catch {
      /* keep text */
    }
    return { status: res.status, body: json as Record<string, unknown> & Array<Record<string, unknown>> };
  };
  const adminToken = (
    await call('POST', '/v1/auth/login', { email: 'admin@jarvis.test', password: 'admin-password-123' })
  ).body.token as string;
  return {
    app,
    db,
    keys,
    address,
    call,
    adminToken,
    close: async () => {
      await app.close();
      await db.end();
    },
  };
}
