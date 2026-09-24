import { createHmac, timingSafeEqual } from 'node:crypto';
import {
  WebhookVerificationError,
  type BillingEvent,
  type BillingProvider,
  type CheckoutRequest,
  type CheckoutSession,
} from '@jarvis/billing-core';

/**
 * Stripe adapter (REST, no SDK). Uses Checkout Sessions. When price IDs are
 * configured (STRIPE_PRICE_MONTHLY / STRIPE_PRICE_YEARLY) it creates recurring
 * subscriptions; otherwise one-off payments per billing period.
 * Webhook signatures follow Stripe's scheme: header `Stripe-Signature: t=..,v1=..`
 * where v1 = HMAC-SHA256(secret, `${t}.${rawBody}`).
 * NOTE: confirm PKR availability for your Stripe account/country before enabling.
 */
export class StripeProvider implements BillingProvider {
  readonly id = 'stripe';
  constructor(
    private readonly cfg: {
      secretKey?: string;
      webhookSecret?: string;
      priceMonthly?: string;
      priceYearly?: string;
      toleranceSec?: number;
    },
    private readonly f: typeof fetch = fetch,
  ) {}

  isConfigured(): boolean {
    return !!this.cfg.secretKey && !!this.cfg.webhookSecret;
  }

  async createCheckout(req: CheckoutRequest): Promise<CheckoutSession> {
    if (!this.cfg.secretKey) throw new Error('Stripe not configured');
    const price = req.plan.code === 'yearly' ? this.cfg.priceYearly : this.cfg.priceMonthly;
    const form = new URLSearchParams();
    form.set('success_url', req.successUrl);
    form.set('cancel_url', req.cancelUrl);
    form.set('customer_email', req.customerEmail);
    form.set('client_reference_id', req.customerId);
    form.set('metadata[customer_id]', req.customerId);
    form.set('metadata[plan_code]', req.plan.code);
    form.set('line_items[0][quantity]', '1');
    if (price) {
      form.set('mode', 'subscription');
      form.set('line_items[0][price]', price);
      form.set('subscription_data[metadata][customer_id]', req.customerId);
      form.set('subscription_data[metadata][plan_code]', req.plan.code);
    } else {
      form.set('mode', 'payment');
      form.set('line_items[0][price_data][currency]', req.plan.currency.toLowerCase());
      form.set('line_items[0][price_data][unit_amount]', String(req.plan.amount * 100)); // PKR is a two-decimal currency in Stripe
      form.set('line_items[0][price_data][product_data][name]', req.plan.name);
    }
    const res = await this.f('https://api.stripe.com/v1/checkout/sessions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.cfg.secretKey}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: form,
    });
    const j = (await res.json()) as { id?: string; url?: string; error?: { message?: string } };
    if (!res.ok || !j.id) throw new Error(`Stripe checkout failed: ${j.error?.message ?? res.status}`);
    return { provider: this.id, reference: j.id, url: j.url };
  }

  verifySignature(rawBody: Buffer, header: string | undefined, nowSec = Math.floor(Date.now() / 1000)): void {
    if (!this.cfg.webhookSecret) throw new WebhookVerificationError('Stripe webhook secret not configured');
    if (!header) throw new WebhookVerificationError('Missing Stripe-Signature header');
    const parts = header.split(',').map((p) => p.split('=') as [string, string]);
    const t = Number(parts.find(([k]) => k === 't')?.[1]);
    const sigs = parts.filter(([k]) => k === 'v1').map(([, v]) => v);
    if (!t || !sigs.length) throw new WebhookVerificationError('Malformed Stripe-Signature header');
    if (Math.abs(nowSec - t) > (this.cfg.toleranceSec ?? 300))
      throw new WebhookVerificationError('Stripe webhook timestamp outside tolerance (possible replay)');
    const expected = createHmac('sha256', this.cfg.webhookSecret).update(`${t}.`).update(rawBody).digest();
    const ok = sigs.some((s) => {
      const b = Buffer.from(s, 'hex');
      return b.length === expected.length && timingSafeEqual(b, expected);
    });
    if (!ok) throw new WebhookVerificationError('Invalid Stripe webhook signature');
  }

  async parseWebhook(
    rawBody: Buffer,
    headers: Record<string, string | string[] | undefined>,
  ): Promise<BillingEvent[]> {
    const h = headers['stripe-signature'];
    this.verifySignature(rawBody, Array.isArray(h) ? h[0] : h);
    const evt = JSON.parse(rawBody.toString('utf8')) as {
      id: string;
      type: string;
      created: number;
      data: { object: Record<string, unknown> };
    };
    const o = evt.data.object;
    const meta = (o.metadata ?? {}) as Record<string, string>;
    const occurredAt = new Date(evt.created * 1000);
    const amount =
      typeof o.amount_total === 'number'
        ? o.amount_total / 100
        : typeof o.amount_paid === 'number'
          ? o.amount_paid / 100
          : undefined;
    const currency = typeof o.currency === 'string' ? o.currency.toUpperCase() : undefined;
    if (evt.type === 'checkout.session.completed' && o.payment_status === 'paid') {
      return [
        {
          provider: this.id,
          providerEventId: evt.id,
          type: 'payment.succeeded',
          customerRef: meta.customer_id ?? (o.client_reference_id as string),
          planCode: meta.plan_code as 'monthly' | 'yearly',
          amount,
          currency,
          occurredAt,
          subscriptionRef: (o.subscription as string) ?? undefined,
        },
      ];
    }
    if (evt.type === 'invoice.paid' && o.billing_reason === 'subscription_cycle') {
      const subMeta = ((o.subscription_details as { metadata?: Record<string, string> } | undefined)
        ?.metadata ??
        (o.parent as { subscription_details?: { metadata?: Record<string, string> } } | undefined)
          ?.subscription_details?.metadata ??
        {}) as Record<string, string>;
      return [
        {
          provider: this.id,
          providerEventId: evt.id,
          type: 'subscription.renewed',
          customerRef: subMeta.customer_id,
          planCode: subMeta.plan_code as 'monthly' | 'yearly',
          amount,
          currency,
          occurredAt,
          subscriptionRef: o.subscription as string,
        },
      ];
    }
    if (evt.type === 'invoice.payment_failed')
      return [
        {
          provider: this.id,
          providerEventId: evt.id,
          type: 'payment.failed',
          occurredAt,
          subscriptionRef: o.subscription as string,
        },
      ];
    if (evt.type === 'customer.subscription.deleted')
      return [
        {
          provider: this.id,
          providerEventId: evt.id,
          type: 'subscription.canceled',
          occurredAt,
          subscriptionRef: o.id as string,
          customerRef: meta.customer_id,
        },
      ];
    return [];
  }
}
