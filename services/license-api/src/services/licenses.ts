import { entitlementUntil } from '@jarvis/billing-core';
import type { EntitlementSigner } from '@jarvis/licensing';
import { JarvisError } from '@jarvis/shared';
import type { Db, Queryable } from '../db.js';
import { tx } from '../db.js';
import { audit } from '../audit.js';
import { hashLicenseKey, newLicenseKey } from '../crypto.js';
import { getSettings, policyOf } from './settings.js';
import { currentSubscription, getPlan } from './subscriptions.js';

export interface LicenseRow {
  id: string;
  user_id: string;
  subscription_id: string | null;
  key_last4: string;
  status: 'active' | 'revoked';
  max_devices: number;
  created_at: Date;
  revoked_at: Date | null;
  revoked_reason: string | null;
}

export interface DeviceRow {
  id: string;
  license_id: string;
  fingerprint: string;
  name: string;
  platform: string;
  app_version: string;
  status: 'active' | 'deactivated';
  first_seen: Date;
  last_seen: Date;
}

export class LicenseError extends JarvisError {
  constructor(
    public readonly reason:
      | 'invalid_key'
      | 'revoked'
      | 'device_limit'
      | 'device_not_registered'
      | 'device_deactivated'
      | 'user_disabled',
    message: string,
    public readonly httpStatus = 403,
  ) {
    super('LICENSE_REQUIRED', message);
  }
}

/** Issue a new license key for a user. The plaintext key is returned ONCE; only its hash is stored. */
export async function issueLicense(
  db: Queryable,
  userId: string,
  actor: { type: 'admin' | 'system' | 'customer'; id?: string },
  maxDevices?: number,
): Promise<{ license: LicenseRow; key: string }> {
  const s = await getSettings(db);
  const sub = await currentSubscription(db, userId);
  const key = newLicenseKey();
  const r = await db.query<LicenseRow>(
    'INSERT INTO licenses (user_id, subscription_id, key_hash, key_last4, max_devices) VALUES ($1, $2, $3, $4, $5) RETURNING id, user_id, subscription_id, key_last4, status, max_devices, created_at, revoked_at, revoked_reason',
    [userId, sub?.id ?? null, hashLicenseKey(key), key.slice(-4), maxDevices ?? s.defaultMaxDevices],
  );
  await audit(db, {
    actorType: actor.type,
    actorId: actor.id,
    action: 'license.issue',
    targetType: 'license',
    targetId: r.rows[0]!.id,
    details: { userId },
  });
  return { license: r.rows[0]!, key };
}

export async function rotateLicenseKey(
  db: Queryable,
  licenseId: string,
  actor: { type: 'admin' | 'customer'; id?: string },
): Promise<string> {
  const key = newLicenseKey();
  const r = await db.query('UPDATE licenses SET key_hash = $2, key_last4 = $3 WHERE id = $1', [
    licenseId,
    hashLicenseKey(key),
    key.slice(-4),
  ]);
  if (!r.rowCount) throw new JarvisError('NOT_FOUND', 'License not found');
  await audit(db, {
    actorType: actor.type,
    actorId: actor.id,
    action: 'license.rotate_key',
    targetType: 'license',
    targetId: licenseId,
  });
  return key;
}

async function findByKey(
  db: Queryable,
  key: string,
): Promise<(LicenseRow & { user_disabled: boolean }) | undefined> {
  return (
    await db.query<LicenseRow & { user_disabled: boolean }>(
      'SELECT l.id, l.user_id, l.subscription_id, l.key_last4, l.status, l.max_devices, l.created_at, l.revoked_at, l.revoked_reason, u.disabled AS user_disabled FROM licenses l JOIN users u ON u.id = l.user_id WHERE l.key_hash = $1',
      [hashLicenseKey(key)],
    )
  ).rows[0];
}

