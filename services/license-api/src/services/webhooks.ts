import type { BillingEvent, BillingProvider } from '@jarvis/billing-core';
import { WebhookVerificationError } from '@jarvis/billing-core';
import type { Db } from '../db.js';
import { audit } from '../audit.js';
import { applyPayment } from './subscriptions.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function resolveUser(db: Db, e: BillingEvent): Promise<string | undefined> {
  if (e.customerRef && UUID.test(e.customerRef)) {
    const r = await db.query<{ id: string }>('SELECT id FROM users WHERE id = $1', [e.customerRef]);
    if (r.rows[0]) return r.rows[0].id;
  }
  if (e.customerEmail) {
    const r = await db.query<{ id: string }>('SELECT id FROM users WHERE email = $1', [e.customerEmail]);
    if (r.rows[0]) return r.rows[0].id;
  }
  if (e.subscriptionRef) {
    const r = await db.query<{ user_id: string }>('SELECT user_id FROM subscriptions WHERE provider = $1 AND provider_ref = $2', [e.provider, e.subscriptionRef]);
    if (r.rows[0]) return r.rows[0].user_id;
  }
  return undefined;
}

export type WebhookOutcome = { status: 'processed' | 'duplicate' | 'ignored'; events: number };

/**
 * Verified-then-idempotent webhook processing. Signature verification happens
 * in the provider BEFORE anything is persisted; unverifiable requests are rejected.
 */
export async function handleWebhook(db: Db, provider: BillingProvider, rawBody: Buffer, headers: Record<string, string | string[] | undefined>, ip?: string): Promise<WebhookOutcome> {
  let events: BillingEvent[];
  try {
    events = await provider.parseWebhook(rawBody, headers);
  } catch (e) {
    await audit(db, { actorType: 'provider', actorId: provider.id, action: 'webhook.rejected', ip, details: { reason: (e as Error).message } });
    throw e instanceof WebhookVerificationError ? e : new WebhookVerificationError((e as Error).message);
  }
  if (!events.length) return { status: 'ignored', events: 0 };
  let processed = 0;
  for (const e of events) {
    const ins = await db.query<{ id: string }>(
      'INSERT INTO webhook_events (provider, provider_event_id, type, payload) VALUES ($1, $2, $3, $4) ON CONFLICT (provider, provider_event_id) DO NOTHING RETURNING id',
      [e.provider, e.providerEventId, e.type, JSON.stringify({ ...e, raw: undefined })],
    );
    if (!ins.rows[0]) continue; // replay/duplicate delivery
    const id = ins.rows[0].id;
    try {
      const userId = await resolveUser(db, e);
      if (e.type === 'payment.succeeded' || e.type === 'subscription.renewed') {
        if (!userId || !e.planCode || e.amount === undefined || !e.currency) throw new Error('Event missing customer, plan or amount');
        await applyPayment(db, { userId, planCode: e.planCode, provider: e.provider, providerPaymentId: e.providerEventId, amount: e.amount, currency: e.currency, occurredAt: e.occurredAt, providerRef: e.subscriptionRef, actor: { type: 'provider', id: e.provider } });
      } else if (e.type === 'subscription.canceled' && userId) {
        await db.query("UPDATE subscriptions SET status = 'canceled', updated_at = now() WHERE user_id = $1 AND status IN ('active', 'past_due')", [userId]);
        await audit(db, { actorType: 'provider', actorId: e.provider, action: 'subscription.canceled', targetType: 'user', targetId: userId });
      } else {
        await audit(db, { actorType: 'provider', actorId: e.provider, action: `billing.${e.type}`, targetType: 'user', targetId: userId ?? null, details: { subscriptionRef: e.subscriptionRef } });
      }
      await db.query("UPDATE webhook_events SET status = 'processed', processed_at = now() WHERE id = $1", [id]);
      processed++;
    } catch (err) {
      await db.query("UPDATE webhook_events SET status = 'failed', error = $2, processed_at = now() WHERE id = $1", [id, (err as Error).message]);
      await audit(db, { actorType: 'provider', actorId: e.provider, action: 'webhook.failed', details: { eventId: e.providerEventId, error: (err as Error).message } });
    }
  }
  return { status: processed ? 'processed' : 'duplicate', events: processed };
}
