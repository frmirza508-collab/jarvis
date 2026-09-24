import Fastify from 'fastify';
import cors from '@fastify/cors';
import websocket from '@fastify/websocket';
import type { WebSocket } from 'ws';
import { timingSafeEqual } from 'node:crypto';
import { spawn } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { JarvisError, newId, toJarvisError, PERMISSION_CATEGORIES } from '@jarvis/shared';
import type { Decision, PermissionRequest } from '@jarvis/permissions';
import { MEMORY_SCOPES } from '@jarvis/memory';
import { DEPARTMENTS } from '@jarvis/agent-registry';
import { SECRET_NAMES, type CoreSettings, type JarvisCore } from './core.js';
import type { LicenseClient } from './license-client.js';

export interface ServerOptions {
  core: JarvisCore;
  /** Base URL of the license/update server. */
  updateServerUrl?: string;
  fetchImpl?: typeof fetch;
  license?: LicenseClient;
  token: string;
  dataDir?: string;
  allowedOrigins?: string[];
  version: string;
}

const DEFAULT_ORIGINS = [
  'tauri://localhost',
  'http://tauri.localhost',
  'https://tauri.localhost',
  'http://localhost:1420',
  'http://127.0.0.1:1420',
];

export function compareVersions(a: string, b: string): number {
  const pa = a.split(/[.-]/).map((x) => Number.parseInt(x, 10) || 0);
  const pb = b.split(/[.-]/).map((x) => Number.parseInt(x, 10) || 0);
  for (let i = 0; i < 3; i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0);
  return 0;
}