/** Server-side source of truth: builds signed entitlement for a license+device. */
async function signEntitlement(
  db: Queryable,
  signer: EntitlementSigner,
  lic: LicenseRow,
  device: DeviceRow,
  nonce: string,
): Promise<string> {
  const s = await getSettings(db);
  const now = new Date();
  const sub = await currentSubscription(db, lic.user_id);
  let plan: 'monthly' | 'yearly' | null = null;
  let ent: string[] = [];
  let until: Date | null = null;
  let status: 'active' | 'past_due' | 'canceled' | 'expired' | 'suspended' | 'revoked' | 'none' = 'none';
  if (lic.status === 'revoked') status = 'revoked';
  else if (sub) {
    status = sub.status;
    until = entitlementUntil(
      { status: sub.status, currentPeriodEnd: sub.current_period_end },
      policyOf(s),
      now,
    );
    if (until) {
      const p = await getPlan(db, sub.plan_code);
      plan = p.code === 'yearly' ? 'yearly' : 'monthly';
      ent = p.entitlements;
    }
  }
  return signer.sign(
    {
      sub: lic.id,
      cid: lic.user_id,
      did: device.id,
      fp: device.fingerprint,
      plan,
      status,
      ent,
      entUntil: until ? Math.floor(until.getTime() / 1000) : null,
      srvNow: now.getTime(),
      nonce,
    },
    s.tokenTtlHours * 3600,
  );
}

export interface ActivateInput {
  licenseKey: string;
  fingerprint: string;
  deviceName?: string;
  platform?: string;
  appVersion?: string;
  nonce: string;
  ip?: string;
}

export async function activateDevice(
  db: Db,
  signer: EntitlementSigner,
  input: ActivateInput,
): Promise<{ token: string; device: DeviceRow }> {
  return tx(db, async (c) => {
    const lic = await findByKey(c, input.licenseKey);
    if (!lic) {
      await audit(c, {
        actorType: 'device',
        action: 'license.activate_failed',
        ip: input.ip,
        details: { reason: 'invalid_key' },
      });
      throw new LicenseError('invalid_key', 'License key not recognised', 404);
    }
    if (lic.user_disabled) throw new LicenseError('user_disabled', 'Account disabled');
    if (lic.status === 'revoked') throw new LicenseError('revoked', 'This license has been revoked');
    await c.query('SELECT id FROM licenses WHERE id = $1 FOR UPDATE', [lic.id]); // serialise device-limit checks
    const existing = (
      await c.query<DeviceRow>('SELECT * FROM devices WHERE license_id = $1 AND fingerprint = $2', [
        lic.id,
        input.fingerprint,
      ])
    ).rows[0];
    let device: DeviceRow;
    if (existing && existing.status === 'active') {
      device = (
        await c.query<DeviceRow>(
          'UPDATE devices SET last_seen = now(), last_ip = $2, app_version = COALESCE($3, app_version) WHERE id = $1 RETURNING *',
          [existing.id, input.ip ?? null, input.appVersion ?? null],
        )
      ).rows[0]!;
    } else {
      const active = Number(
        (
          await c.query<{ n: string }>(
            "SELECT COUNT(*) AS n FROM devices WHERE license_id = $1 AND status = 'active'",
            [lic.id],
          )
        ).rows[0]!.n,
      );
      if (active >= lic.max_devices) {
        await audit(c, {
          actorType: 'device',
          action: 'license.activate_failed',
          targetType: 'license',
          targetId: lic.id,
          ip: input.ip,
          details: { reason: 'device_limit', active, max: lic.max_devices },
        });
        throw new LicenseError(
          'device_limit',
          `Device limit reached (${lic.max_devices}). Deactivate another device first.`,
        );
      }
      device = existing
        ? (
            await c.query<DeviceRow>(
              "UPDATE devices SET status = 'active', last_seen = now(), name = $2, platform = $3, app_version = $4, last_ip = $5 WHERE id = $1 RETURNING *",
              [
                existing.id,
                input.deviceName ?? '',
                input.platform ?? '',
                input.appVersion ?? '',
                input.ip ?? null,
              ],
            )
          ).rows[0]!
        : (
            await c.query<DeviceRow>(
              'INSERT INTO devices (license_id, fingerprint, name, platform, app_version, last_ip) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *',
              [
                lic.id,
                input.fingerprint,
                input.deviceName ?? '',
                input.platform ?? '',
                input.appVersion ?? '',
                input.ip ?? null,
              ],
            )
          ).rows[0]!;
      await audit(c, {
        actorType: 'device',
        actorId: device.id,
        action: 'license.activate',
        targetType: 'license',
        targetId: lic.id,
        ip: input.ip,
        details: { deviceName: input.deviceName, platform: input.platform },
      });
    }
    return { token: await signEntitlement(c, signer, lic, device, input.nonce), device };
  });
}

