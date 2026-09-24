import { createHmac, timingSafeEqual } from 'node:crypto';
import { BillingEventSchema, WebhookVerificationError, type BillingEvent, type BillingProvider, type CheckoutRequest, type CheckoutSession } from '@jarvis/billing-core';

/**
 * Generic signed-webhook gateway for payment processors without a built-in
 * adapter (e.g. a Pakistan gateway integrated through your own bridge
 * service). The bridge verifies the processor's callback using that
 * processor's official method, then POSTs a normalised event here signed as:
 *   X-Jarvis-Timestamp: <unix seconds>
 *   X-Jarvis-Signature: sha256=<hex HMAC-SHA256(GATEWAY_WEBHOOK_SECRET, `${timestamp}.${rawBody}`)>
 * Body: a JSON array (or object) of normalised BillingEvent fields.
 */
export class SignedGatewayProvider implements BillingProvider {
  readonly id = 'gateway';
  constructor(private readonly cfg: { secret?: string; checkoutUrl?: string; toleranceSec?: number }) {}

  isConfigured(): boolean {
    return !!this.cfg.secret;
  }

  async createCheckout(req: CheckoutRequest): Promise<CheckoutSession> {
    if (!this.cfg.checkoutUrl) throw new Error('GATEWAY_CHECKOUT_URL not configured');
    const reference = `JRV-G-${Date.now().toString(36).toUpperCase()}-${req.customerId.slice(0, 8)}`;
    const u = new URL(this.cfg.checkoutUrl);
    u.searchParams.set('reference', reference);
    u.searchParams.set('plan', req.plan.code);
    u.searchParams.set('amount', String(req.plan.amount));
    u.searchParams.set('currency', req.plan.currency);
    u.searchParams.set('customer', req.customerId);
    u.searchParams.set('email', req.customerEmail);
    return { provider: this.id, reference, url: u.toString() };
  }

  static sign(secret: string, timestamp: number, body: string | Buffer): string {
    return 'sha256=' + createHmac('sha256', secret).update(`${timestamp}.`).update(body).digest('hex');
  }

  async parseWebhook(rawBody: Buffer, headers: Record<string, string | string[] | undefined>): Promise<BillingEvent[]> {
    if (!this.cfg.secret) throw new WebhookVerificationError('Gateway webhook secret not configured');
    const ts = Number(headers['x-jarvis-timestamp']);
    const sig = String(headers['x-jarvis-signature'] ?? '');
    if (!ts || Math.abs(Date.now() / 1000 - ts) > (this.cfg.toleranceSec ?? 300)) throw new WebhookVerificationError('Timestamp missing or outside tolerance');
    const expected = Buffer.from(SignedGatewayProvider.sign(this.cfg.secret, ts, rawBody));
    const got = Buffer.from(sig);
    if (expected.length !== got.length || !timingSafeEqual(expected, got)) throw new WebhookVerificationError('Invalid gateway signature');
    const parsed = JSON.parse(rawBody.toString('utf8')) as unknown;
    const list = Array.isArray(parsed) ? parsed : [parsed];
    return list.map((e) => BillingEventSchema.parse({ ...(e as object), provider: this.id }));
  }
}
