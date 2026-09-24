import { JarvisError, LanguageRegistry, type LanguageDescriptor } from '@jarvis/shared';
import type { ModelRouter } from '@jarvis/model-router';

// ---------------------------------------------------------------------------
// Language detection
// ---------------------------------------------------------------------------

const SCRIPT_RANGES: Array<[LanguageDescriptor['script'], RegExp]> = [
  ['Arab', /[؀-ۿݐ-ݿﭐ-﷿ﹰ-﻿]/g],
  ['Hans', /[一-鿿㐀-䶿]/g],
  ['Deva', /[ऀ-ॿ]/g],
  ['Cyrl', /[Ѐ-ӿ]/g],
  ['Latn', /[A-Za-z]/g],
];

/** Common romanised-Urdu tokens so "Roman Urdu" input is routed to Urdu. */
const ROMAN_URDU = /\b(kya|kaise|hai|hain|mujhe|aap|karo|kardo|nahi|nahin|kyun|mera|meri|tum|acha|theek|shukriya|batao|chahiye|abhi)\b/gi;

export interface DetectedLanguage {
  code: string;
  confidence: number;
  romanized?: boolean;
}

/** Script-based language detection over registered languages. */
export function detectLanguage(text: string, registry = new LanguageRegistry()): DetectedLanguage {
  const counts = new Map<string, number>();
  let total = 0;
  for (const [script, re] of SCRIPT_RANGES) {
    const n = text.match(re)?.length ?? 0;
    counts.set(script, n);
    total += n;
  }
  if (total === 0) return { code: 'en', confidence: 0 };
  const [bestScript, bestCount] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]!;
  const lang = registry.list().find((l) => l.script === bestScript || (bestScript === 'Hans' && l.script === 'Hant'));
  if (bestScript === 'Latn') {
    const roman = text.match(ROMAN_URDU)?.length ?? 0;
    const words = text.split(/\s+/).filter(Boolean).length || 1;
    if (registry.get('ur') && roman / words >= 0.2) return { code: 'ur', confidence: Math.min(0.9, roman / words + 0.3), romanized: true };
  }
  return { code: lang?.code ?? 'en', confidence: bestCount / total };
}

// ---------------------------------------------------------------------------
// Speech-to-text providers
// ---------------------------------------------------------------------------

export interface Transcript {
  text: string;
  language: string;
  confidence?: number;
  provider: string;
}

export interface SpeechToTextProvider {
  readonly id: string;
  isConfigured(): boolean;
  transcribe(audio: Buffer, opts: { mimeType: string; languageHint?: string; signal?: AbortSignal }): Promise<Transcript>;
}

/** OpenAI-compatible /audio/transcriptions endpoint (OpenAI Whisper, Groq, local whisper servers). */
export class WhisperCompatibleSTT implements SpeechToTextProvider {
  readonly id: string;
  constructor(
    private readonly opts: { id?: string; baseUrl: string; model: string; apiKey?: () => string | undefined; requiresKey?: boolean; fetchImpl?: typeof fetch },
  ) {
    this.id = opts.id ?? 'whisper';
  }
  isConfigured(): boolean {
    return !this.opts.requiresKey || !!this.opts.apiKey?.();
  }
  async transcribe(audio: Buffer, opts: { mimeType: string; languageHint?: string; signal?: AbortSignal }): Promise<Transcript> {
    if (!this.isConfigured()) throw new JarvisError('NOT_CONFIGURED', `${this.id} speech-to-text key not configured`);
    const form = new FormData();
    const ext = opts.mimeType.includes('wav') ? 'wav' : opts.mimeType.includes('mp4') ? 'm4a' : opts.mimeType.includes('ogg') ? 'ogg' : 'webm';
    form.append('file', new Blob([new Uint8Array(audio)], { type: opts.mimeType }), `speech.${ext}`);
    form.append('model', this.opts.model);
    form.append('response_format', 'verbose_json');
    if (opts.languageHint) form.append('language', opts.languageHint);
    const key = this.opts.apiKey?.();
    const res = await (this.opts.fetchImpl ?? fetch)(`${this.opts.baseUrl}/audio/transcriptions`, {
      method: 'POST',
      headers: key ? { Authorization: `Bearer ${key}` } : {},
      body: form,
      signal: opts.signal ?? AbortSignal.timeout(60_000),
    });
    if (!res.ok) throw new JarvisError('PROVIDER_ERROR', `${this.id} transcription failed: ${res.status}`);
    const j = (await res.json()) as { text?: string; language?: string };
    const text = (j.text ?? '').trim();
    return { text, language: normaliseLanguage(j.language) ?? detectLanguage(text).code, provider: this.id };
  }
}

