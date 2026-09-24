import { JarvisError, Logger } from '@jarvis/shared';
import { redact } from '@jarvis/security';
import { ProviderHttpError, type ChatRequest, type ChatResponse, type ModelProvider } from './types.js';

/** Logical model roles; each maps to an ordered fallback chain of provider/model targets. */
export type ModelRole = 'fast' | 'reasoning' | 'coding' | 'vision' | 'audio' | 'embedding';

export interface ModelTarget {
  provider: string;
  model: string;
}

export type RoleConfig = Record<ModelRole, ModelTarget[]>;

export const DEFAULT_ROLES: RoleConfig = {
  fast: [{ provider: 'openrouter', model: 'openai/gpt-4o-mini' }],
  reasoning: [
    { provider: 'openrouter', model: 'anthropic/claude-sonnet-4' },
    { provider: 'openrouter', model: 'openai/gpt-4o' },
  ],
  coding: [{ provider: 'openrouter', model: 'anthropic/claude-sonnet-4' }],
  vision: [{ provider: 'openrouter', model: 'openai/gpt-4o' }],
  audio: [{ provider: 'openrouter', model: 'google/gemini-2.5-flash' }],
  embedding: [],
};

export interface ModelStats {
  requests: number;
  errors: number;
  promptTokens: number;
  completionTokens: number;
  totalLatencyMs: number;
  lastError?: string;
}

export interface RequestLogEntry {
  ts: string;
  role: ModelRole | 'direct';
  provider: string;
  model: string;
  ok: boolean;
  latencyMs: number;
  tokens?: number;
  error?: string;
}

/**
 * Routes chat requests by role to providers with ordered fallback, tracks
 * token usage/latency/errors per model, and keeps a redacted request log.
 */
export class ModelRouter {
  private providers = new Map<string, ModelProvider>();
  private stats = new Map<string, ModelStats>();
  private log: RequestLogEntry[] = [];
  private readonly logger = new Logger('model-router');

  constructor(private roles: RoleConfig = structuredClone(DEFAULT_ROLES)) {}

  register(p: ModelProvider): void {
    this.providers.set(p.id, p);
  }
  getProvider(id: string): ModelProvider | undefined {
    return this.providers.get(id);
  }
  listProviders(): Array<{ id: string; configured: boolean }> {
    return [...this.providers.values()].map((p) => ({ id: p.id, configured: p.isConfigured() }));
  }
  setRoles(roles: RoleConfig): void {
    this.roles = structuredClone(roles);
  }
  getRoles(): RoleConfig {
    return structuredClone(this.roles);
  }
  isRoleAvailable(role: ModelRole): boolean {
    return this.roles[role].some((t) => this.providers.get(t.provider)?.isConfigured());
  }

  getStats(): Record<string, ModelStats> {
    return Object.fromEntries([...this.stats].map(([k, v]) => [k, { ...v }]));
  }
  getRequestLog(limit = 100): RequestLogEntry[] {
    return this.log.slice(-limit);
  }

  private record(entry: RequestLogEntry, res?: ChatResponse): void {
    const key = `${entry.provider}/${entry.model}`;
    const s = this.stats.get(key) ?? { requests: 0, errors: 0, promptTokens: 0, completionTokens: 0, totalLatencyMs: 0 };
    s.requests++;
    s.totalLatencyMs += entry.latencyMs;
    if (!entry.ok) {
      s.errors++;
      s.lastError = entry.error;
    }
    if (res) {
      s.promptTokens += res.usage.promptTokens;
      s.completionTokens += res.usage.completionTokens;
    }
    this.stats.set(key, s);
    this.log.push(redact(entry));
    if (this.log.length > 1000) this.log.shift();
  }

  async chat(
    role: ModelRole,
    req: Omit<ChatRequest, 'model'>,
    opts: { onDelta?: (t: string) => void } = {},
  ): Promise<ChatResponse> {
    const chain = this.roles[role].filter((t) => this.providers.get(t.provider)?.isConfigured());
    if (chain.length === 0)
      throw new JarvisError('NOT_CONFIGURED', `No configured model provider for role "${role}". Add an OpenRouter API key in Settings.`);
    let lastErr: unknown;
    for (const target of chain) {
      const p = this.providers.get(target.provider)!;
      const started = Date.now();
      try {
        const full = { ...req, model: target.model };
        const res = opts.onDelta && p.stream ? await p.stream(full, opts.onDelta) : await p.chat(full);
        this.record(
          { ts: new Date().toISOString(), role, provider: p.id, model: target.model, ok: true, latencyMs: Date.now() - started, tokens: res.usage.totalTokens },
          res,
        );
        return res;
      } catch (e) {
        lastErr = e;
        const msg = e instanceof Error ? e.message : String(e);
        this.record({ ts: new Date().toISOString(), role, provider: p.id, model: target.model, ok: false, latencyMs: Date.now() - started, error: msg });
        if (req.signal?.aborted) throw new JarvisError('CANCELLED', 'Request cancelled');
        const retryable = e instanceof ProviderHttpError ? e.retryable || e.status === 404 || e.status === 400 : true;
        this.logger.warn('model request failed, trying fallback', { provider: p.id, model: target.model, error: msg });
        if (!retryable) break;
      }
    }
    throw new JarvisError('PROVIDER_ERROR', lastErr instanceof Error ? lastErr.message : 'All model providers failed');
  }
}
