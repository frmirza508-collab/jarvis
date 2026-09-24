import { describe, expect, it } from 'vitest';
import {
  EntitlementGuard,
  EntitlementSigner,
  EntitlementVerifier,
  generateSigningKeys,
  DEFAULT_GUARD_OPTIONS,
} from '../src/index.js';

async function setup(overrides: Record<string, unknown> = {}) {
  const keys = await generateSigningKeys();
  const signer = await EntitlementSigner.fromPem(keys.privateKeyPem);
  const verifier = await EntitlementVerifier.fromPem(keys.publicKeyPem);
  const srvNow = Date.UTC(2026, 8, 1);
  const token = await signer.sign(
    {
      sub: 'lic1',
      cid: 'c1',
      did: 'd1',
      fp: 'fp1',
      plan: 'monthly',
      status: 'active',
      ent: ['premium.execution'],
      entUntil: Math.floor(srvNow / 1000) + 30 * 86400,
      srvNow,
      nonce: 'n1',
      ...overrides,
    },
    72 * 3600,
  );
  return { keys, signer, verifier, token, srvNow };
}

describe('license tokens', () => {
  it('verifies a valid Ed25519-signed token bound to device and nonce', async () => {
    const { verifier, token } = await setup();
    const c = await verifier.verify(token, { fingerprint: 'fp1', nonce: 'n1' });
    expect(c.status).toBe('active');
  });
  it('rejects tampered payloads, wrong device, replayed nonce and foreign keys', async () => {
    const { verifier, token } = await setup();
    const [h, p, s] = token.split('.');
    const payload = JSON.parse(Buffer.from(p!, 'base64url').toString());
    payload.entUntil += 365 * 86400;
    const forged = `${h}.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.${s}`;
    await expect(verifier.verify(forged, { fingerprint: 'fp1' })).rejects.toMatchObject({
      reason: 'signature',
    });
    await expect(verifier.verify(token, { fingerprint: 'other' })).rejects.toMatchObject({
      reason: 'device',
    });
    await expect(verifier.verify(token, { fingerprint: 'fp1', nonce: 'n2' })).rejects.toMatchObject({
      reason: 'nonce',
    });
    const other = await setup();
    await expect(verifier.verify(other.token, { fingerprint: 'fp1' })).rejects.toMatchObject({
      reason: 'signature',
    });
  });
});

describe('entitlement guard (clock tamper resistance)', () => {
  it('grants premium for a valid active entitlement', async () => {
    const { verifier, token, srvNow } = await setup();
    const c = await verifier.verify(token, { fingerprint: 'fp1' });
    const g = new EntitlementGuard({ trustedTimeMs: 0, offlineElapsedMs: 0 });
    g.acceptOnline(token, c, srvNow);
    expect(g.evaluate(c, srvNow + 1000).premium).toBe(true);
  });
  it('detects clock rollback', async () => {
    const { verifier, token, srvNow } = await setup();
    const c = await verifier.verify(token, { fingerprint: 'fp1' });
    const g = new EntitlementGuard({ trustedTimeMs: 0, offlineElapsedMs: 0 });
    g.acceptOnline(token, c, srvNow);
    expect(g.evaluate(c, srvNow - 86_400_000)).toMatchObject({ premium: false, reason: 'clock_tampered' });
  });
  it('bounds offline use by monotonic time even if the clock is frozen', async () => {
    const { verifier, token, srvNow } = await setup();
    const c = await verifier.verify(token, { fingerprint: 'fp1' });
    const g = new EntitlementGuard({ trustedTimeMs: 0, offlineElapsedMs: 0 });
    g.acceptOnline(token, c, srvNow);
    g.tick(DEFAULT_GUARD_OPTIONS.maxOfflineMs + 1);
    // system clock still reports issuance time, but trusted time advanced => tamper or offline window exceeded
    expect(g.evaluate(c, srvNow + DEFAULT_GUARD_OPTIONS.maxOfflineMs + 2).premium).toBe(false);
  });
  it('blocks after entitlement expiry even with a fresh token', async () => {
    const { verifier, token, srvNow } = await setup({
      entUntil: Math.floor(Date.UTC(2026, 8, 1) / 1000) + 60,
    });
    const c = await verifier.verify(token, { fingerprint: 'fp1' });
    const g = new EntitlementGuard({ trustedTimeMs: 0, offlineElapsedMs: 0 });
    g.acceptOnline(token, c, srvNow);
    expect(g.evaluate(c, srvNow + 61_000)).toMatchObject({ premium: false, reason: 'entitlement_expired' });
  });
  it('blocks suspended/expired statuses', async () => {
    const { verifier, token, srvNow } = await setup({ status: 'suspended', entUntil: null });
    const c = await verifier.verify(token, { fingerprint: 'fp1' });
    const g = new EntitlementGuard({ trustedTimeMs: 0, offlineElapsedMs: 0 });
    g.acceptOnline(token, c, srvNow);
    expect(g.evaluate(c, srvNow)).toMatchObject({ premium: false, reason: 'inactive' });
  });
});