export async function validateDevice(
  db: Db,
  signer: EntitlementSigner,
  input: { licenseKey: string; fingerprint: string; nonce: string; appVersion?: string; ip?: string },
): Promise<{ token: string }> {
  const lic = await findByKey(db, input.licenseKey);
  if (!lic) throw new LicenseError('invalid_key', 'License key not recognised', 404);
  if (lic.user_disabled) throw new LicenseError('user_disabled', 'Account disabled');
  if (lic.status === 'revoked') throw new LicenseError('revoked', 'This license has been revoked');
  const device = (
    await db.query<DeviceRow>('SELECT * FROM devices WHERE license_id = $1 AND fingerprint = $2', [
      lic.id,
      input.fingerprint,
    ])
  ).rows[0];
  if (!device)
    throw new LicenseError('device_not_registered', 'This device is not activated for this license');
  if (device.status !== 'active')
    throw new LicenseError('device_deactivated', 'This device was deactivated. Activate it again.');
  await db.query(
    'UPDATE devices SET last_seen = now(), last_ip = $2, app_version = COALESCE($3, app_version) WHERE id = $1',
    [device.id, input.ip ?? null, input.appVersion ?? null],
  );
  return { token: await signEntitlement(db, signer, lic, device, input.nonce) };
}

export async function deactivateDevice(
  db: Queryable,
  input: { licenseKey?: string; fingerprint?: string; deviceId?: string },
  actor: { type: 'admin' | 'device' | 'customer'; id?: string },
): Promise<boolean> {
  let r;
  if (input.deviceId)
    r = await db.query("UPDATE devices SET status = 'deactivated' WHERE id = $1 RETURNING license_id", [
      input.deviceId,
    ]);
  else {
    const lic = input.licenseKey ? await findByKey(db, input.licenseKey) : undefined;
    if (!lic) return false;
    r = await db.query(
      "UPDATE devices SET status = 'deactivated' WHERE license_id = $1 AND fingerprint = $2 RETURNING id",
      [lic.id, input.fingerprint],
    );
  }
  if (r.rowCount)
    await audit(db, {
      actorType: actor.type,
      actorId: actor.id,
      action: 'device.deactivate',
      targetType: 'device',
      targetId: input.deviceId ?? String(r.rows[0].id),
    });
  return (r.rowCount ?? 0) > 0;
}

export async function setLicenseStatus(
  db: Queryable,
  id: string,
  status: 'active' | 'revoked',
  actorId: string,
  reason?: string,
): Promise<LicenseRow> {
  const r = await db.query<LicenseRow>(
    `UPDATE licenses SET status = $2, revoked_at = CASE WHEN $2 = 'revoked' THEN now() ELSE NULL END, revoked_reason = $3 WHERE id = $1
     RETURNING id, user_id, subscription_id, key_last4, status, max_devices, created_at, revoked_at, revoked_reason`,
    [id, status, status === 'revoked' ? (reason ?? null) : null],
  );
  if (!r.rows[0]) throw new JarvisError('NOT_FOUND', 'License not found');
  await audit(db, {
    actorType: 'admin',
    actorId,
    action: status === 'revoked' ? 'license.revoke' : 'license.reactivate',
    targetType: 'license',
    targetId: id,
    details: { reason },
  });
  return r.rows[0];
}

export async function setMaxDevices(db: Queryable, id: string, max: number, actorId: string): Promise<void> {
  await db.query('UPDATE licenses SET max_devices = $2 WHERE id = $1', [id, max]);
  await audit(db, {
    actorType: 'admin',
    actorId,
    action: 'license.max_devices',
    targetType: 'license',
    targetId: id,
    details: { max },
  });
}
