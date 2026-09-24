import { SignJWT, jwtVerify, importPKCS8, importSPKI, generateKeyPair, exportPKCS8, exportSPKI } from 'jose';

type SigningKey = Awaited<ReturnType<typeof importPKCS8>>;
type VerifyKey = Awaited<ReturnType<typeof importSPKI>>;
import { z } from 'zod';

export const LICENSE_ISSUER = 'jarvis-license-api';
export const LICENSE_AUDIENCE = 'jarvis-desktop';
const ALG = 'EdDSA';

export const EntitlementClaimsSchema = z.object({
  sub: z.string(), // license id
  cid: z.string(), // customer id
  did: z.string(), // device id (server-registered)
  fp: z.string(), // device fingerprint hash
  plan: z.enum(['monthly', 'yearly']).nullable(),
  status: z.enum(['active', 'past_due', 'canceled', 'expired', 'suspended', 'revoked', 'none']),
  ent: z.array(z.string()),
  /** Epoch seconds until which premium execution is allowed (null = none). */
  entUntil: z.number().nullable(),
  /** Server clock at issuance (epoch ms) - used as a trusted time anchor. */
  srvNow: z.number(),
  /** Client nonce echoed back to prevent response replay. */
  nonce: z.string().optional(),
  iat: z.number(),
  exp: z.number(),
  iss: z.literal(LICENSE_ISSUER),
  aud: z.literal(LICENSE_AUDIENCE),
});
export type EntitlementClaims = z.infer<typeof EntitlementClaimsSchema>;

export async function generateSigningKeys(): Promise<{ privateKeyPem: string; publicKeyPem: string }> {
  const { privateKey, publicKey } = await generateKeyPair(ALG, { crv: 'Ed25519', extractable: true });
  return { privateKeyPem: await exportPKCS8(privateKey), publicKeyPem: await exportSPKI(publicKey) };
}

/** Server-only. The private key must never ship in the desktop client. */
export class EntitlementSigner {
  private constructor(private readonly key: SigningKey) {}

  static async fromPem(privateKeyPem: string): Promise<EntitlementSigner> {
    return new EntitlementSigner(await importPKCS8(privateKeyPem, ALG));
  }

  async sign(claims: Omit<EntitlementClaims, 'iat' | 'exp' | 'iss' | 'aud'>, ttlSeconds: number): Promise<string> {
    const nowSec = Math.floor(claims.srvNow / 1000);
    return new SignJWT({ ...claims })
      .setProtectedHeader({ alg: ALG, typ: 'JWT' })
      .setIssuer(LICENSE_ISSUER)
      .setAudience(LICENSE_AUDIENCE)
      .setIssuedAt(nowSec)
      .setExpirationTime(nowSec + ttlSeconds)
      .sign(this.key);
  }
}

export class LicenseVerificationError extends Error {
  constructor(
    public readonly reason: 'signature' | 'claims' | 'device' | 'nonce' | 'expired',
    message: string,
  ) {
    super(message);
    this.name = 'LicenseVerificationError';
  }
}

/** Desktop-side verification with the embedded PUBLIC key only. */
export class EntitlementVerifier {
  private constructor(private readonly key: VerifyKey) {}

  static async fromPem(publicKeyPem: string): Promise<EntitlementVerifier> {
    return new EntitlementVerifier(await importSPKI(publicKeyPem, ALG));
  }

  /**
   * Verifies signature/issuer/audience. Time validity is NOT delegated to the
   * local clock here (currentDate pinned to the token's own iat); the
   * EntitlementGuard applies tamper-resistant time checks instead.
   */
  async verify(token: string, expected: { fingerprint: string; nonce?: string }): Promise<EntitlementClaims> {
    let payload: unknown;
    try {
      const decodedIat = JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString('utf8')).iat as number;
      ({ payload } = await jwtVerify(token, this.key, {
        issuer: LICENSE_ISSUER,
        audience: LICENSE_AUDIENCE,
        algorithms: [ALG],
        currentDate: new Date(decodedIat * 1000),
      }));
    } catch (e) {
      throw new LicenseVerificationError('signature', `Invalid license token: ${(e as Error).message}`);
    }
    const parsed = EntitlementClaimsSchema.safeParse(payload);
    if (!parsed.success) throw new LicenseVerificationError('claims', 'Malformed license claims');
    const c = parsed.data;
    if (c.fp !== expected.fingerprint) throw new LicenseVerificationError('device', 'License was issued for a different device');
    if (expected.nonce !== undefined && c.nonce !== expected.nonce) throw new LicenseVerificationError('nonce', 'License response nonce mismatch (possible replay)');
    return c;
  }
}

