import { JarvisError } from '@jarvis/shared';
import { redactString } from '@jarvis/security';
import {
  ProviderHttpError,
  type ChatRequest,
  type ChatResponse,
  type ModelInfo,
  type ModelProvider,
  type ToolCall,
} from './types.js';

export interface OpenAICompatibleOptions {
  id: string;
  baseUrl: string; // e.g. https://openrouter.ai/api/v1 or http://localhost:11434/v1
  apiKey?: () => string | undefined;
  extraHeaders?: Record<string, string>;
  requiresKey?: boolean;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

interface WireChoice {
  message?: { content?: string | null; tool_calls?: ToolCall[] };
  delta?: { content?: string | null; tool_calls?: Array<Partial<ToolCall> & { index: number }> };
  finish_reason?: string | null;
}
interface WireResponse {
  id?: string;
  model?: string;
  choices?: WireChoice[];
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
  error?: { message?: string; code?: number | string };
}

/** Adapter for any OpenAI-compatible chat-completions endpoint. */
export class OpenAICompatibleProvider implements ModelProvider {
  readonly id: string;
  protected readonly f: typeof fetch;

  constructor(protected readonly opts: OpenAICompatibleOptions) {
    this.id = opts.id;
    this.f = opts.fetchImpl ?? fetch;
  }

  isConfigured(): boolean {
    return !this.opts.requiresKey || !!this.opts.apiKey?.();
  }

  protected headers(): Record<string, string> {
    const h: Record<string, string> = { 'Content-Type': 'application/json', ...this.opts.extraHeaders };
    const key = this.opts.apiKey?.();
    if (key) h.Authorization = `Bearer ${key}`;
    return h;
  }

  protected body(req: ChatRequest, stream: boolean): Record<string, unknown> {
    return {
      model: req.model,
      messages: req.messages,
      ...(req.tools?.length ? { tools: req.tools } : {}),
      ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
      ...(req.maxTokens ? { max_tokens: req.maxTokens } : {}),
      ...(req.responseFormat === 'json_object' ? { response_format: { type: 'json_object' } } : {}),
      ...(stream ? { stream: true } : {}),
    };
  }

  private async post(path: string, body: unknown, signal?: AbortSignal): Promise<Response> {
    if (!this.isConfigured()) throw new JarvisError('NOT_CONFIGURED', `${this.id}: API key not configured`);
    const timeout = AbortSignal.timeout(this.opts.timeoutMs ?? 120_000);
    const res = await this.f(`${this.opts.baseUrl}${path}`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(body),
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
    if (!res.ok) {
      let msg = `${res.status} ${res.statusText}`;
      try {
        const j = (await res.json()) as WireResponse;
        if (j.error?.message) msg = `${res.status}: ${j.error.message}`;
      } catch {
        /* ignore */
      }
      const retryable = res.status === 429 || res.status >= 500 || res.status === 408;
      throw new ProviderHttpError(res.status, redactString(`${this.id} ${msg}`), retryable);
    }
    return res;
  }

  async chat(req: ChatRequest): Promise<ChatResponse> {
    const res = await this.post('/chat/completions', this.body(req, false), req.signal);
    const j = (await res.json()) as WireResponse;
    if (j.error) throw new ProviderHttpError(502, `${this.id}: ${j.error.message ?? 'provider error'}`, true);
    const c = j.choices?.[0];
    return {
      id: j.id ?? '',
      model: j.model ?? req.model,
      content: c?.message?.content ?? '',
      toolCalls: c?.message?.tool_calls ?? [],
      finishReason: c?.finish_reason ?? null,
      usage: {
        promptTokens: j.usage?.prompt_tokens ?? 0,
        completionTokens: j.usage?.completion_tokens ?? 0,
        totalTokens: j.usage?.total_tokens ?? 0,
      },
      provider: this.id,
    };
  }

  /** Server-sent-events streaming (OpenAI wire format). */
  async stream(req: ChatRequest, onDelta: (text: string) => void): Promise<ChatResponse> {
    const res = await this.post('/chat/completions', this.body(req, true), req.signal);
    if (!res.body) throw new ProviderHttpError(502, `${this.id}: empty stream`, true);
    const decoder = new TextDecoder();
    let buf = '';
    let content = '';
    let id = '';
    let model = req.model;
    let finishReason: string | null = null;
    let usage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
    const tools = new Map<number, ToolCall>();
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      buf += decoder.decode(chunk, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line.startsWith('data:')) continue; // comments like ": keep-alive" are ignored
        const data = line.slice(5).trim();
        if (data === '[DONE]') continue;
        let j: WireResponse;
        try {
          j = JSON.parse(data) as WireResponse;
        } catch {
          continue;
        }
        if (j.error)
          throw new ProviderHttpError(502, `${this.id}: ${j.error.message ?? 'stream error'}`, true);
        id = j.id ?? id;
        model = j.model ?? model;
        const ch = j.choices?.[0];
        const d = ch?.delta?.content;
        if (d) {
          content += d;
          onDelta(d);
        }
        for (const tc of ch?.delta?.tool_calls ?? []) {
          const cur = tools.get(tc.index) ?? {
            id: '',
            type: 'function' as const,
            function: { name: '', arguments: '' },
          };
          if (tc.id) cur.id = tc.id;
          if (tc.function?.name) cur.function.name += tc.function.name;
          if (tc.function?.arguments) cur.function.arguments += tc.function.arguments;
          tools.set(tc.index, cur);
        }
        if (ch?.finish_reason) finishReason = ch.finish_reason;
        if (j.usage)
          usage = {
            promptTokens: j.usage.prompt_tokens ?? 0,
            completionTokens: j.usage.completion_tokens ?? 0,
            totalTokens: j.usage.total_tokens ?? 0,
          };
      }
    }
    return { id, model, content, toolCalls: [...tools.values()], finishReason, usage, provider: this.id };
  }

  async listModels(): Promise<ModelInfo[]> {
    const res = await this.f(`${this.opts.baseUrl}/models`, {
      headers: this.headers(),
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok)
      throw new ProviderHttpError(
        res.status,
        `${this.id}: list models failed ${res.status}`,
        res.status >= 500,
      );
    const j = (await res.json()) as { data?: Array<Record<string, unknown>> };
    return (j.data ?? []).map((m) => ({
      id: String(m.id),
      name: String(m.name ?? m.id),
      contextLength: typeof m.context_length === 'number' ? m.context_length : undefined,
      pricing: m.pricing as ModelInfo['pricing'],
      inputModalities: (m.architecture as { input_modalities?: string[] } | undefined)?.input_modalities,
    }));
  }
}
