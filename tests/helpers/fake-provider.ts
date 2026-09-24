import type { ChatRequest, ChatResponse, ModelInfo, ModelProvider } from '@jarvis/model-router';

/**
 * Deterministic scripted model used ONLY in tests to exercise orchestration
 * logic. Each call pops the next scripted reply (or computes one).
 */
export type Script = (req: ChatRequest, call: number) => Partial<ChatResponse> | string;

export class ScriptedProvider implements ModelProvider {
  readonly id: string;
  calls: ChatRequest[] = [];
  constructor(
    private readonly script: Script,
    id = 'openrouter',
  ) {
    this.id = id;
  }
  isConfigured() {
    return true;
  }
  async chat(req: ChatRequest): Promise<ChatResponse> {
    this.calls.push(req);
    const r = this.script(req, this.calls.length - 1);
    const p = typeof r === 'string' ? { content: r } : r;
    return { id: `c${this.calls.length}`, model: req.model, content: '', toolCalls: [], finishReason: 'stop', usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 }, provider: this.id, ...p };
  }
  async listModels(): Promise<ModelInfo[]> {
    return [];
  }
}