const LANGUAGE_NAMES: Record<string, string> = { english: 'en', urdu: 'ur', chinese: 'zh', mandarin: 'zh' };
export function normaliseLanguage(l?: string): string | undefined {
  if (!l) return undefined;
  const k = l.toLowerCase();
  return LANGUAGE_NAMES[k] ?? (k.length <= 3 ? k.split('-')[0] : undefined);
}

/**
 * Speech-to-text through OpenRouter using an audio-capable chat model
 * (audio sent as an `input_audio` content part). Requires WAV or MP3 audio.
 */
export class OpenRouterAudioSTT implements SpeechToTextProvider {
  readonly id = 'openrouter-audio';
  constructor(private readonly router: ModelRouter) {}
  isConfigured(): boolean {
    return this.router.isRoleAvailable('audio');
  }
  async transcribe(audio: Buffer, opts: { mimeType: string; languageHint?: string; signal?: AbortSignal }): Promise<Transcript> {
    const format = opts.mimeType.includes('wav') ? 'wav' : opts.mimeType.includes('mpeg') || opts.mimeType.includes('mp3') ? 'mp3' : null;
    if (!format) throw new JarvisError('INVALID_INPUT', 'OpenRouter audio input requires WAV or MP3');
    const res = await this.router.chat('audio', {
      signal: opts.signal,
      temperature: 0,
      responseFormat: 'json_object',
      messages: [
        {
          role: 'system',
          content:
            'You are a speech transcription engine. Transcribe the audio verbatim in its original language and script (Urdu in Urdu script unless spoken words are English, Mandarin in simplified Chinese characters). Respond only with JSON: {"text": string, "language": ISO-639-1 code}.',
        },
        {
          role: 'user',
          content: [
            { type: 'text', text: opts.languageHint ? `Expected language: ${opts.languageHint}` : 'Detect the language.' },
            { type: 'input_audio', input_audio: { data: audio.toString('base64'), format } },
          ],
        },
      ],
    });
    let parsed: { text?: string; language?: string } = {};
    try {
      parsed = JSON.parse(res.content.replace(/^```(?:json)?|```$/g, '').trim()) as typeof parsed;
    } catch {
      parsed = { text: res.content };
    }
    const text = (parsed.text ?? '').trim();
    return { text, language: normaliseLanguage(parsed.language) ?? detectLanguage(text).code, provider: this.id };
  }
}

// ---------------------------------------------------------------------------
// Text-to-speech providers (server side). The desktop also has a local
// Windows speech-synthesis provider that runs inside the UI.
// ---------------------------------------------------------------------------

export interface TextToSpeechProvider {
  readonly id: string;
  isConfigured(): boolean;
  synthesize(text: string, opts: { language: string; voice?: string; signal?: AbortSignal }): Promise<{ audio: Buffer; mimeType: string }>;
}

