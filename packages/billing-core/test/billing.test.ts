import { describe, expect, it } from 'vitest';
import { addInterval, entitlementUntil, PLANS, reconcileStatus } from '../src/index.js';

describe('plans', () => {
  it('has the product-owner prices', () => {
    expect(PLANS.monthly).toMatchObject({ amount: 4000, currency: 'PKR', interval: 'month' });
    expect(PLANS.yearly).toMatchObject({ amount: 40000, currency: 'PKR', interval: 'year' });
  });
  it('adds calendar months with month-end clamping', () => {
    expect(addInterval(new Date('2026-01-31T10:00:00Z'), 'month').toISOString()).toBe(
      '2026-02-28T10:00:00.000Z',
    );
    expect(addInterval(new Date('2028-02-29T00:00:00Z'), 'year').toISOString()).toBe(
      '2029-02-28T00:00:00.000Z',
    );
  });
});

describe('entitlement policy', () => {
  const end = new Date('2026-10-01T00:00:00Z');
  it('zero grace: access ends exactly at period end', () => {
    const p = { graceHours: 0, canceledKeepsAccessUntilPeriodEnd: true };
    expect(
      entitlementUntil(
        { status: 'active', currentPeriodEnd: end },
        p,
        new Date('2026-09-30T23:59:59Z'),
      )?.toISOString(),
    ).toBe(end.toISOString());
    expect(entitlementUntil({ status: 'active', currentPeriodEnd: end }, p, end)).toBeNull();
    expect(reconcileStatus({ status: 'active', currentPeriodEnd: end }, p, end)).toBe('expired');
  });
  it('grace period keeps past_due access until grace ends', () => {
    const p = { graceHours: 48, canceledKeepsAccessUntilPeriodEnd: true };
    const t = new Date('2026-10-02T00:00:00Z');
    expect(reconcileStatus({ status: 'active', currentPeriodEnd: end }, p, t)).toBe('past_due');
    expect(entitlementUntil({ status: 'past_due', currentPeriodEnd: end }, p, t)).not.toBeNull();
    expect(
      reconcileStatus({ status: 'past_due', currentPeriodEnd: end }, p, new Date('2026-10-03T00:00:00Z')),
    ).toBe('expired');
  });
  it('suspended and expired never grant access', () => {
    const p = { graceHours: 100, canceledKeepsAccessUntilPeriodEnd: true };
    const t = new Date('2026-09-01T00:00:00Z');
    expect(entitlementUntil({ status: 'suspended', currentPeriodEnd: end }, p, t)).toBeNull();
    expect(entitlementUntil({ status: 'expired', currentPeriodEnd: end }, p, t)).toBeNull();
  });
});
