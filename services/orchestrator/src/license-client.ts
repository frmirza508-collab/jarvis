import { createHash, randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import { performance } from 'node:perf_hooks';
import {
  DEFAULT_GUARD_OPTIONS,
  EntitlementGuard,
  EntitlementVerifier,
  LicenseVerificationError,
  type EntitlementClaims,
  type EntitlementDecision,
  type GuardOptions,
  type GuardState,
} from '@jarvis/licensing';
import { JarvisError, Logger } from '@jarvis/shared';
import type { SecretStore } from '@jarvis/security';

/** Stable, hashed device fingerprint (raw machine ids never leave the device). */
export function deviceFingerprint(): string {
  let machineId = '';
  try {
    if (process.platform === 'win32') {
      const out = execFileSync('reg', ['query', 'HKLM\\SOFTWARE\\Microsoft\\Cryptography', '/v', 'MachineGuid'], { encoding: 'utf8', windowsHide: true });
      machineId = /MachineGuid\s+REG_SZ\s+(\S+)/.exec(out)?.[1] ?? '';
    } else if (process.platform === 'linux') {
      machineId = readFileSync('/etc/machine-id', 'utf8').trim();
    } else if (process.platform === 'darwin') {
      const out = execFileSync('ioreg', ['-rd1', '-c', 'IOPlatformExpertDevice'], { encoding: 'utf8' });
      machineId = /"IOPlatformUUID" = "([^"]+)"/.exec(out)?.[1] ?? '';
    }
  } catch {
    /* fall through */
  }
  if (!machineId) machineId = `${os.hostname()}|${os.userInfo().username}|${os.cpus()[0]?.model ?? ''}`;
  return createHash('sha256').update(`jarvis-device-v1|${machineId}`).digest('hex');
}

export interface LicenseStatus {
  mode: 'licensed' | 'development';
  hasKey: boolean;
  decision: EntitlementDecision['reason'];
  premium: boolean;
  plan?: string | null;
  status?: string;
  entitlementUntil?: string | null;
  lastOnlineCheck?: string;
  deviceId?: string;
  error?: string;
}

export interface LicenseClientOptions {
  apiUrl: string;
  publicKeyPem: string;
  secrets: SecretStore;
  appVersion: string;
  /** Development-only bypass; compiled out of release builds. */
  developmentMode?: boolean;
  guard?: GuardOptions;
  fetchImpl?: typeof fetch;
  fingerprint?: string;
  now?: () => number;
}

const STATE_KEY = 'LICENSE_GUARD_STATE';
const KEY_NAME = 'LICENSE_KEY';

export class LicenseClient {
  private verifier?: EntitlementVerifier;
  private guard: EntitlementGuard;
  private claims?: EntitlementClaims;
  private lastError?: string;
  private lastMono = performance.now();
  private timer?: NodeJS.Timeout;
  private readonly log = new Logger('license');
  readonly fingerprint: string;
  private readonly f: typeof fetch;
  private readonly now: () => number;

  constructor(private readonly opts: LicenseClientOptions) {
    this.fingerprint = opts.fingerprint ?? deviceFingerprint();
    this.f = opts.fetchImpl ?? fetch;
    this.now = opts.now ?? Date.now;
    let state: GuardState = { trustedTimeMs: 0, offlineElapsedMs: 0 };
    try {
      const raw = opts.secrets.get(STATE_KEY);
      if (raw) state = JSON.parse(raw) as GuardState;
    } catch {
      /* corrupted state => start fresh; requires online check */
    }
    this.guard = new EntitlementGuard(state, opts.guard ?? DEFAULT_GUARD_OPTIONS);
  }

  async init(): Promise<void> {
    this.verifier = await EntitlementVerifier.fromPem(this.opts.publicKeyPem);
    if (this.guard.state.token) {
      try {
        this.claims = await this.verifier.verify(this.guard.state.token, { fingerprint: this.fingerprint });
      } catch (e) {
        this.log.warn('cached license token invalid', { error: (e as Error).message });
        this.guard.state.token = undefined;
      }
    }
  }

