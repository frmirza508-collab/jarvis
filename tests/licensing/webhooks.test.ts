import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHmac } from 'node:crypto';
import { SignedGatewayProvider } from '../../services/license-api/src/providers/gateway.js';
import { startLicenseServer } from '../helpers/license-server.js';

const STRIPE_SECRET = 'whsec_test_secret_value_123';
const GATEWAY_SECRET = 'gateway-shared-secret-0123456789';
let srv: Awaited<ReturnType<typeof startLicenseServer>>;
let userId: string;

beforeAll(async () => {
  srv = await startLicenseServer({ STRIPE_SECRET_KEY: 'sk_test_dummy', STRIPE_WEBHOOK_SECRET: STRIPE_SECRET, GATEWAY_WEBHOOK_SECRET: GATEWAY_SECRET });
  userId = (await srv.call('POST', '/v1/auth/register', { email: 'hook@jarvis.test', password: 'customer-pass-123' })).body.id as string;
});
afterAll(async () => srv.close());

function stripeEvent(id: string, amountTotal = 400000) {
  return JSON.stringify({ id, type: 'checkout.session.completed', created: Math.floor(Date.now() / 1000), data: { object: { payment_status: 'paid', amount_total: amountTotal, currency: 'pkr', client_reference_id: userId, metadata: { customer_id: userId, plan_code: 'monthly' } } } });
}
function stripeSig(body: string, t = Math.floor(Date.now() / 1000), secret = STRIPE_SECRET) {
  return `t=${t},v1=${createHmac('sha256', secret).update(`${t}.${body}`).digest('hex')}`;
}

describe('payment webhooks', () => {
  it('rejects unsigned and wrongly signed Stripe webhooks without side effects', async () => {
    const body = stripeEvent('evt_bad');
    expect((await srv.call('POST', '/v1/webhooks/stripe', body)).status).toBe(400);
    expect((await srv.call('POST', '/v1/webhooks/stripe', body, undefined, { 'Stripe-Signature': stripeSig(body, undefined, 'whsec_wrong') })).status).toBe(400);
    const stale = Math.floor(Date.now() / 1000) - 3600;
    expect((await srv.call('POST', '/v1/webhooks/stripe', body, undefined, { 'Stripe-Signature': stripeSig(body, stale) })).status).toBe(400);
    const subs = await srv.db.query('SELECT * FROM subscriptions WHERE user_id = $1', [userId]);
    expect(subs.rowCount).toBe(0);
    const rejected = await srv.db.query("SELECT * FROM audit_events WHERE action = 'webhook.rejected'");
    expect(rejected.rowCount).toBeGreaterThanOrEqual(3);
  });

  it('activates a subscription from a verified Stripe webhook exactly once', async () => {
    const body = stripeEvent('evt_ok_1');
    const r1 = await srv.call('POST', '/v1/webhooks/stripe', body, undefined, { 'Stripe-Signature': stripeSig(body) });
    expect(r1.status).toBe(200);
    expect(r1.body.status).toBe('processed');
    const r2 = await srv.call('POST', '/v1/webhooks/stripe', body, undefined, { 'Stripe-Signature': stripeSig(body) });
    expect(r2.body.status).toBe('duplicate');
    const subs = await srv.db.query('SELECT status FROM subscriptions WHERE user_id = $1', [userId]);
    expect(subs.rows).toEqual([{ status: 'active' }]);
    const pays = await srv.db.query('SELECT amount, currency FROM payments WHERE user_id = $1', [userId]);
    expect(pays.rows).toEqual([{ amount: 4000, currency: 'PKR' }]);
  });

  it('records failed processing for an underpaid webhook', async () => {
    const body = stripeEvent('evt_under', 1000);
    const r = await srv.call('POST', '/v1/webhooks/stripe', body, undefined, { 'Stripe-Signature': stripeSig(body) });
    expect(r.status).toBe(200);
    const ev = await srv.db.query("SELECT status, error FROM webhook_events WHERE provider_event_id = 'evt_under'");
    expect(ev.rows[0].status).toBe('failed');
  });

  it('accepts HMAC-signed gateway events and rejects tampering', async () => {
    const body = JSON.stringify([{ providerEventId: 'gw-1', type: 'payment.succeeded', customerRef: userId, planCode: 'yearly', amount: 40000, currency: 'PKR', occurredAt: new Date().toISOString() }]);
    const ts = Math.floor(Date.now() / 1000);
    const sig = SignedGatewayProvider.sign(GATEWAY_SECRET, ts, body);
    const bad = await srv.call('POST', '/v1/webhooks/gateway', body.replace('40000', '50000'), undefined, { 'X-Jarvis-Timestamp': String(ts), 'X-Jarvis-Signature': sig });
    expect(bad.status).toBe(400);
    const ok = await srv.call('POST', '/v1/webhooks/gateway', body, undefined, { 'X-Jarvis-Timestamp': String(ts), 'X-Jarvis-Signature': sig });
    expect(ok.body.status).toBe('processed');
    const sub = await srv.db.query('SELECT plan_code FROM subscriptions WHERE user_id = $1', [userId]);
    expect(sub.rows[0].plan_code).toBe('yearly');
  });

  it('returns 404 for unconfigured providers', async () => {
    expect((await srv.call('POST', '/v1/webhooks/unknown', '{}')).status).toBe(404);
  });

  it('rate-limits license endpoints', async () => {
    let limited = false;
    for (let i = 0; i < 40 && !limited; i++) {
      const r = await srv.call('POST', '/v1/licenses/validate', { licenseKey: 'JRV-AAAAA-BBBBB-CCCCC-DDDDD', fingerprint: 'a'.repeat(64), nonce: 'abcdef0123456789' });
      if (r.status === 429) limited = true;
    }
    expect(limited).toBe(true);
  });
});
