import type { Queryable } from '../db.js';
import type { EntitlementPolicy } from '@jarvis/billing-core';

export interface ServerSettings {
  graceHours: number;
  canceledKeepsAccessUntilPeriodEnd: boolean;
  defaultMaxDevices: number;
  tokenTtlHours: number;
  bankTransferInstructions: string;
  latestRelease: { version: string; url: string; sha256: string; notes?: string } | null;
}

export async function getSettings(db: Queryable): Promise<ServerSettings> {
  const rows = (await db.query<{ key: string; value: unknown }>('SELECT key, value FROM settings')).rows;
  const m = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  return {
    graceHours: Number(m.grace_hours ?? 0),
    canceledKeepsAccessUntilPeriodEnd: m.canceled_keeps_access_until_period_end !== false,
    defaultMaxDevices: Number(m.default_max_devices ?? 2),
    tokenTtlHours: Number(m.token_ttl_hours ?? 72),
    bankTransferInstructions: String(m.bank_transfer_instructions ?? ''),
    latestRelease: (m.latest_release as ServerSettings['latestRelease']) ?? null,
  };
}

const KEY_MAP: Record<keyof ServerSettings, string> = {
  graceHours: 'grace_hours',
  canceledKeepsAccessUntilPeriodEnd: 'canceled_keeps_access_until_period_end',
  defaultMaxDevices: 'default_max_devices',
  tokenTtlHours: 'token_ttl_hours',
  bankTransferInstructions: 'bank_transfer_instructions',
  latestRelease: 'latest_release',
};

export async function updateSettings(db: Queryable, patch: Partial<ServerSettings>): Promise<ServerSettings> {
  for (const [k, v] of Object.entries(patch)) {
    const key = KEY_MAP[k as keyof ServerSettings];
    if (!key || v === undefined) continue;
    await db.query(
      'INSERT INTO settings (key, value, updated_at) VALUES ($1, $2, now()) ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = now()',
      [key, JSON.stringify(v)],
    );
  }
  return getSettings(db);
}

export const policyOf = (s: ServerSettings): EntitlementPolicy => ({
  graceHours: s.graceHours,
  canceledKeepsAccessUntilPeriodEnd: s.canceledKeepsAccessUntilPeriodEnd,
});