  /** Start monotonic ticking + periodic online re-validation. */
  start(intervalMs = 60_000): void {
    this.timer = setInterval(() => {
      this.tick();
      const d = this.decision();
      if (d.needsOnlineCheck && this.opts.secrets.get(KEY_NAME)) void this.refresh().catch(() => {});
    }, intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  tick(): void {
    const mono = performance.now();
    this.guard.tick(mono - this.lastMono);
    this.lastMono = mono;
    this.persist();
  }

  private persist(): void {
    this.opts.secrets.set(STATE_KEY, JSON.stringify(this.guard.state));
  }

  decision(): EntitlementDecision {
    return this.guard.evaluate(this.claims, this.now());
  }

  /** Called by the orchestrator before premium execution. */
  checkEntitlement(): { premium: boolean; reason?: string } {
    if (this.opts.developmentMode) return { premium: true };
    const d = this.decision();
    if (d.premium) return { premium: true };
    const reasons: Record<string, string> = {
      no_license: 'No active license on this device. Activate JARVIS in Account.',
      inactive: `Your subscription is ${d.claims?.status ?? 'inactive'}. Renew to continue using premium features.`,
      entitlement_expired: 'Your subscription has expired. Renew to continue using premium features.',
      offline_window_exceeded: 'JARVIS must reach the license server to confirm your subscription. Please connect to the internet.',
      clock_tampered: 'System clock appears incorrect. Fix the date/time and connect to the internet to re-validate.',
      token_expired: 'License check expired. Please connect to the internet to re-validate.',
    };
    return { premium: false, reason: reasons[d.reason] ?? 'License required' };
  }

  status(): LicenseStatus {
    const d = this.decision();
    return {
      mode: this.opts.developmentMode ? 'development' : 'licensed',
      hasKey: !!this.opts.secrets.get(KEY_NAME),
      decision: d.reason,
      premium: this.opts.developmentMode ? true : d.premium,
      plan: this.claims?.plan,
      status: this.claims?.status,
      entitlementUntil: this.claims?.entUntil ? new Date(this.claims.entUntil * 1000).toISOString() : null,
      lastOnlineCheck: this.guard.state.lastOnlineCheckMs ? new Date(this.guard.state.lastOnlineCheckMs).toISOString() : undefined,
      deviceId: this.claims?.did,
      error: this.lastError,
    };
  }

  private async call(path: string, body: Record<string, unknown>): Promise<{ token: string }> {
    let res: Response;
    try {
      res = await this.f(`${this.opts.apiUrl}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(20_000),
      });
    } catch (e) {
      throw new JarvisError('PROVIDER_ERROR', `License server unreachable: ${(e as Error).message}`);
    }
    const j = (await res.json().catch(() => ({}))) as { token?: string; error?: string; message?: string };
    const msg = j.message ?? j.error ?? `License server error ${res.status}`;
    // Only definitive client-side rejections revoke the cached entitlement; outages/rate limits do not.
    if (res.status === 401 || res.status === 403 || res.status === 404) throw new JarvisError('LICENSE_REQUIRED', msg);
    if (!res.ok || !j.token) throw new JarvisError('PROVIDER_ERROR', msg);
    return { token: j.token };
  }

  private async accept(token: string, nonce: string): Promise<void> {
    if (!this.verifier) await this.init();
    const claims = await this.verifier!.verify(token, { fingerprint: this.fingerprint, nonce });
    this.claims = claims;
    this.guard.acceptOnline(token, claims, this.now());
    this.lastError = undefined;
    this.persist();
  }

  async activate(licenseKey: string): Promise<LicenseStatus> {
    const nonce = randomBytes(16).toString('hex');
    try {
      const { token } = await this.call('/v1/licenses/activate', {
        licenseKey,
        fingerprint: this.fingerprint,
        deviceName: os.hostname(),
        platform: `${process.platform}-${process.arch}`,
        appVersion: this.opts.appVersion,
        nonce,
      });
      await this.accept(token, nonce);
      this.opts.secrets.set(KEY_NAME, licenseKey);
    } catch (e) {
      this.lastError = e instanceof LicenseVerificationError ? `License response rejected: ${e.message}` : (e as Error).message;
      throw e;
    }
    return this.status();
  }

  async refresh(): Promise<LicenseStatus> {
    const key = this.opts.secrets.get(KEY_NAME);
    if (!key) throw new JarvisError('LICENSE_REQUIRED', 'No license key stored');
    const nonce = randomBytes(16).toString('hex');
    try {
      const { token } = await this.call('/v1/licenses/validate', { licenseKey: key, fingerprint: this.fingerprint, nonce, appVersion: this.opts.appVersion });
      await this.accept(token, nonce);
    } catch (e) {
      this.lastError = (e as Error).message;
      // A definitive server rejection (revoked/suspended/expired) clears the cached token immediately.
      if (e instanceof JarvisError && e.code === 'LICENSE_REQUIRED') {
        this.claims = undefined;
        this.guard.state.token = undefined;
        this.persist();
      }
      throw e;
    }
    return this.status();
  }

  async deactivate(): Promise<void> {
    const key = this.opts.secrets.get(KEY_NAME);
    if (key) {
      await this.f(`${this.opts.apiUrl}/v1/licenses/deactivate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ licenseKey: key, fingerprint: this.fingerprint }),
        signal: AbortSignal.timeout(20_000),
      }).catch(() => undefined);
    }
    this.opts.secrets.delete(KEY_NAME);
    this.claims = undefined;
    this.guard.state.token = undefined;
    this.persist();
  }
}
