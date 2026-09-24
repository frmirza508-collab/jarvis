import {
  addInterval,
  reconcileStatus,
  type BillingInterval,
  type SubscriptionStatus,
} from '@jarvis/billing-core';
import { JarvisError } from '@jarvis/shared';
import type { Db, Queryable } from '../db.js';
import { tx } from '../db.js';
import { audit } from '../audit.js';
import { getSettings, policyOf } from './settings.js';

export interface SubscriptionRow {
  id: string;
  user_id: string;
  plan_code: string;
  status: SubscriptionStatus;
  current_period_start: Date;
  current_period_end: Date;
  provider: string;
  provider_ref: string | null;
  suspended_reason: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface PlanRow {
  code: string;
  name: string;
  amount: number;
  currency: string;
  interval: BillingInterval;
  interval_count: number;
  entitlements: string[];
  active: boolean;
}

export async function getPlan(db: Queryable, code: string): Promise<PlanRow> {
  const r = await db.query<PlanRow>('SELECT * FROM plans WHERE code = $1', [code]);
  if (!r.rows[0]) throw new JarvisError('NOT_FOUND', `Unknown plan ${code}`);
  return r.rows[0];
}

/** Latest subscription for a user (the one that governs entitlements). */
export async function currentSubscription(
  db: Queryable,
  userId: string,
): Promise<SubscriptionRow | undefined> {
  return (
    await db.query<SubscriptionRow>(
      'SELECT * FROM subscriptions WHERE user_id = $1 ORDER BY current_period_end DESC LIMIT 1',
      [userId],
    )
  ).rows[0];
}

/**
 * Apply a confirmed payment: extends the current period if still running,
 * otherwise starts a new period now (reactivation after expiry).
 */
export async function applyPayment(
  db: Db,
  p: {
    userId: string;
    planCode: string;
    provider: string;
    providerPaymentId: string;
    amount: number;
    currency: string;
    occurredAt: Date;
    providerRef?: string;
    actor: { type: 'admin' | 'provider' | 'system'; id?: string };
    note?: string;
  },
): Promise<{ subscription: SubscriptionRow; duplicate: boolean }> {
  return tx(db, async (c) => {
    const plan = await getPlan(c, p.planCode);
    if (p.currency.toUpperCase() !== plan.currency || p.amount < plan.amount)
      throw new JarvisError(
        'INVALID_INPUT',
        `Payment ${p.amount} ${p.currency} does not cover plan ${plan.code} (${plan.amount} ${plan.currency})`,
      );
    const ins = await c.query(
      `INSERT INTO payments (user_id, provider, provider_payment_id, plan_code, amount, currency, status, note)
       VALUES ($1, $2, $3, $4, $5, $6, 'succeeded', $7) ON CONFLICT (provider, provider_payment_id) DO NOTHING RETURNING id`,
      [
        p.userId,
        p.provider,
        p.providerPaymentId,
        plan.code,
        p.amount,
        p.currency.toUpperCase(),
        p.note ?? null,
      ],
    );
    const existing = await currentSubscription(c, p.userId);
    if (ins.rowCount === 0) {
      if (!existing) throw new JarvisError('INTERNAL', 'Duplicate payment without subscription');
      return { subscription: existing, duplicate: true };
    }
    const now = new Date();
    let sub: SubscriptionRow;
    if (
      existing &&
      existing.status !== 'suspended' &&
      existing.current_period_end > now &&
      existing.status !== 'expired'
    ) {
      const end = addInterval(existing.current_period_end, plan.interval, plan.interval_count);
      sub = (
        await c.query<SubscriptionRow>(
          `UPDATE subscriptions SET plan_code = $2, status = 'active', current_period_end = $3, provider = $4, provider_ref = COALESCE($5, provider_ref), updated_at = now() WHERE id = $1 RETURNING *`,
          [existing.id, plan.code, end, p.provider, p.providerRef ?? null],
        )
      ).rows[0]!;
    } else if (existing && existing.status === 'suspended') {
      throw new JarvisError(
        'PERMISSION_DENIED',
        'Subscription is suspended; an administrator must reactivate it',
      );
    } else {
      const start = now;
      const end = addInterval(start, plan.interval, plan.interval_count);
      if (existing) {
        sub = (
          await c.query<SubscriptionRow>(
            `UPDATE subscriptions SET plan_code = $2, status = 'active', current_period_start = $3, current_period_end = $4, provider = $5, provider_ref = COALESCE($6, provider_ref), updated_at = now() WHERE id = $1 RETURNING *`,
            [existing.id, plan.code, start, end, p.provider, p.providerRef ?? null],
          )
        ).rows[0]!;
      } else {
        sub = (
          await c.query<SubscriptionRow>(
            `INSERT INTO subscriptions (user_id, plan_code, status, current_period_start, current_period_end, provider, provider_ref) VALUES ($1, $2, 'active', $3, $4, $5, $6) RETURNING *`,
            [p.userId, plan.code, start, end, p.provider, p.providerRef ?? null],
          )
        ).rows[0]!;
      }
    }
    await c.query('UPDATE payments SET subscription_id = $1 WHERE id = $2', [sub.id, ins.rows[0].id]);
    await c.query('UPDATE licenses SET subscription_id = $1 WHERE user_id = $2 AND subscription_id IS NULL', [
      sub.id,
      p.userId,
    ]);
    await audit(c, {
      actorType: p.actor.type,
      actorId: p.actor.id,
      action: 'subscription.payment_applied',
      targetType: 'subscription',
      targetId: sub.id,
      details: {
        plan: plan.code,
        amount: p.amount,
        currency: p.currency,
        provider: p.provider,
        periodEnd: sub.current_period_end,
      },
    });
    return { subscription: sub, duplicate: false };
  });
}

type AdminAction = 'suspend' | 'reactivate' | 'cancel' | 'expire';

export async function adminSetStatus(
  db: Db,
  id: string,
  action: AdminAction,
  actorId: string,
  reason?: string,
): Promise<SubscriptionRow> {
  return tx(db, async (c) => {
    const cur = (await c.query<SubscriptionRow>('SELECT * FROM subscriptions WHERE id = $1 FOR UPDATE', [id]))
      .rows[0];
    if (!cur) throw new JarvisError('NOT_FOUND', 'Subscription not found');
    let status: SubscriptionStatus;
    if (action === 'suspend') status = 'suspended';
    else if (action === 'cancel') status = 'canceled';
    else if (action === 'expire') status = 'expired';
    else {
      const s = await getSettings(c);
      status = reconcileStatus(
        { status: 'active', currentPeriodEnd: cur.current_period_end },
        policyOf(s),
        new Date(),
      );
    }
    const r = await c.query<SubscriptionRow>(
      'UPDATE subscriptions SET status = $2, suspended_reason = $3, updated_at = now() WHERE id = $1 RETURNING *',
      [id, status, action === 'suspend' ? (reason ?? null) : null],
    );
    await audit(c, {
      actorType: 'admin',
      actorId,
      action: `subscription.${action}`,
      targetType: 'subscription',
      targetId: id,
      details: { from: cur.status, to: status, reason },
    });
    return r.rows[0]!;
  });
}

export async function adminExtend(
  db: Db,
  id: string,
  days: number,
  actorId: string,
  reason?: string,
): Promise<SubscriptionRow> {
  return tx(db, async (c) => {
    const cur = (await c.query<SubscriptionRow>('SELECT * FROM subscriptions WHERE id = $1 FOR UPDATE', [id]))
      .rows[0];
    if (!cur) throw new JarvisError('NOT_FOUND', 'Subscription not found');
    const base = cur.current_period_end > new Date() ? cur.current_period_end : new Date();
    const end = new Date(base.getTime() + days * 86_400_000);
    const status: SubscriptionStatus = cur.status === 'suspended' ? 'suspended' : 'active';
    const r = await c.query<SubscriptionRow>(
      'UPDATE subscriptions SET current_period_end = $2, status = $3, updated_at = now() WHERE id = $1 RETURNING *',
      [id, end, status],
    );
    await audit(c, {
      actorType: 'admin',
      actorId,
      action: 'subscription.extend',
      targetType: 'subscription',
      targetId: id,
      details: { days, newEnd: end, reason },
    });
    return r.rows[0]!;
  });
}

/** Periodic job: move subscriptions to past_due/expired based on server time and policy. */
export async function reconcileAll(db: Db, now = new Date()): Promise<number> {
  const s = await getSettings(db);
  const policy = policyOf(s);
  const rows = (
    await db.query<SubscriptionRow>(
      "SELECT * FROM subscriptions WHERE status IN ('active', 'past_due', 'canceled') AND current_period_end <= $1",
      [now],
    )
  ).rows;
  let changed = 0;
  for (const sub of rows) {
    const next = reconcileStatus(
      { status: sub.status, currentPeriodEnd: sub.current_period_end },
      policy,
      now,
    );
    if (next !== sub.status) {
      await db.query(
        'UPDATE subscriptions SET status = $2, updated_at = now() WHERE id = $1 AND status = $3',
        [sub.id, next, sub.status],
      );
      await audit(db, {
        actorType: 'system',
        action: `subscription.${next}`,
        targetType: 'subscription',
        targetId: sub.id,
        details: { from: sub.status, periodEnd: sub.current_period_end },
      });
      changed++;
    }
  }
  return changed;
}
