import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MemorySecretStore } from '@jarvis/security';
import { LicenseClient } from '../../services/orchestrator/src/license-client.js';
import { reconcileAll } from '../../services/license-api/src/services/subscriptions.js';
import { startLicenseServer } from '../helpers/license-server.js';

let srv: Awaited<ReturnType<typeof startLicenseServer>>;
beforeAll(async () => {
  srv = await startLicenseServer();
});
afterAll(async () => srv.close());

async function newCustomer(email: string) {
  const reg = await srv.call('POST', '/v1/auth/register', {
    email,
    password: 'customer-pass-123',
    name: 'Customer',
  });
  expect(reg.status).toBe(200);
  const login = await srv.call('POST', '/v1/auth/login', { email, password: 'customer-pass-123' });
  return { id: reg.body.id as string, token: login.body.token as string };
}

function desktop(fp: string, secrets = new MemorySecretStore()) {
  return new LicenseClient({
    apiUrl: srv.address,
    publicKeyPem: srv.keys.publicKeyPem,
    secrets,
    appVersion: 'test',
    fingerprint: fp.padEnd(64, '0'),
  });
}

describe('licensing end-to-end (real Postgres + real desktop client)', () => {
  it('monthly plan: pay -> license -> activate -> premium', async () => {
    const c = await newCustomer('monthly@jarvis.test');
    const pay = await srv.call(
      'POST',
      '/v1/admin/payments/manual',
      { userId: c.id, plan: 'monthly', amount: 4000, reference: 'BANK-001' },
      srv.adminToken,
    );
    expect(pay.status).toBe(200);
    const sub = pay.body.subscription as {
      status: string;
      current_period_end: string;
      current_period_start: string;
    };
    expect(sub.status).toBe('active');
    const days = (Date.parse(sub.current_period_end) - Date.parse(sub.current_period_start)) / 86_400_000;
    expect(days).toBeGreaterThanOrEqual(28);
    expect(days).toBeLessThanOrEqual(31);

    const lic = await srv.call('POST', '/v1/me/licenses', {}, c.token);
    expect(lic.body.key).toMatch(/^JRV(-[0-9A-Z]{5}){4}$/);
    const client = desktop('aa');
    await client.init();
    const st = await client.activate(lic.body.key as string);
    expect(st).toMatchObject({ premium: true, plan: 'monthly', status: 'active' });
    expect(client.checkEntitlement().premium).toBe(true);

    // duplicate payment reference is idempotent
    const dup = await srv.call(
      'POST',
      '/v1/admin/payments/manual',
      { userId: c.id, plan: 'monthly', amount: 4000, reference: 'BANK-001' },
      srv.adminToken,
    );
    expect(dup.body.duplicate).toBe(true);
  });

  it('rejects underpayment', async () => {
    const c = await newCustomer('under@jarvis.test');
    const r = await srv.call(
      'POST',
      '/v1/admin/payments/manual',
      { userId: c.id, plan: 'yearly', amount: 4000, reference: 'BANK-UNDER' },
      srv.adminToken,
    );
    expect(r.status).toBe(400);
  });

  it('yearly plan grants ~1 year', async () => {
    const c = await newCustomer('yearly@jarvis.test');
    const pay = await srv.call(
      'POST',
      '/v1/admin/payments/manual',
      { userId: c.id, plan: 'yearly', amount: 40000, reference: 'BANK-Y1' },
      srv.adminToken,
    );
    const sub = pay.body.subscription as { current_period_end: string; current_period_start: string };
    const days = (Date.parse(sub.current_period_end) - Date.parse(sub.current_period_start)) / 86_400_000;
    expect(days).toBeGreaterThanOrEqual(365);
    expect(days).toBeLessThanOrEqual(366);
    const lic = await srv.call('POST', '/v1/me/licenses', {}, c.token);
    const client = desktop('bb');
    await client.init();
    expect((await client.activate(lic.body.key as string)).plan).toBe('yearly');
  });

  it('expiry stops premium; payment reactivates', async () => {
    const c = await newCustomer('expire@jarvis.test');
    await srv.call(
      'POST',
      '/v1/admin/payments/manual',
      { userId: c.id, plan: 'monthly', amount: 4000, reference: 'BANK-E1' },
      srv.adminToken,
    );
    const lic = await srv.call('POST', '/v1/me/licenses', {}, c.token);
    const client = desktop('cc');
    await client.init();
    await client.activate(lic.body.key as string);
    expect(client.checkEntitlement().premium).toBe(true);

    await srv.db.query(
      "UPDATE subscriptions SET current_period_end = now() - interval '1 minute' WHERE user_id = $1",
      [c.id],
    );
    expect(await reconcileAll(srv.db)).toBeGreaterThanOrEqual(1);
    const st = await client.refresh();
    expect(st.premium).toBe(false);
    expect(st.status).toBe('expired');
    expect(client.checkEntitlement()).toMatchObject({ premium: false });

    await srv.call(
      'POST',
      '/v1/admin/payments/manual',
      { userId: c.id, plan: 'monthly', amount: 4000, reference: 'BANK-E2' },
      srv.adminToken,
    );
    const again = await client.refresh();
    expect(again).toMatchObject({ premium: true, status: 'active' });
  });

  it('grace period keeps past_due access, then expires', async () => {
    await srv.call('PUT', '/v1/admin/settings', { graceHours: 48 }, srv.adminToken);
    const c = await newCustomer('grace@jarvis.test');
    await srv.call(
      'POST',
      '/v1/admin/payments/manual',
      { userId: c.id, plan: 'monthly', amount: 4000, reference: 'BANK-G1' },
      srv.adminToken,
    );
    const lic = await srv.call('POST', '/v1/me/licenses', {}, c.token);
    const client = desktop('dd');
    await client.init();
    await client.activate(lic.body.key as string);
    await srv.db.query(
      "UPDATE subscriptions SET current_period_end = now() - interval '1 hour' WHERE user_id = $1",
      [c.id],
    );
    await reconcileAll(srv.db);
    expect(await client.refresh()).toMatchObject({ premium: true, status: 'past_due' });
    await srv.db.query(
      "UPDATE subscriptions SET current_period_end = now() - interval '49 hours' WHERE user_id = $1",
      [c.id],
    );
    await reconcileAll(srv.db);
    expect(await client.refresh()).toMatchObject({ premium: false, status: 'expired' });
    await srv.call('PUT', '/v1/admin/settings', { graceHours: 0 }, srv.adminToken);
  });

  it('enforces device limits and allows deactivation', async () => {
    const c = await newCustomer('devices@jarvis.test');
    await srv.call(
      'POST',
      '/v1/admin/payments/manual',
      { userId: c.id, plan: 'monthly', amount: 4000, reference: 'BANK-D1' },
      srv.adminToken,
    );
    const key = (await srv.call('POST', '/v1/me/licenses', {}, c.token)).body.key as string;
    const d1 = desktop('d1');
    const d2 = desktop('d2');
    const d3 = desktop('d3');
    for (const d of [d1, d2, d3]) await d.init();
    await d1.activate(key);
    await d2.activate(key);
    await expect(d3.activate(key)).rejects.toThrow(/Device limit/);
    await d2.deactivate();
    expect((await d3.activate(key)).premium).toBe(true);
    // a deactivated device cannot validate
    const secrets = new MemorySecretStore();
    secrets.set('LICENSE_KEY', key);
    const ghost = desktop('d2', secrets);
    await ghost.init();
    await expect(ghost.refresh()).rejects.toThrow(/deactivated/);
  });

  it('admin revocation blocks the device immediately on next check', async () => {
    const c = await newCustomer('revoke@jarvis.test');
    await srv.call(
      'POST',
      '/v1/admin/payments/manual',
      { userId: c.id, plan: 'yearly', amount: 40000, reference: 'BANK-R1' },
      srv.adminToken,
    );
    const lic = await srv.call('POST', '/v1/me/licenses', {}, c.token);
    const client = desktop('ee');
    await client.init();
    await client.activate(lic.body.key as string);
    const licId = lic.body.id as string;
    const rev = await srv.call(
      'POST',
      `/v1/admin/licenses/${licId}/revoke`,
      { reason: 'chargeback' },
      srv.adminToken,
    );
    expect(rev.body.status).toBe('revoked');
    await expect(client.refresh()).rejects.toThrow(/revoked/);
    expect(client.checkEntitlement().premium).toBe(false);
    await srv.call('POST', `/v1/admin/licenses/${licId}/reactivate`, {}, srv.adminToken);
    expect((await client.refresh()).premium).toBe(true);
  });

  it('suspension blocks and reactivation restores', async () => {
    const c = await newCustomer('suspend@jarvis.test');
    const pay = await srv.call(
      'POST',
      '/v1/admin/payments/manual',
      { userId: c.id, plan: 'monthly', amount: 4000, reference: 'BANK-S1' },
      srv.adminToken,
    );
    const subId = (pay.body.subscription as { id: string }).id;
    const client = desktop('ff');
    await client.init();
    await client.activate((await srv.call('POST', '/v1/me/licenses', {}, c.token)).body.key as string);
    await srv.call('POST', `/v1/admin/subscriptions/${subId}/suspend`, { reason: 'abuse' }, srv.adminToken);
    expect((await client.refresh()).premium).toBe(false);
    await srv.call('POST', `/v1/admin/subscriptions/${subId}/reactivate`, {}, srv.adminToken);
    expect((await client.refresh()).premium).toBe(true);
    const ext = await srv.call(
      'POST',
      `/v1/admin/subscriptions/${subId}/extend`,
      { days: 10, reason: 'goodwill' },
      srv.adminToken,
    );
    expect(ext.status).toBe(200);
  });

  it('rejects forged tokens from a server with a different key', async () => {
    const other = await import('@jarvis/licensing').then((m) => m.generateSigningKeys());
    const c = await newCustomer('forge@jarvis.test');
    await srv.call(
      'POST',
      '/v1/admin/payments/manual',
      { userId: c.id, plan: 'monthly', amount: 4000, reference: 'BANK-F1' },
      srv.adminToken,
    );
    const key = (await srv.call('POST', '/v1/me/licenses', {}, c.token)).body.key as string;
    const client = new LicenseClient({
      apiUrl: srv.address,
      publicKeyPem: other.publicKeyPem,
      secrets: new MemorySecretStore(),
      appVersion: 't',
      fingerprint: 'ab'.padEnd(64, '0'),
    });
    await client.init();
    await expect(client.activate(key)).rejects.toThrow();
    expect(client.checkEntitlement().premium).toBe(false);
  });

  it('protects admin routes and records audit events', async () => {
    const c = await newCustomer('nosy@jarvis.test');
    expect((await srv.call('GET', '/v1/admin/customers', undefined, c.token)).status).toBe(403);
    expect((await srv.call('GET', '/v1/admin/customers')).status).toBe(401);
    const list = await srv.call('GET', '/v1/admin/customers?q=monthly', undefined, srv.adminToken);
    expect(list.body[0]!.email).toBe('monthly@jarvis.test');
    const audit = await srv.call('GET', '/v1/admin/audit?action=license', undefined, srv.adminToken);
    const actions = (audit.body as unknown as Array<{ action: string }>).map((a) => a.action);
    expect(actions).toEqual(expect.arrayContaining(['license.issue', 'license.activate', 'license.revoke']));
    const dash = await srv.call('GET', '/v1/admin/dashboard', undefined, srv.adminToken);
    expect(dash.body.customers).toBeGreaterThan(3);
  });

  it('rejects malformed license requests and invalid keys', async () => {
    expect(
      (await srv.call('POST', '/v1/licenses/activate', { licenseKey: 'nope', fingerprint: 'x', nonce: 'y' }))
        .status,
    ).toBe(400);
    const r = await srv.call('POST', '/v1/licenses/validate', {
      licenseKey: 'JRV-AAAAA-BBBBB-CCCCC-DDDDD',
      fingerprint: 'a'.repeat(64),
      nonce: 'abcdef0123456789',
    });
    expect(r.status).toBe(404);
    expect(r.body.error).toBe('invalid_key');
  });
});
