import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import { z } from 'zod';
import { EntitlementSigner } from '@jarvis/licensing';
import { PLANS, WebhookVerificationError, type BillingProvider, type Plan } from '@jarvis/billing-core';
import { JarvisError, toJarvisError } from '@jarvis/shared';
import type { Db } from './db.js';
import type { Config } from './config.js';
import { audit } from './audit.js';
import { createUser, login, logout, userForToken, type UserRow } from './services/auth.js';
import { activateDevice, deactivateDevice, issueLicense, LicenseError, rotateLicenseKey, setLicenseStatus, setMaxDevices, validateDevice } from './services/licenses.js';
import { adminExtend, adminSetStatus, applyPayment, currentSubscription, getPlan, reconcileAll } from './services/subscriptions.js';
import { getSettings, updateSettings } from './services/settings.js';
import { handleWebhook } from './services/webhooks.js';
import { ManualBankTransferProvider } from './providers/manual.js';
import { StripeProvider } from './providers/stripe.js';
import { SignedGatewayProvider } from './providers/gateway.js';

declare module 'fastify' {
  interface FastifyRequest {
    user?: UserRow;
    rawBody?: Buffer;
  }
}

const STATUS: Record<string, number> = { PERMISSION_DENIED: 403, NOT_FOUND: 404, INVALID_INPUT: 400, NOT_CONFIGURED: 409, LICENSE_REQUIRED: 403 };

export interface AppOptions {
  db: Db;
  config: Config;
  providers?: BillingProvider[];
  fetchImpl?: typeof fetch;
  /** Start the periodic expiry reconciler (disabled in tests). */
  reconcileIntervalMs?: number;
}

