export type Role = 'system' | 'user' | 'assistant' | 'tool';

export type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } }
  | { type: 'input_audio'; input_audio: { data: string; format: 'wav' | 'mp3' } };

export interface ToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export interface ChatMessage {
  role: Role;
  content: string | ContentPart[] | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  name?: string;
}

export interface ToolSchema {
  type: 'function';
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  tools?: ToolSchema[];
  temperature?: number;
  maxTokens?: number;
  responseFormat?: 'json_object' | 'text';
  signal?: AbortSignal;
}

export interface Usage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface ChatResponse {
  id: string;
  model: string;
  content: string;
  toolCalls: ToolCall[];
  finishReason: string | null;
  usage: Usage;
  provider: string;
}

export interface ModelInfo {
  id: string;
  name: string;
  contextLength?: number;
  pricing?: { prompt: string; completion: string };
  inputModalities?: string[];
}

export interface ModelProvider {
  readonly id: string;
  isConfigured(): boolean;
  chat(req: ChatRequest): Promise<ChatResponse>;
  stream?(req: ChatRequest, onDelta: (text: string) => void): Promise<ChatResponse>;
  listModels(): Promise<ModelInfo[]>;
}

export class ProviderHttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'ProviderHttpError';
  }
}
