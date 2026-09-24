import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import path from 'node:path';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import { build } from 'vite';
import { chromium, type Browser, type Dialog, type Page } from 'playwright-core';
import { startLicenseServer } from '../helpers/license-server.js';
import { serveDir } from '../helpers/static-server.js';
import { findChromium } from '../helpers/browser.js';

const exe = findChromium();
const d = exe ? describe : describe.skip;

d('admin portal (real browser, real license API + Postgres)', () => {
  let srv: Awaited<ReturnType<typeof startLicenseServer>>;
  let site: Awaited<ReturnType<typeof serveDir>>;
  let browser: Browser;
  let page: Page;
  let customerId: string;

  beforeAll(async () => {
    const out = mkdtempSync(path.join(os.tmpdir(), 'jarvis-admin-'));
    // CORS origin must be known before the API starts; serve first on a random port.
    site = await serveDir(out);
    srv = await startLicenseServer({ ADMIN_ORIGINS: site.url });
    process.env.VITE_LICENSE_API_URL = srv.address;
    const adminRoot = path.resolve(import.meta.dirname, '../../apps/admin');
    await build({
      root: adminRoot,
      configFile: path.join(adminRoot, 'vite.config.ts'),
      logLevel: 'error',
      build: { outDir: out, emptyOutDir: true },
    });
    delete process.env.VITE_LICENSE_API_URL;
    customerId = (
      await srv.call('POST', '/v1/auth/register', {
        email: 'buyer@jarvis.test',
        password: 'customer-pass-123',
        name: 'Buyer',
      })
    ).body.id as string;
    browser = await chromium.launch({ executablePath: exe, headless: true });
    page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
    page.on('pageerror', (e) => console.error('PAGE ERROR', e.message));
    page.on('console', (m) => m.type() === 'error' && console.error('CONSOLE', m.text()));
    page.on('requestfailed', (r) => console.error('REQFAIL', r.url(), r.failure()?.errorText));
    await page.goto(site.url);
  });
  afterAll(async () => {
    await browser?.close();
    await site?.close();
    await srv?.close();
  });

  it('rejects wrong credentials and signs in an admin', async () => {
    await page.getByLabel('Email').fill('admin@jarvis.test');
    await page.getByLabel('Password').fill('wrong-password');
    await page.getByRole('button', { name: 'Sign in' }).click();
    await page.getByRole('alert').waitFor();
    await page.getByLabel('Password').fill('admin-password-123');
    await page.getByRole('button', { name: 'Sign in' }).click();
    await page.getByRole('heading', { name: 'Dashboard' }).waitFor();
  });

  it('records a bank payment, issues a license and revokes it', async () => {
    await page.getByRole('link', { name: 'Customers' }).click();
    await page.getByRole('link', { name: 'buyer@jarvis.test' }).click();
    await page.getByLabel('Payment reference').fill('HBL-778899');
    await page.getByRole('button', { name: 'Confirm payment received' }).click();
    await page.locator('table').first().getByText('active').waitFor();
    await page.getByRole('button', { name: 'Issue license' }).click();
    const key = await page.locator('.notice code').innerText();
    expect(key).toMatch(/^JRV(-[0-9A-Z]{5}){4}$/);
    const answers: Array<string | undefined> = [undefined, 'customer request']; // confirm(), then reason prompt()
    const onDialog = (dlg: Dialog) => void dlg.accept(answers.shift());
    page.on('dialog', onDialog);
    await page.getByRole('button', { name: 'Revoke' }).click();
    await page.getByText('revoked', { exact: true }).first().waitFor();
    page.off('dialog', onDialog);
    const lic = await srv.db.query('SELECT status, revoked_reason FROM licenses WHERE user_id = $1', [
      customerId,
    ]);
    expect(lic.rows[0]).toEqual({ status: 'revoked', revoked_reason: 'customer request' });
    const pay = await srv.db.query(
      'SELECT amount, currency, provider_payment_id FROM payments WHERE user_id = $1',
      [customerId],
    );
    expect(pay.rows[0]).toEqual({ amount: 4000, currency: 'PKR', provider_payment_id: 'HBL-778899' });
  });

  it('lists plans with the product prices and shows the audit trail', async () => {
    await page.getByRole('link', { name: 'Plans' }).click();
    await page.getByText('4,000 PKR').waitFor();
    await page.getByText('40,000 PKR').waitFor();
    await page.getByRole('link', { name: 'Audit Logs' }).click();
    await page.getByText('license.revoke').first().waitFor();
    await page.screenshot({ path: path.resolve(import.meta.dirname, '../../test-results/admin-audit.png') });
  });

  it('saves settings (PUT through CORS)', async () => {
    await page.getByRole('link', { name: 'Settings' }).click();
    await page.getByLabel(/Grace period/).fill('24');
    await page.getByRole('button', { name: 'Save settings' }).click();
    await page.getByText('Saved').waitFor();
    const s = await srv.db.query("SELECT value FROM settings WHERE key = 'grace_hours'");
    expect(s.rows[0].value).toBe(24);
  });
});
