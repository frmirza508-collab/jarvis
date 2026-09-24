import { OpenAICompatibleProvider } from './openai-compatible.js';

export const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';

/**
 * OpenRouter - the primary model gateway. OpenRouter exposes an
 * OpenAI-compatible chat completions API; the optional HTTP-Referer and
 * X-Title headers attribute requests to the app.
 */
export class OpenRouterProvider extends OpenAICompatibleProvider {
  constructor(opts: { apiKey: () => string | undefined; appUrl?: string; appName?: string; fetchImpl?: typeof fetch; baseUrl?: string }) {
    super({
      id: 'openrouter',
      baseUrl: opts.baseUrl ?? OPENROUTER_BASE_URL,
      apiKey: opts.apiKey,
      requiresKey: true,
      fetchImpl: opts.fetchImpl,
      extraHeaders: {
        'HTTP-Referer': opts.appUrl ?? 'https://jarvis.local',
        'X-Title': opts.appName ?? 'JARVIS',
      },
    });
  }
}