/** OpenAI-compatible /audio/speech endpoint. */
export class OpenAICompatibleTTS implements TextToSpeechProvider {
  readonly id: string;
  constructor(private readonly opts: { id?: string; baseUrl: string; model: string; defaultVoice: string; apiKey?: () => string | undefined; fetchImpl?: typeof fetch }) {
    this.id = opts.id ?? 'openai-tts';
  }
  isConfigured(): boolean {
    return !!this.opts.apiKey?.();
  }
  async synthesize(text: string, opts: { language: string; voice?: string; signal?: AbortSignal }) {
    const key = this.opts.apiKey?.();
    if (!key) throw new JarvisError('NOT_CONFIGURED', `${this.id} key not configured`);
    const res = await (this.opts.fetchImpl ?? fetch)(`${this.opts.baseUrl}/audio/speech`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({ model: this.opts.model, voice: opts.voice ?? this.opts.defaultVoice, input: text, response_format: 'mp3' }),
      signal: opts.signal ?? AbortSignal.timeout(60_000),
    });
    if (!res.ok) throw new JarvisError('PROVIDER_ERROR', `${this.id} synthesis failed: ${res.status}`);
    return { audio: Buffer.from(await res.arrayBuffer()), mimeType: 'audio/mpeg' };
  }
}

// ---------------------------------------------------------------------------
// Language/model management
// ---------------------------------------------------------------------------

export interface VoiceLanguageConfig {
  code: string;
  enabled: boolean;
  sttProvider?: string;
  ttsProvider?: string;
  ttsVoice?: string;
}

/**
 * Controlled language management: languages are enabled individually; no
 * bulk downloads. Adding a language = registering a descriptor + config.
 */
export class VoiceLanguageManager {
  private configs = new Map<string, VoiceLanguageConfig>();

  constructor(
    readonly registry: LanguageRegistry = new LanguageRegistry(),
    initial: VoiceLanguageConfig[] = [],
  ) {
    for (const l of registry.list()) this.configs.set(l.code, { code: l.code, enabled: l.builtIn });
    for (const c of initial) this.configs.set(c.code, { ...this.configs.get(c.code), ...c });
  }

  addLanguage(desc: LanguageDescriptor, cfg: Partial<VoiceLanguageConfig> = {}): void {
    this.registry.register(desc);
    this.configs.set(desc.code, { code: desc.code, enabled: true, ...cfg });
  }

  configure(code: string, patch: Partial<VoiceLanguageConfig>): VoiceLanguageConfig {
    if (!this.registry.get(code)) throw new JarvisError('NOT_FOUND', `Unknown language ${code}`);
    const next = { ...(this.configs.get(code) ?? { code, enabled: false }), ...patch, code };
    this.configs.set(code, next);
    return next;
  }

  enabled(): Array<LanguageDescriptor & VoiceLanguageConfig> {
    return this.registry
      .list()
      .map((l) => ({ ...l, ...(this.configs.get(l.code) ?? { code: l.code, enabled: false }) }))
      .filter((l) => l.enabled);
  }

  all(): Array<LanguageDescriptor & VoiceLanguageConfig> {
    return this.registry.list().map((l) => ({ ...l, ...(this.configs.get(l.code) ?? { code: l.code, enabled: false }) }));
  }
}

export class SpeechRouter {
  constructor(private readonly stt: SpeechToTextProvider[]) {}

  available(): SpeechToTextProvider[] {
    return this.stt.filter((p) => p.isConfigured());
  }

  async transcribe(audio: Buffer, opts: { mimeType: string; languageHint?: string; signal?: AbortSignal }): Promise<Transcript> {
    const ps = this.available().filter((p) => p.id !== 'openrouter-audio' || /wav|mpeg|mp3/.test(opts.mimeType));
    if (!ps.length)
      throw new JarvisError('NOT_CONFIGURED', 'No speech-to-text provider configured. Add an OpenRouter key (audio-capable model) or a Whisper-compatible STT key in Settings.');
    let last: unknown;
    for (const p of ps) {
      try {
        return await p.transcribe(audio, opts);
      } catch (e) {
        last = e;
      }
    }
    throw last instanceof Error ? last : new JarvisError('PROVIDER_ERROR', 'transcription failed');
  }
}