export async function buildApp(opts: AppOptions) {
  const { db, config } = opts;
  const signer = await EntitlementSigner.fromPem(config.LICENSE_SIGNING_PRIVATE_KEY);
  const app = Fastify({ logger: false, trustProxy: config.TRUST_PROXY === 'true', bodyLimit: 1024 * 1024 });

  const providers = new Map<string, BillingProvider>();
  for (const p of opts.providers ?? [
    new ManualBankTransferProvider(async () => (await getSettings(db)).bankTransferInstructions),
    new StripeProvider({ secretKey: config.STRIPE_SECRET_KEY, webhookSecret: config.STRIPE_WEBHOOK_SECRET, priceMonthly: config.STRIPE_PRICE_MONTHLY, priceYearly: config.STRIPE_PRICE_YEARLY }, opts.fetchImpl),
    new SignedGatewayProvider({ secret: config.GATEWAY_WEBHOOK_SECRET, checkoutUrl: config.GATEWAY_CHECKOUT_URL }),
  ])
    providers.set(p.id, p);

  await app.register(cors, { origin: config.ADMIN_ORIGINS.split(',').map((s) => s.trim()), credentials: false, methods: ['GET', 'POST', 'PUT', 'DELETE'], allowedHeaders: ['Authorization', 'Content-Type'] });
  await app.register(rateLimit, { global: true, max: 300, timeWindow: '1 minute' });

  // Keep the raw body for webhook signature verification.
  app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (req, body, done) => {
    (req as FastifyRequest).rawBody = body as Buffer;
    if ((body as Buffer).length === 0) return done(null, {});
    try {
      done(null, JSON.parse((body as Buffer).toString('utf8')));
    } catch {
      done(new JarvisError('INVALID_INPUT', 'Invalid JSON'), undefined);
    }
  });

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof LicenseError) return reply.status(err.httpStatus).send({ error: err.reason, message: err.message });
    if (err instanceof WebhookVerificationError) return reply.status(400).send({ error: 'invalid_webhook', message: err.message });
    if (err instanceof z.ZodError) return reply.status(400).send({ error: 'INVALID_INPUT', message: err.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') });
    const status = (err as { statusCode?: number }).statusCode;
    if (status === 429) return reply.status(429).send({ error: 'RATE_LIMITED', message: 'Too many requests' });
    const je = toJarvisError(err);
    const code = STATUS[je.code] ?? (status && status < 500 ? status : 500);
    if (code >= 500) app.log.error(err);
    return reply.status(code).send({ error: je.code, message: code >= 500 ? 'Internal error' : je.message });
  });

  const bearer = (req: FastifyRequest) => (req.headers.authorization?.startsWith('Bearer ') ? req.headers.authorization.slice(7) : '');
  const requireUser = async (req: FastifyRequest, reply: FastifyReply) => {
    const u = await userForToken(db, bearer(req));
    if (!u) return reply.status(401).send({ error: 'UNAUTHORIZED', message: 'Sign in required' });
    req.user = u;
  };
  const requireStaff = (roles: Array<UserRow['role']>) => async (req: FastifyRequest, reply: FastifyReply) => {
    const u = await userForToken(db, bearer(req));
    if (!u) return reply.status(401).send({ error: 'UNAUTHORIZED', message: 'Sign in required' });
    if (!roles.includes(u.role)) return reply.status(403).send({ error: 'FORBIDDEN', message: 'Insufficient role' });
    req.user = u;
  };
  const strict = { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } };

  // ---------------------------------------------------------------- public
  app.get('/health', async () => {
    await db.query('SELECT 1');
    return { ok: true, time: new Date().toISOString() };
  });
  app.get('/v1/plans', async () => (await db.query('SELECT code, name, amount, currency, interval, interval_count FROM plans WHERE active ORDER BY amount')).rows);

  const Credentials = z.object({ email: z.string().email().max(254), password: z.string().min(1).max(200) });
  app.post('/v1/auth/register', strict, async (req) => {
    const b = Credentials.extend({ name: z.string().max(120).optional(), password: z.string().min(10).max(200) }).parse(req.body);
    const u = await createUser(db, b);
    return { id: u.id, email: u.email };
  });
  app.post('/v1/auth/login', strict, async (req) => {
    const b = Credentials.parse(req.body);
    const { token, user } = await login(db, b.email, b.password, { ip: req.ip, userAgent: req.headers['user-agent'] });
    return { token, user: { id: user.id, email: user.email, name: user.name, role: user.role } };
  });
  app.post('/v1/auth/logout', async (req) => {
    await logout(db, bearer(req));
    return { ok: true };
  });

  // ---------------------------------------------------------------- customer
  app.get('/v1/me', { preHandler: requireUser }, async (req) => {
    const u = req.user!;
    const sub = await currentSubscription(db, u.id);
    const licenses = (await db.query('SELECT id, key_last4, status, max_devices, created_at FROM licenses WHERE user_id = $1 ORDER BY created_at', [u.id])).rows;
    const devices = (await db.query("SELECT d.id, d.name, d.platform, d.status, d.last_seen, d.license_id FROM devices d JOIN licenses l ON l.id = d.license_id WHERE l.user_id = $1 ORDER BY d.last_seen DESC", [u.id])).rows;
    const payments = (await db.query('SELECT id, provider, plan_code, amount, currency, status, created_at FROM payments WHERE user_id = $1 ORDER BY created_at DESC LIMIT 50', [u.id])).rows;
    return { user: { id: u.id, email: u.email, name: u.name }, subscription: sub ?? null, licenses, devices, payments };
  });
  app.post('/v1/checkout', { preHandler: requireUser, ...strict }, async (req) => {
    const b = z.object({ plan: z.enum(['monthly', 'yearly']), provider: z.string().default('manual'), successUrl: z.string().url().optional(), cancelUrl: z.string().url().optional() }).parse(req.body);
    const provider = providers.get(b.provider);
    if (!provider || !provider.isConfigured()) throw new JarvisError('NOT_CONFIGURED', `Payment provider ${b.provider} is not configured`);
    const row = await getPlan(db, b.plan);
    const plan: Plan = { ...PLANS[b.plan], amount: row.amount, currency: row.currency as 'PKR', name: row.name };
    const session = await provider.createCheckout({ plan, customerEmail: req.user!.email, customerId: req.user!.id, successUrl: b.successUrl ?? `${config.PUBLIC_BASE_URL}/checkout/success`, cancelUrl: b.cancelUrl ?? `${config.PUBLIC_BASE_URL}/checkout/cancel` });
    await db.query('INSERT INTO checkout_sessions (user_id, plan_code, provider, reference) VALUES ($1, $2, $3, $4)', [req.user!.id, b.plan, provider.id, session.reference]);
    await audit(db, { actorType: 'customer', actorId: req.user!.id, action: 'checkout.create', details: { plan: b.plan, provider: provider.id, reference: session.reference } });
    return session;
  });
  app.post('/v1/me/licenses', { preHandler: requireUser, ...strict }, async (req) => {
    const existing = (await db.query("SELECT COUNT(*)::int AS n FROM licenses WHERE user_id = $1 AND status = 'active'", [req.user!.id])).rows[0].n as number;
    if (existing > 0) throw new JarvisError('INVALID_INPUT', 'You already have a license. Rotate its key if you lost it.');
    const { license, key } = await issueLicense(db, req.user!.id, { type: 'customer', id: req.user!.id });
    return { id: license.id, key };
  });
  app.post<{ Params: { id: string } }>('/v1/me/licenses/:id/rotate', { preHandler: requireUser, ...strict }, async (req) => {
    const own = await db.query('SELECT 1 FROM licenses WHERE id = $1 AND user_id = $2', [req.params.id, req.user!.id]);
    if (!own.rowCount) throw new JarvisError('NOT_FOUND', 'License not found');
    return { key: await rotateLicenseKey(db, req.params.id, { type: 'customer', id: req.user!.id }) };
  });
  app.post<{ Params: { id: string } }>('/v1/me/devices/:id/deactivate', { preHandler: requireUser }, async (req) => {
    const own = await db.query('SELECT 1 FROM devices d JOIN licenses l ON l.id = d.license_id WHERE d.id = $1 AND l.user_id = $2', [req.params.id, req.user!.id]);
    if (!own.rowCount) throw new JarvisError('NOT_FOUND', 'Device not found');
    return { ok: await deactivateDevice(db, { deviceId: req.params.id }, { type: 'customer', id: req.user!.id }) };
  });

  // ---------------------------------------------------------------- desktop license endpoints
  const Fingerprint = z.string().regex(/^[0-9a-f]{64}$/);
  const LicenseKey = z.string().regex(/^JRV(-[0-9A-Z]{5}){4}$/i);
  const Nonce = z.string().regex(/^[0-9a-f]{16,64}$/);
  const licenseLimit = { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } };
  app.post('/v1/licenses/activate', licenseLimit, async (req) => {
    const b = z.object({ licenseKey: LicenseKey, fingerprint: Fingerprint, nonce: Nonce, deviceName: z.string().max(120).optional(), platform: z.string().max(60).optional(), appVersion: z.string().max(40).optional() }).parse(req.body);
    const { token } = await activateDevice(db, signer, { ...b, ip: req.ip });
    return { token, serverTime: new Date().toISOString() };
  });
  app.post('/v1/licenses/validate', licenseLimit, async (req) => {
    const b = z.object({ licenseKey: LicenseKey, fingerprint: Fingerprint, nonce: Nonce, appVersion: z.string().max(40).optional() }).parse(req.body);
    const { token } = await validateDevice(db, signer, { ...b, ip: req.ip });
    return { token, serverTime: new Date().toISOString() };
  });
  app.post('/v1/licenses/deactivate', licenseLimit, async (req) => {
    const b = z.object({ licenseKey: LicenseKey, fingerprint: Fingerprint }).parse(req.body);
    return { ok: await deactivateDevice(db, b, { type: 'device' }) };
  });

  // ---------------------------------------------------------------- webhooks
  app.post<{ Params: { provider: string } }>('/v1/webhooks/:provider', { config: { rateLimit: { max: 120, timeWindow: '1 minute' } } }, async (req) => {
    const provider = providers.get(req.params.provider);
    if (!provider || !provider.isConfigured()) throw new JarvisError('NOT_FOUND', 'Unknown webhook provider');
    return handleWebhook(db, provider, req.rawBody ?? Buffer.alloc(0), req.headers, req.ip);
  });

  // ---------------------------------------------------------------- admin
  const admin = requireStaff(['admin']);
  const staff = requireStaff(['admin', 'support']);
  const Id = z.object({ id: z.string().uuid() });

  app.get('/v1/admin/dashboard', { preHandler: staff }, async () => {
    const q = async (sql: string) => (await db.query(sql)).rows;
    const [subs, revenue, devices, customers, recent] = await Promise.all([
      q('SELECT status, COUNT(*)::int AS n FROM subscriptions GROUP BY status'),
      q("SELECT currency, SUM(amount)::bigint AS total, COUNT(*)::int AS n FROM payments WHERE status = 'succeeded' AND created_at > now() - interval '30 days' GROUP BY currency"),
      q("SELECT COUNT(*)::int AS n FROM devices WHERE status = 'active'"),
      q("SELECT COUNT(*)::int AS n FROM users WHERE role = 'customer'"),
      q('SELECT ts, actor_type, action, target_type, target_id FROM audit_events ORDER BY ts DESC LIMIT 15'),
    ]);
    return { subscriptions: subs, revenue30d: revenue, activeDevices: devices[0]?.n ?? 0, customers: customers[0]?.n ?? 0, recentActivity: recent };
  });

  app.get<{ Querystring: { q?: string; limit?: string; offset?: string } }>('/v1/admin/customers', { preHandler: staff }, async (req) => {
    const q = `%${req.query.q ?? ''}%`;
    const r = await db.query(
      `SELECT u.id, u.email, u.name, u.role, u.disabled, u.created_at, s.status AS subscription_status, s.plan_code, s.current_period_end,
        (SELECT COUNT(*)::int FROM licenses l WHERE l.user_id = u.id) AS licenses
       FROM users u LEFT JOIN LATERAL (SELECT * FROM subscriptions s WHERE s.user_id = u.id ORDER BY current_period_end DESC LIMIT 1) s ON true
       WHERE u.email ILIKE $1 OR u.name ILIKE $1 ORDER BY u.created_at DESC LIMIT $2 OFFSET $3`,
      [q, Math.min(Number(req.query.limit ?? 50), 200), Number(req.query.offset ?? 0)],
    );
    return r.rows;
  });
  app.post('/v1/admin/customers', { preHandler: admin }, async (req) => {
    const b = z.object({ email: z.string().email(), name: z.string().optional(), password: z.string().min(10), role: z.enum(['customer', 'support', 'admin']).default('customer') }).parse(req.body);
    const u = await createUser(db, b);
    await audit(db, { actorType: 'admin', actorId: req.user!.id, action: 'user.create_by_admin', targetType: 'user', targetId: u.id, details: { role: b.role } });
    return u;
  });
  app.get<{ Params: { id: string } }>('/v1/admin/customers/:id', { preHandler: staff }, async (req) => {
    const { id } = Id.parse(req.params);
    const user = (await db.query('SELECT id, email, name, role, disabled, created_at FROM users WHERE id = $1', [id])).rows[0];
    if (!user) throw new JarvisError('NOT_FOUND', 'Customer not found');
    const [subscriptions, licenses, devices, payments, auditRows] = await Promise.all([
      db.query('SELECT * FROM subscriptions WHERE user_id = $1 ORDER BY created_at DESC', [id]),
      db.query('SELECT id, key_last4, status, max_devices, created_at, revoked_at, revoked_reason FROM licenses WHERE user_id = $1', [id]),
      db.query('SELECT d.* FROM devices d JOIN licenses l ON l.id = d.license_id WHERE l.user_id = $1 ORDER BY last_seen DESC', [id]),
      db.query('SELECT * FROM payments WHERE user_id = $1 ORDER BY created_at DESC', [id]),
      db.query("SELECT * FROM audit_events WHERE (target_type = 'user' AND target_id = $1) OR actor_id = $1 ORDER BY ts DESC LIMIT 100", [id]),
    ]);
    return { user, subscriptions: subscriptions.rows, licenses: licenses.rows, devices: devices.rows.map(({ fingerprint: _f, ...d }) => d), payments: payments.rows, audit: auditRows.rows };
  });
  app.post<{ Params: { id: string } }>('/v1/admin/customers/:id/disable', { preHandler: admin }, async (req) => {
    const { id } = Id.parse(req.params);
    const { disabled } = z.object({ disabled: z.boolean() }).parse(req.body);
    await db.query('UPDATE users SET disabled = $2 WHERE id = $1', [id, disabled]);
    if (disabled) await db.query('DELETE FROM sessions WHERE user_id = $1', [id]);
    await audit(db, { actorType: 'admin', actorId: req.user!.id, action: disabled ? 'user.disable' : 'user.enable', targetType: 'user', targetId: id });
    return { ok: true };
  });

  app.get<{ Querystring: { status?: string; q?: string } }>('/v1/admin/subscriptions', { preHandler: staff }, async (req) => {
    const r = await db.query(
      `SELECT s.*, u.email FROM subscriptions s JOIN users u ON u.id = s.user_id
       WHERE ($1::text IS NULL OR s.status = $1) AND ($2::text IS NULL OR u.email ILIKE $2) ORDER BY s.current_period_end DESC LIMIT 500`,
      [req.query.status || null, req.query.q ? `%${req.query.q}%` : null],
    );
    return r.rows;
  });
  app.post<{ Params: { id: string; action: string } }>('/v1/admin/subscriptions/:id/:action', { preHandler: admin }, async (req) => {
    const { id } = Id.parse({ id: req.params.id });
    const action = z.enum(['suspend', 'reactivate', 'cancel', 'expire', 'extend']).parse(req.params.action);
    const b = z.object({ reason: z.string().max(500).optional(), days: z.number().int().min(1).max(3660).optional() }).parse(req.body ?? {});
    if (action === 'extend') {
      if (!b.days) throw new JarvisError('INVALID_INPUT', 'days is required');
      return adminExtend(db, id, b.days, req.user!.id, b.reason);
    }
    return adminSetStatus(db, id, action, req.user!.id, b.reason);
  });

  app.get<{ Querystring: { status?: string; q?: string } }>('/v1/admin/licenses', { preHandler: staff }, async (req) => {
    const r = await db.query(
      `SELECT l.id, l.user_id, u.email, l.key_last4, l.status, l.max_devices, l.created_at, l.revoked_at, l.revoked_reason,
        (SELECT COUNT(*)::int FROM devices d WHERE d.license_id = l.id AND d.status = 'active') AS active_devices
       FROM licenses l JOIN users u ON u.id = l.user_id
       WHERE ($1::text IS NULL OR l.status = $1) AND ($2::text IS NULL OR u.email ILIKE $2 OR l.key_last4 = upper($3)) ORDER BY l.created_at DESC LIMIT 500`,
      [req.query.status || null, req.query.q ? `%${req.query.q}%` : null, req.query.q ?? ''],
    );
    return r.rows;
  });
  app.post('/v1/admin/licenses', { preHandler: admin }, async (req) => {
    const b = z.object({ userId: z.string().uuid(), maxDevices: z.number().int().min(1).max(50).optional() }).parse(req.body);
    const { license, key } = await issueLicense(db, b.userId, { type: 'admin', id: req.user!.id }, b.maxDevices);
    return { license, key };
  });
  app.post<{ Params: { id: string; action: string } }>('/v1/admin/licenses/:id/:action', { preHandler: admin }, async (req) => {
    const { id } = Id.parse({ id: req.params.id });
    const action = z.enum(['revoke', 'reactivate', 'rotate', 'max-devices']).parse(req.params.action);
    const b = z.object({ reason: z.string().max(500).optional(), maxDevices: z.number().int().min(1).max(50).optional() }).parse(req.body ?? {});
    if (action === 'rotate') return { key: await rotateLicenseKey(db, id, { type: 'admin', id: req.user!.id }) };
    if (action === 'max-devices') {
      if (!b.maxDevices) throw new JarvisError('INVALID_INPUT', 'maxDevices required');
      await setMaxDevices(db, id, b.maxDevices, req.user!.id);
      return { ok: true };
    }
    return setLicenseStatus(db, id, action === 'revoke' ? 'revoked' : 'active', req.user!.id, b.reason);
  });

  app.get<{ Querystring: { status?: string; q?: string } }>('/v1/admin/devices', { preHandler: staff }, async (req) => {
    const r = await db.query(
      `SELECT d.id, d.license_id, d.name, d.platform, d.app_version, d.status, d.first_seen, d.last_seen, d.last_ip, u.email, l.key_last4
       FROM devices d JOIN licenses l ON l.id = d.license_id JOIN users u ON u.id = l.user_id
       WHERE ($1::text IS NULL OR d.status = $1) AND ($2::text IS NULL OR u.email ILIKE $2 OR d.name ILIKE $2) ORDER BY d.last_seen DESC LIMIT 500`,
      [req.query.status || null, req.query.q ? `%${req.query.q}%` : null],
    );
    return r.rows;
  });
  app.post<{ Params: { id: string } }>('/v1/admin/devices/:id/deactivate', { preHandler: admin }, async (req) => {
    const { id } = Id.parse(req.params);
    return { ok: await deactivateDevice(db, { deviceId: id }, { type: 'admin', id: req.user!.id }) };
  });

  app.get<{ Querystring: { status?: string; q?: string } }>('/v1/admin/payments', { preHandler: staff }, async (req) => {
    const r = await db.query(
      `SELECT p.*, u.email FROM payments p LEFT JOIN users u ON u.id = p.user_id
       WHERE ($1::text IS NULL OR p.status = $1) AND ($2::text IS NULL OR u.email ILIKE $2 OR p.provider_payment_id ILIKE $2) ORDER BY p.created_at DESC LIMIT 500`,
      [req.query.status || null, req.query.q ? `%${req.query.q}%` : null],
    );
    return r.rows;
  });
  /** Record a confirmed manual/bank-transfer payment; activates or extends the subscription. */
  app.post('/v1/admin/payments/manual', { preHandler: admin }, async (req) => {
    const b = z.object({ userId: z.string().uuid(), plan: z.enum(['monthly', 'yearly']), amount: z.number().int().positive(), currency: z.string().default('PKR'), reference: z.string().min(3).max(120), note: z.string().max(500).optional() }).parse(req.body);
    const { subscription, duplicate } = await applyPayment(db, { userId: b.userId, planCode: b.plan, provider: 'manual', providerPaymentId: b.reference, amount: b.amount, currency: b.currency, occurredAt: new Date(), actor: { type: 'admin', id: req.user!.id }, note: b.note });
    await db.query("UPDATE checkout_sessions SET status = 'completed' WHERE reference = $1", [b.reference]);
    return { subscription, duplicate };
  });
  app.get('/v1/admin/webhooks', { preHandler: staff }, async () => (await db.query('SELECT id, provider, provider_event_id, type, status, error, received_at, processed_at FROM webhook_events ORDER BY received_at DESC LIMIT 300')).rows);

  app.get<{ Querystring: { action?: string; target?: string; limit?: string } }>('/v1/admin/audit', { preHandler: staff }, async (req) => {
    const r = await db.query(
      `SELECT * FROM audit_events WHERE ($1::text IS NULL OR action ILIKE $1) AND ($2::text IS NULL OR target_id = $2 OR actor_id = $2) ORDER BY ts DESC LIMIT $3`,
      [req.query.action ? `%${req.query.action}%` : null, req.query.target || null, Math.min(Number(req.query.limit ?? 200), 1000)],
    );
    return r.rows;
  });

  app.get('/v1/admin/plans', { preHandler: staff }, async () => (await db.query('SELECT * FROM plans ORDER BY amount')).rows);
  app.put<{ Params: { code: string } }>('/v1/admin/plans/:code', { preHandler: admin }, async (req) => {
    const b = z.object({ name: z.string().min(2).optional(), amount: z.number().int().positive().optional(), active: z.boolean().optional() }).parse(req.body);
    const cur = await getPlan(db, req.params.code);
    const r = await db.query('UPDATE plans SET name = $2, amount = $3, active = $4, updated_at = now() WHERE code = $1 RETURNING *', [cur.code, b.name ?? cur.name, b.amount ?? cur.amount, b.active ?? cur.active]);
    await audit(db, { actorType: 'admin', actorId: req.user!.id, action: 'plan.update', targetType: 'plan', targetId: cur.code, details: { before: { amount: cur.amount, name: cur.name, active: cur.active }, after: b } });
    return r.rows[0];
  });

  app.get('/v1/admin/settings', { preHandler: staff }, async () => ({ ...(await getSettings(db)), providers: [...providers.values()].map((p) => ({ id: p.id, configured: p.isConfigured() })) }));
  app.put('/v1/admin/settings', { preHandler: admin }, async (req) => {
    const b = z.object({ graceHours: z.number().int().min(0).max(24 * 60).optional(), canceledKeepsAccessUntilPeriodEnd: z.boolean().optional(), defaultMaxDevices: z.number().int().min(1).max(50).optional(), tokenTtlHours: z.number().int().min(1).max(24 * 14).optional(), bankTransferInstructions: z.string().max(4000).optional() }).parse(req.body);
    const s = await updateSettings(db, b);
    await audit(db, { actorType: 'admin', actorId: req.user!.id, action: 'settings.update', details: b });
    return s;
  });

  // ---------------------------------------------------------------- background expiry reconciliation
  let timer: NodeJS.Timeout | undefined;
  if (opts.reconcileIntervalMs) {
    timer = setInterval(() => void reconcileAll(db).catch((e) => app.log.error(e)), opts.reconcileIntervalMs);
    timer.unref();
  }
  app.addHook('onClose', async () => timer && clearInterval(timer));

  return app;
}
