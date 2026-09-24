import { describe, expect, it } from 'vitest';
import {
  ModelRouter,
  OpenRouterProvider,
  ProviderHttpError,
  type ChatRequest,
  type ModelProvider,
} from '../src/index.js';

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

describe('OpenRouter adapter', () => {
  it('sends OpenAI-compatible request with auth and attribution headers', async () => {
    let captured: { url: string; init: RequestInit } | undefined;
    const p = new OpenRouterProvider({
      apiKey: () => 'sk-or-v1-test',
      fetchImpl: (async (url: string, init: RequestInit) => {
        captured = { url, init };
        return jsonResponse({
          id: 'gen-1',
          model: 'm',
          choices: [{ message: { content: 'hello' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
        });
      }) as unknown as typeof fetch,
    });
    const r = await p.chat({ model: 'openai/gpt-4o-mini', messages: [{ role: 'user', content: 'hi' }] });
    expect(r.content).toBe('hello');
    expect(r.usage.totalTokens).toBe(4);
    expect(captured!.url).toBe('https://openrouter.ai/api/v1/chat/completions');
    const h = captured!.init.headers as Record<string, string>;
    expect(h.Authorization).toBe('Bearer sk-or-v1-test');
    expect(h['X-Title']).toBe('JARVIS');
    expect(JSON.parse(captured!.init.body as string).model).toBe('openai/gpt-4o-mini');
  });
  it('is not configured without a key and never calls the network', async () => {
    const p = new OpenRouterProvider({
      apiKey: () => undefined,
      fetchImpl: (() => {
        throw new Error('no');
      }) as unknown as typeof fetch,
    });
    expect(p.isConfigured()).toBe(false);
    await expect(p.chat({ model: 'x', messages: [] })).rejects.toThrow(/not configured/);
  });
  it('parses SSE streams including tool calls', async () => {
    const chunks = [
      ': OPENROUTER PROCESSING\n\n',
      'data: {"id":"g","choices":[{"delta":{"content":"Hel"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"lo"}}]}\n\n',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call1","function":{"name":"fs__read","arguments":"{\\"pa"}}]}}]}\n\n',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"th\\":\\"a\\"}"}}]},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":1,"completion_tokens":2,"total_tokens":3}}\n\n',
      'data: [DONE]\n\n',
    ];
    const body = new ReadableStream({
      start(c) {
        for (const ch of chunks) c.enqueue(new TextEncoder().encode(ch));
        c.close();
      },
    });
    const p = new OpenRouterProvider({
      apiKey: () => 'k',
      fetchImpl: (async () => new Response(body, { status: 200 })) as unknown as typeof fetch,
    });
    const deltas: string[] = [];
    const r = await p.stream({ model: 'm', messages: [] }, (d) => deltas.push(d));
    expect(deltas.join('')).toBe('Hello');
    expect(r.toolCalls[0]).toEqual({
      id: 'call1',
      type: 'function',
      function: { name: 'fs__read', arguments: '{"path":"a"}' },
    });
    expect(r.usage.totalTokens).toBe(3);
  });
});

describe('model router', () => {
  const provider = (id: string, impl: (r: ChatRequest) => Promise<string>): ModelProvider => ({
    id,
    isConfigured: () => true,
    listModels: async () => [],
    chat: async (r) => ({
      id: '1',
      model: r.model,
      content: await impl(r),
      toolCalls: [],
      finishReason: 'stop',
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
      provider: id,
    }),
  });
  it('falls back to the next target on retryable errors and records stats', async () => {
    const router = new ModelRouter({
      fast: [
        { provider: 'a', model: 'm1' },
        { provider: 'b', model: 'm2' },
      ],
      reasoning: [],
      coding: [],
      vision: [],
      audio: [],
      embedding: [],
    });
    router.register(
      provider('a', async () => {
        throw new ProviderHttpError(503, 'down', true);
      }),
    );
    router.register(provider('b', async () => 'ok'));
    const r = await router.chat('fast', { messages: [] });
    expect(r.content).toBe('ok');
    expect(router.getStats()['a/m1']!.errors).toBe(1);
    expect(router.getStats()['b/m2']!.requests).toBe(1);
  });
  it('does not fall back on auth errors', async () => {
    const router = new ModelRouter({
      fast: [
        { provider: 'a', model: 'm1' },
        { provider: 'b', model: 'm2' },
      ],
      reasoning: [],
      coding: [],
      vision: [],
      audio: [],
      embedding: [],
    });
    router.register(
      provider('a', async () => {
        throw new ProviderHttpError(401, 'bad key', false);
      }),
    );
    router.register(provider('b', async () => 'ok'));
    await expect(router.chat('fast', { messages: [] })).rejects.toThrow(/bad key/);
  });
  it('caps output tokens by default and explains 402 credit errors', async () => {
    const seen: number[] = [];
    const router = new ModelRouter({
      fast: [{ provider: 'a', model: 'm1' }],
      reasoning: [],
      coding: [],
      vision: [],
      audio: [],
      embedding: [],
    });
    router.register({
      id: 'a',
      isConfigured: () => true,
      listModels: async () => [],
      chat: async (r) => {
        seen.push(r.maxTokens ?? -1);
        throw new ProviderHttpError(402, 'a 402: requires more credits', false);
      },
    });
    await expect(router.chat('fast', { messages: [] })).rejects.toThrow(/Not enough model credit/);
    expect(seen).toEqual([4096]);
  });

  it('reports NOT_CONFIGURED honestly when no provider is set up', async () => {
    await expect(new ModelRouter().chat('fast', { messages: [] })).rejects.toMatchObject({
      code: 'NOT_CONFIGURED',
    });
  });
});