// ---------------------------------------------------------------------------
// Client-side guard: tamper-resistant time + offline window
// ---------------------------------------------------------------------------

export interface GuardState {
  token?: string;
  /** Highest trusted time observed (server-anchored), epoch ms. */
  trustedTimeMs: number;
  /** Monotonic time accumulated since the last successful online check. */
  offlineElapsedMs: number;
  lastOnlineCheckMs?: number;
}

export type EntitlementDecision =
  | { premium: true; claims: EntitlementClaims; reason: 'ok'; needsOnlineCheck: boolean }
  | {
      premium: false;
      claims?: EntitlementClaims;
      reason: 'no_license' | 'inactive' | 'entitlement_expired' | 'offline_window_exceeded' | 'clock_tampered' | 'token_expired';
      needsOnlineCheck: boolean;
    };

export interface GuardOptions {
  /** Maximum time the app may run on a cached token without reaching the server. */
  maxOfflineMs: number;
  /** Clock skew tolerance before rollback is treated as tampering. */
  clockSkewToleranceMs: number;
  /** How often to re-check online while connected. */
  recheckIntervalMs: number;
}

export const DEFAULT_GUARD_OPTIONS: GuardOptions = {
  maxOfflineMs: 72 * 3_600_000,
  clockSkewToleranceMs: 10 * 60_000,
  recheckIntervalMs: 6 * 3_600_000,
};

/**
 * Evaluates cached entitlements without trusting the local clock:
 * - effective time = max(system clock, highest server-anchored time seen)
 * - system clock moving behind trusted time beyond tolerance => tampered
 * - monotonic offline usage counter bounds cached-token use regardless of clock
 */
export class EntitlementGuard {
  constructor(
    public state: GuardState,
    private readonly opts: GuardOptions = DEFAULT_GUARD_OPTIONS,
  ) {}

  /** Record a verified online response. */
  acceptOnline(token: string, claims: EntitlementClaims, systemNowMs: number): void {
    this.state.token = token;
    this.state.trustedTimeMs = Math.max(this.state.trustedTimeMs, claims.srvNow);
    this.state.offlineElapsedMs = 0;
    this.state.lastOnlineCheckMs = systemNowMs;
  }

  /** Add monotonic elapsed time (from performance.now deltas) and advance trusted time. */
  tick(monotonicDeltaMs: number): void {
    if (monotonicDeltaMs <= 0) return;
    this.state.offlineElapsedMs += monotonicDeltaMs;
    this.state.trustedTimeMs += monotonicDeltaMs;
  }

  evaluate(claims: EntitlementClaims | undefined, systemNowMs: number): EntitlementDecision {
    if (!claims) return { premium: false, reason: 'no_license', needsOnlineCheck: true };
    const tampered = systemNowMs + this.opts.clockSkewToleranceMs < this.state.trustedTimeMs;
    if (tampered) return { premium: false, claims, reason: 'clock_tampered', needsOnlineCheck: true };
    const now = Math.max(systemNowMs, this.state.trustedTimeMs);
    const needsOnlineCheck =
      this.state.lastOnlineCheckMs === undefined || now - this.state.lastOnlineCheckMs >= this.opts.recheckIntervalMs;
    if (this.state.offlineElapsedMs > this.opts.maxOfflineMs) return { premium: false, claims, reason: 'offline_window_exceeded', needsOnlineCheck: true };
    if (now >= claims.exp * 1000) return { premium: false, claims, reason: 'token_expired', needsOnlineCheck: true };
    if (!['active', 'past_due', 'canceled'].includes(claims.status) || claims.entUntil === null)
      return { premium: false, claims, reason: 'inactive', needsOnlineCheck };
    if (now >= claims.entUntil * 1000) return { premium: false, claims, reason: 'entitlement_expired', needsOnlineCheck: true };
    return { premium: true, claims, reason: 'ok', needsOnlineCheck };
  }
}
