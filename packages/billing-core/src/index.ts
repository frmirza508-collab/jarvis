import { z } from 'zod';

// ---------------------------------------------------------------------------
// Plans (product-owner pricing). Amounts are in whole PKR; provider adapters
// convert to minor units where their API requires it.
// ---------------------------------------------------------------------------
export type BillingInterval = 'month' | 'year';

export interface Plan {
  code: 'monthly' | 'yearly';
  name: string;
  amount: number;
  currency: 'PKR';
  interval: BillingInterval;
  intervalCount: number;
  entitlements: string[];
}

export const PREMIUM_ENTITLEMENTS = [
  'premium.execution',
  'agents.all',
  'voice',
  'computer-control',
  'browser',
  'research',
  'coding',
] as const;

export const PLANS: Record<Plan['code'], Plan> = {
  monthly: {
    code: 'monthly',
    name: 'JARVIS Monthly',
    amount: 4000,
    currency: 'PKR',
    interval: 'month',
    intervalCount: 1,
    entitlements: [...PREMIUM_ENTITLEMENTS],
  },
  yearly: {
    code: 'yearly',
    name: 'JARVIS Yearly',
    amount: 40000,
    currency: 'PKR',
    interval: 'year',
    intervalCount: 1,
    entitlements: [...PREMIUM_ENTITLEMENTS],
  },
};

/** Add calendar months, clamping to month end (Jan 31 + 1 month = Feb 28/29). */
export function addInterval(from: Date, interval: BillingInterval, count = 1): Date {
  const d = new Date(from.getTime());
  const months = interval === 'year' ? 12 * count : count;
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + months);
  const lastDay = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, lastDay));
  return d;
}

// ---------------------------------------------------------------------------
// Subscription state machine
// ---------------------------------------------------------------------------
export const SUBSCRIPTION_STATUSES = ['active', 'past_due', 'canceled', 'expired', 'suspended'] as const;
export type SubscriptionStatus = (typeof SUBSCRIPTION_STATUSES)[number];

export interface EntitlementPolicy {
  /** Hours after period end during which past_due subscriptions keep premium access. 0 = none. */
  graceHours: number;
  /** Whether canceled subscriptions keep access until the paid period ends. */
  canceledKeepsAccessUntilPeriodEnd: boolean;
}

export const DEFAULT_POLICY: EntitlementPolicy = { graceHours: 0, canceledKeepsAccessUntilPeriodEnd: true };

export interface SubscriptionSnapshot {
  status: SubscriptionStatus;
  currentPeriodEnd: Date;
}

/**
 * Server-side decision: until when (if at all) premium execution is allowed.
 * Returns null when no premium access applies at `now`.
 */
export function entitlementUntil(
  sub: SubscriptionSnapshot,
  policy: EntitlementPolicy,
  now: Date,
): Date | null {
  const end = sub.currentPeriodEnd.getTime();
  const grace = policy.graceHours * 3_600_000;
  let until: number | null = null;
  switch (sub.status) {
    case 'active':
      until = end + grace;
      break;
    case 'past_due':
      until = end + grace;
      break;
    case 'canceled':
      until = policy.canceledKeepsAccessUntilPeriodEnd ? end : null;
      break;
    case 'expired':
    case 'suspended':
      until = null;
  }
  if (until === null || until <= now.getTime()) return null;
  return new Date(until);
}

/** Status to persist when time passes (run by the expiry job). */
export function reconcileStatus(
  sub: SubscriptionSnapshot,
  policy: EntitlementPolicy,
  now: Date,
): SubscriptionStatus {
  if (sub.status === 'suspended' || sub.status === 'expired') return sub.status;
  const end = sub.currentPeriodEnd.getTime();
  if (now.getTime() < end) return sub.status;
  if (sub.status === 'canceled') return 'expired';
  if (now.getTime() >= end + policy.graceHours * 3_600_000) return 'expired';
  return 'past_due';
}

// ---------------------------------------------------------------------------
// Provider-agnostic billing interface
// ---------------------------------------------------------------------------

/** Normalised event every provider webhook maps into. */
export const BillingEventSchema = z.object({
  provider: z.string(),
  providerEventId: z.string(),
  type: z.enum([
    'payment.succeeded',
    'payment.failed',
    'subscription.renewed',
    'subscription.canceled',
    'refund.issued',
  ]),
  customerRef: z.string().optional(),
  customerEmail: z.string().email().optional(),
  subscriptionRef: z.string().optional(),
  planCode: z.enum(['monthly', 'yearly']).optional(),
  amount: z.number().nonnegative().optional(),
  currency: z.string().optional(),
  occurredAt: z.coerce.date(),
  /** Provider-reported period end, if available. */
  periodEnd: z.coerce.date().optional(),
  raw: z.unknown().optional(),
});
export type BillingEvent = z.infer<typeof BillingEventSchema>;

export interface CheckoutRequest {
  plan: Plan;
  customerEmail: string;
  customerId: string;
  successUrl: string;
  cancelUrl: string;
}

export interface CheckoutSession {
  provider: string;
  url?: string;
  reference: string;
  /** Human instructions for offline methods (bank transfer etc.). */
  instructions?: string;
}

export interface BillingProvider {
  readonly id: string;
  isConfigured(): boolean;
  createCheckout(req: CheckoutRequest): Promise<CheckoutSession>;
  /** Verify the webhook signature against the RAW body and map to normalised events. Throws when invalid. */
  parseWebhook(
    rawBody: Buffer,
    headers: Record<string, string | string[] | undefined>,
  ): Promise<BillingEvent[]>;
}

export class WebhookVerificationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WebhookVerificationError';
  }
}