/** Opens an https URL in the user's default browser (no shell interpretation). */
function openExternal(url: string): void {
  const [cmd, args] =
    process.platform === 'win32'
      ? ['rundll32', ['url.dll,FileProtocolHandler', url]]
      : process.platform === 'darwin'
        ? ['open', [url]]
        : ['xdg-open', [url]];
  spawn(cmd as string, args as string[], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
}

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

const HTTP_STATUS: Record<string, number> = {
  PERMISSION_DENIED: 403,
  NOT_FOUND: 404,
  INVALID_INPUT: 400,
  NOT_CONFIGURED: 409,
  LICENSE_REQUIRED: 402,
  CANCELLED: 499,
  TIMEOUT: 504,
  PROVIDER_ERROR: 502,
  UNSUPPORTED_PLATFORM: 501,
  INTERNAL: 500,
};

/**
 * Local-only control API for the desktop UI. Binds to 127.0.0.1, requires a
 * per-launch bearer token and restricts CORS to the desktop origin.
 */
export async function createServer(opts: ServerOptions) {
  const { core, license } = opts;
  const app = Fastify({ logger: false, bodyLimit: 30 * 1024 * 1024 });
  const origins = opts.allowedOrigins ?? DEFAULT_ORIGINS;
  await app.register(cors, {
    origin: (o, cb) => cb(null, !o || origins.includes(o)),
    credentials: false,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
    allowedHeaders: ['Authorization', 'Content-Type', 'X-Language-Hint'],
  });
  await app.register(websocket);
  app.addContentTypeParser(/^audio\/.*/, { parseAs: 'buffer' }, (_req, body, done) => done(null, body));

  const clients = new Set<WebSocket>();
  const broadcast = (msg: unknown) => {
    const text = JSON.stringify(msg);
    for (const c of clients) if (c.readyState === 1) c.send(text);
  };

  // --- permission prompts are resolved by the human through the UI ---------------
  const pendingPermissions = new Map<string, (d: Decision) => void>();
  core.permissions.setConfirmHandler(
    (req: PermissionRequest) =>
      new Promise<Decision>((resolve) => {
        const timer = setTimeout(() => {
          pendingPermissions.delete(req.id);
          broadcast({ kind: 'permission.resolved', id: req.id, decision: 'deny', reason: 'timeout' });
          resolve('deny');
        }, 5 * 60_000);
        pendingPermissions.set(req.id, (d) => {
          clearTimeout(timer);
          pendingPermissions.delete(req.id);
          broadcast({ kind: 'permission.resolved', id: req.id, decision: d });
          resolve(d);
        });
        broadcast({ kind: 'permission', request: req });
      }),
  );

  core.bus.onAny((event) => broadcast({ kind: 'bus', event }));
  core.onLive((e) => broadcast(e));
  core.audit.onEntry((entry) => broadcast({ kind: 'audit', entry }));
  core.registry.onChange((r) =>
    broadcast({
      kind: 'agent',
      agent: { id: r.def.id, health: r.health, metrics: r.metrics, activeTasks: r.activeTasks },
    }),
  );

  app.setErrorHandler((err, _req, reply) => {
    const je = err instanceof z.ZodError ? new JarvisError('INVALID_INPUT', err.message) : toJarvisError(err);
    const status =
      (err as { statusCode?: number }).statusCode && !(err instanceof JarvisError)
        ? (err as { statusCode: number }).statusCode
        : (HTTP_STATUS[je.code] ?? 500);
    reply.status(status).send({ error: je.code, message: je.message });
  });

  app.addHook('onRequest', async (req, reply) => {
    if (req.url === '/health') return;
    const header = req.headers.authorization ?? '';
    const q = (req.query as { token?: string } | undefined)?.token;
    const presented = header.startsWith('Bearer ')
      ? header.slice(7)
      : req.url.startsWith('/events')
        ? (q ?? '')
        : '';
    if (!safeEqual(presented, opts.token))
      return reply.status(401).send({ error: 'UNAUTHORIZED', message: 'Invalid session token' });
  });

  const persistSettings = () => {
    if (!opts.dataDir) return;
    mkdirSync(opts.dataDir, { recursive: true });
    const s: CoreSettings = {
      ...core.settings,
      roles: core.router.getRoles(),
      permissionPolicy: core.permissions.getPolicy(),
    };
    writeFileSync(path.join(opts.dataDir, 'settings.json'), JSON.stringify(s, null, 2));
  };

  // --- system --------------------------------------------------------------------
  app.get('/health', async () => ({ ok: true, version: opts.version }));
  app.get('/status', async () => ({
    version: opts.version,
    platform: process.platform,
    capabilities: core.capabilities(),
    providers: core.router.listProviders(),
    license: license?.status() ?? {
      mode: 'development',
      premium: core.orchestrator.checkEntitlement().premium,
    },
    agents: {
      total: core.registry.size(),
      byDepartment: Object.fromEntries(
        DEPARTMENTS.map((d) => [d, core.registry.list({ department: d }).length]),
      ),
    },
    activeRequests: core.orchestrator.activeRequests(),
    memory: core.memory.stats(),
  }));

  app.get('/events', { websocket: true }, (socket) => {
    clients.add(socket);
    socket.send(
      JSON.stringify({
        kind: 'hello',
        version: opts.version,
        pendingPermissions: [...core.permissions.pendingRequests()],
      }),
    );
    socket.on('close', () => clients.delete(socket));
  });

  // --- requests ------------------------------------------------------------------
  const RequestBody = z.object({
    text: z.string().min(1).max(20_000),
    language: z.string().optional(),
    sessionId: z.string().optional(),
  });
  app.post('/requests', async (req, reply) => {
    const body = RequestBody.parse(req.body);
    const gate = core.orchestrator.checkEntitlement();
    if (!gate.premium) throw new JarvisError('LICENSE_REQUIRED', gate.reason ?? 'License required');
    const requestId = newId('req');
    core.orchestrator
      .handle({ ...body, requestId })
      .then((result) => broadcast({ kind: 'request.done', result }))
      .catch((e) => {
        const je = toJarvisError(e);
        broadcast({ kind: 'request.error', requestId, code: je.code, message: je.message });
      });
    return reply.status(202).send({ requestId });
  });
  app.post<{ Params: { id: string } }>('/requests/:id/cancel', async (req) => ({
    cancelled: core.orchestrator.cancel(req.params.id),
  }));
  app.get('/history', async () => core.memory.taskHistory(100));
  app.get<{ Querystring: { taskId?: string } }>('/events/history', async (req) =>
    core.bus.getHistory({ taskId: req.query.taskId, limit: 500 }),
  );

  // --- permissions -----------------------------------------------------------------
  app.get('/permissions/pending', async () => core.permissions.pendingRequests());
  app.post<{ Params: { id: string } }>('/permissions/:id/decision', async (req) => {
    const { decision } = z
      .object({ decision: z.enum(['allow_once', 'allow_always', 'deny']) })
      .parse(req.body);
    const resolve = pendingPermissions.get(req.params.id);
    if (!resolve) throw new JarvisError('NOT_FOUND', 'No pending permission request with that id');
    resolve(decision);
    return { ok: true };
  });
  app.get('/permissions/policy', async () => core.permissions.getPolicy());
  app.put('/permissions/policy', async (req) => {
    const p = z
      .object({
        confirmAtOrAbove: z.enum(['low', 'medium', 'high', 'critical']),
        autoAllow: z.array(z.enum(PERMISSION_CATEGORIES)),
        rules: z.array(
          z.object({
            id: z.string(),
            action: z.string(),
            targetPrefix: z.string().optional(),
            effect: z.enum(['allow', 'deny']),
            maxRisk: z.enum(['low', 'medium', 'high', 'critical']),
            createdAt: z.string(),
          }),
        ),
      })
      .parse(req.body);
    // DESTRUCTIVE can never be auto-allowed.
    p.autoAllow = p.autoAllow.filter((c) => c !== 'DESTRUCTIVE');
    core.permissions.setPolicy(p);
    persistSettings();
    return core.permissions.getPolicy();
  });
  app.delete<{ Params: { id: string } }>('/permissions/rules/:id', async (req) => {
    const ok = core.permissions.removeRule(req.params.id);
    persistSettings();
    return { ok };
  });

  // --- agents / skills / tools -------------------------------------------------------
  app.get('/agents', async () =>
    core.registry.list().map((a) => ({
      ...a.def,
      instructions: undefined,
      health: a.health,
      metrics: a.metrics,
      activeTasks: a.activeTasks,
    })),
  );
  app.post('/agents', async (req) => {
    const { brief } = z.object({ brief: z.string().min(10).max(4000) }).parse(req.body);
    const gate = core.orchestrator.checkEntitlement();
    if (!gate.premium) throw new JarvisError('LICENSE_REQUIRED', gate.reason ?? 'License required');
    const def = await core.orchestrator.createAgent(brief);
    core.refreshAgentHealth();
    return def;
  });
  app.patch<{ Params: { id: string } }>('/agents/:id', async (req) => {
    const { enabled } = z.object({ enabled: z.boolean() }).parse(req.body);
    if (!core.registry.get(req.params.id)) throw new JarvisError('NOT_FOUND', 'Unknown agent');
    core.registry.setEnabled(req.params.id, enabled);
    return { ok: true };
  });
  app.delete<{ Params: { id: string } }>('/agents/:id', async (req) => {
    if (!core.registry.unregister(req.params.id))
      throw new JarvisError(
        'INVALID_INPUT',
        'Only dynamic agents can be removed; built-in agents can be disabled',
      );
    return { ok: true };
  });
  app.get('/skills', async () =>
    core.skills.list().map((s) => ({
      id: s.id,
      name: s.name,
      description: s.description,
      category: s.category,
      tools: s.tools,
      usesModel: s.usesModel,
      stats: core.skills.getStats(s.id),
    })),
  );
  app.get('/tools', async () =>
    core.tools.list().map((t) => ({
      id: t.id,
      title: t.title,
      description: t.description,
      module: t.module,
      categories: t.categories,
      status: core.tools.statusOf(t.id),
    })),
  );
  app.get('/tools/calls', async () => core.tools.recentCalls(200));

  // --- memory ------------------------------------------------------------------------
  app.get<{ Querystring: { q?: string; scope?: string } }>('/memory', async (req) => {
    const scope = req.query.scope ? z.enum(MEMORY_SCOPES).parse(req.query.scope) : undefined;
    return req.query.q
      ? core.memory.search(req.query.q, { scopes: scope ? [scope] : undefined, limit: 50 })
      : core.memory.list({ scope, limit: 200 });
  });
  app.post('/memory', async (req) => {
    const b = z
      .object({
        content: z.string().min(1).max(8000),
        scope: z.enum(MEMORY_SCOPES),
        scopeId: z.string().optional(),
        tags: z.array(z.string()).optional(),
      })
      .parse(req.body);
    return core.memory.remember({ ...b, source: 'user', verified: true });
  });
  app.delete<{ Params: { id: string } }>('/memory/:id', async (req) => ({
    ok: core.memory.forget(req.params.id),
  }));
  app.post<{ Params: { id: string } }>('/memory/:id/verify', async (req) =>
    core.memory.verifyLesson(req.params.id, 'Verified by user'),
  );
  app.post('/memory/purge', async (req) => {
    const b = z
      .object({
        scope: z.enum(MEMORY_SCOPES).optional(),
        olderThanDays: z.number().int().min(0).optional(),
        expiredOnly: z.boolean().optional(),
      })
      .parse(req.body);
    return { removed: core.memory.purge(b) };
  });
  app.get('/preferences', async () => core.memory.preferences());
  app.put<{ Params: { key: string } }>('/preferences/:key', async (req) => {
    core.memory.setPreference(req.params.key, (req.body as { value: unknown }).value);
    return { ok: true };
  });

  // --- audit -------------------------------------------------------------------------
  app.get<{ Querystring: { limit?: string; actor?: string } }>('/audit', async (req) => ({
    chainIntact: core.audit.verify() === -1,
    entries: core.audit.list({ limit: Number(req.query.limit ?? 300), actor: req.query.actor }),
  }));

  // --- providers, models and secrets ------------------------------------------------
  app.get('/secrets', async () => SECRET_NAMES.map((n) => ({ name: n, configured: core.secrets.has(n) })));
  app.put<{ Params: { name: string } }>('/secrets/:name', async (req) => {
    const name = z.enum(SECRET_NAMES).parse(req.params.name);
    const { value } = z.object({ value: z.string().min(8).max(500) }).parse(req.body);
    core.secrets.set(name, value.trim());
    core.audit.record({ actor: 'user', action: 'secrets.set', target: name, outcome: 'info' });
    core.refreshAgentHealth();
    return { name, configured: true };
  });
  app.delete<{ Params: { name: string } }>('/secrets/:name', async (req) => {
    const name = z.enum(SECRET_NAMES).parse(req.params.name);
    core.secrets.delete(name);
    core.audit.record({ actor: 'user', action: 'secrets.delete', target: name, outcome: 'info' });
    core.refreshAgentHealth();
    return { name, configured: false };
  });
  app.get<{ Params: { provider: string } }>('/providers/:provider/models', async (req) => {
    const p = core.router.getProvider(req.params.provider);
    if (!p) throw new JarvisError('NOT_FOUND', 'Unknown provider');
    return p.listModels();
  });
  app.post<{ Params: { provider: string } }>('/providers/:provider/test', async (req) => {
    const p = core.router.getProvider(req.params.provider);
    if (!p) throw new JarvisError('NOT_FOUND', 'Unknown provider');
    const model =
      core.router.getRoles().fast.find((t) => t.provider === p.id)?.model ??
      core.router.getRoles().reasoning[0]?.model;
    if (!model) throw new JarvisError('NOT_CONFIGURED', 'No model configured for this provider');
    const started = Date.now();
    const r = await p.chat({
      model,
      messages: [{ role: 'user', content: 'Reply with the single word: ready' }],
      maxTokens: 5,
    });
    return { ok: true, model: r.model, latencyMs: Date.now() - started, reply: r.content };
  });
  app.get('/models/stats', async () => ({
    stats: core.router.getStats(),
    log: core.router.getRequestLog(100),
  }));

  // --- settings ----------------------------------------------------------------------
  app.get('/settings', async () => ({
    ...core.settings,
    roles: core.router.getRoles(),
    permissionPolicy: core.permissions.getPolicy(),
    languages: core.voiceLanguages.all(),
  }));
  app.put('/settings/roles', async (req) => {
    const Target = z.object({ provider: z.string(), model: z.string().min(1) });
    const roles = z
      .object({
        fast: z.array(Target),
        reasoning: z.array(Target),
        coding: z.array(Target),
        vision: z.array(Target),
        audio: z.array(Target),
        embedding: z.array(Target),
      })
      .parse(req.body);
    core.router.setRoles(roles);
    persistSettings();
    return roles;
  });
  app.put('/settings/workspace', async (req) => {
    const { workspace } = z.object({ workspace: z.string().min(1) }).parse(req.body);
    core.settings.workspace = path.resolve(workspace);
    persistSettings();
    return { workspace: core.settings.workspace, note: 'Applies to new tasks after restart' };
  });
  app.put<{ Params: { code: string } }>('/settings/languages/:code', async (req) => {
    const patch = z
      .object({ enabled: z.boolean().optional(), ttsVoice: z.string().optional() })
      .parse(req.body);
    return core.voiceLanguages.configure(req.params.code, patch);
  });

  // --- voice ------------------------------------------------------------------------
  app.post('/voice/transcribe', async (req) => {
    const audio = req.body as Buffer;
    if (!Buffer.isBuffer(audio) || audio.length < 100)
      throw new JarvisError('INVALID_INPUT', 'Send raw audio with an audio/* content type');
    const hint = (req.headers['x-language-hint'] as string | undefined) || undefined;
    return core.speech.transcribe(audio, {
      mimeType: String(req.headers['content-type']),
      languageHint: hint,
    });
  });
  app.post('/voice/speak', async (req, reply) => {
    const { text, language, voice } = z
      .object({ text: z.string().min(1).max(4000), language: z.string(), voice: z.string().optional() })
      .parse(req.body);
    if (!core.tts.isConfigured())
      throw new JarvisError('NOT_CONFIGURED', 'Cloud TTS not configured; the desktop uses Windows voices');
    const out = await core.tts.synthesize(text, { language, voice });
    return reply.header('Content-Type', out.mimeType).send(out.audio);
  });

  // --- updates -------------------------------------------------------------------------
  app.get('/updates', async () => {
    if (!opts.updateServerUrl)
      return { current: opts.version, updateAvailable: false, reason: 'No update server configured' };
    const res = await (opts.fetchImpl ?? fetch)(`${opts.updateServerUrl}/v1/releases/latest`, {
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new JarvisError('PROVIDER_ERROR', `Update server returned ${res.status}`);
    const latest = (await res.json()) as {
      version: string | null;
      url?: string;
      sha256?: string;
      notes?: string;
    };
    const newer = !!latest.version && compareVersions(latest.version, opts.version) > 0;
    return {
      current: opts.version,
      latest: latest.version,
      updateAvailable: newer,
      url: newer ? latest.url : undefined,
      sha256: newer ? latest.sha256 : undefined,
      notes: newer ? latest.notes : undefined,
    };
  });
  app.post('/system/open-url', async (req) => {
    const { url } = z.object({ url: z.string().url() }).parse(req.body);
    if (!url.startsWith('https://'))
      throw new JarvisError('PERMISSION_DENIED', 'Only https links can be opened');
    openExternal(url);
    core.audit.record({ actor: 'user', action: 'system.open_url', target: url, outcome: 'info' });
    return { ok: true };
  });

  // --- license ------------------------------------------------------------------------
  app.get(
    '/license',
    async () =>
      license?.status() ?? { mode: 'development', premium: core.orchestrator.checkEntitlement().premium },
  );
  app.post('/license/activate', async (req) => {
    if (!license) throw new JarvisError('NOT_CONFIGURED', 'Licensing not configured');
    const { licenseKey } = z
      .object({ licenseKey: z.string().regex(/^JRV(-[0-9A-Z]{5}){4}$/i) })
      .parse(req.body);
    const s = await license.activate(licenseKey.toUpperCase());
    broadcast({ kind: 'license', status: s });
    return s;
  });
  app.post('/license/refresh', async () => {
    if (!license) throw new JarvisError('NOT_CONFIGURED', 'Licensing not configured');
    try {
      const s = await license.refresh();
      broadcast({ kind: 'license', status: s });
      return s;
    } catch (e) {
      broadcast({ kind: 'license', status: license.status() });
      throw e;
    }
  });
  app.post('/license/deactivate', async () => {
    if (!license) throw new JarvisError('NOT_CONFIGURED', 'Licensing not configured');
    await license.deactivate();
    const s = license.status();
    broadcast({ kind: 'license', status: s });
    return s;
  });

  return Object.assign(app, { pendingPermissions });
}
