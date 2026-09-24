import { randomBytes } from 'node:crypto';
import type { BillingEvent, BillingProvider, CheckoutRequest, CheckoutSession } from '@jarvis/billing-core';
import { WebhookVerificationError } from '@jarvis/billing-core';

/**
 * Manual / bank-transfer billing. Checkout returns a payment reference and
 * instructions; an administrator confirms receipt in the admin portal, which
 * records the payment and activates the subscription. No webhooks.
 */
export class ManualBankTransferProvider implements BillingProvider {
  readonly id = 'manual';
  constructor(private readonly instructions: () => Promise<string>) {}
  isConfigured() {
    return true;
  }
  async createCheckout(req: CheckoutRequest): Promise<CheckoutSession> {
    const reference = `JRV-${req.plan.code.toUpperCase().slice(0, 1)}-${randomBytes(4).toString('hex').toUpperCase()}`;
    return {
      provider: this.id,
      reference,
      instructions: `${await this.instructions()}\n\nAmount: ${req.plan.amount.toLocaleString('en-PK')} ${req.plan.currency}\nReference: ${reference}`,
    };
  }
  async parseWebhook(): Promise<BillingEvent[]> {
    throw new WebhookVerificationError('Manual provider has no webhooks');
  }
}
