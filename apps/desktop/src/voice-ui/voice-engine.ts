/**
 * Voice pipeline (client side):
 *   microphone -> level/VAD -> WAV (16 kHz mono) -> core /voice/transcribe
 *   (STT + language detection) -> orchestrator -> reply -> text-to-speech
 * Barge-in: while JARVIS is speaking, sustained user speech stops playback
 * and starts a new capture.
 */
export type VoiceState = 'idle' | 'listening' | 'transcribing' | 'speaking';

export interface VoiceCallbacks {
  onState: (s: VoiceState) => void;
  onLevel: (level: number) => void;
  onUtterance: (wav: Blob) => void;
  onError: (message: string) => void;
}

const TARGET_RATE = 16_000;

export function encodeWav(samples: Float32Array, sampleRate: number): Blob {
  const buf = new ArrayBuffer(44 + samples.length * 2);
  const v = new DataView(buf);
  const w = (o: number, s: string) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  w(0, 'RIFF');
  v.setUint32(4, 36 + samples.length * 2, true);
  w(8, 'WAVE');
  w(12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  w(36, 'data');
  v.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]!));
    v.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return new Blob([buf], { type: 'audio/wav' });
}

export function downsample(input: Float32Array, from: number, to = TARGET_RATE): Float32Array {
  if (from === to) return input;
  const ratio = from / to;
  const out = new Float32Array(Math.floor(input.length / ratio));
  for (let i = 0; i < out.length; i++) {
    const start = Math.floor(i * ratio);
    const end = Math.min(input.length, Math.floor((i + 1) * ratio));
    let sum = 0;
    for (let j = start; j < end; j++) sum += input[j]!;
    out[i] = sum / Math.max(1, end - start);
  }
  return out;
}

export class VoiceEngine {
  private ctx?: AudioContext;
  private stream?: MediaStream;
  private analyser?: AnalyserNode;
  private processor?: ScriptProcessorNode;
  private chunks: Float32Array[] = [];
  private state: VoiceState = 'idle';
  private noiseFloor = 0.01;
  private speechMs = 0;
  private silenceMs = 0;
  private recordingMs = 0;
  private handsFree = false;
  private currentAudio?: HTMLAudioElement;
  readonly waveform = new Uint8Array(256);

  constructor(private readonly cb: VoiceCallbacks) {}

  get active(): boolean {
    return !!this.stream;
  }

  getState(): VoiceState {
    return this.state;
  }

  private set(s: VoiceState): void {
    this.state = s;
    this.cb.onState(s);
  }

  async start(handsFree: boolean): Promise<void> {
    this.handsFree = handsFree;
    if (this.stream) return;
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 } });
    } catch (e) {
      this.cb.onError(`Microphone unavailable: ${(e as Error).message}. Allow microphone access in Windows Settings > Privacy > Microphone.`);
      throw e;
    }
    this.ctx = new AudioContext();
    const src = this.ctx.createMediaStreamSource(this.stream);
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 512;
    src.connect(this.analyser);
    // ScriptProcessor keeps working under a strict CSP (no blob: worklet modules).
    this.processor = this.ctx.createScriptProcessor(4096, 1, 1);
    src.connect(this.processor);
    this.processor.connect(this.ctx.destination);
    this.processor.onaudioprocess = (ev) => this.onAudio(ev.inputBuffer.getChannelData(0), ev.inputBuffer.duration * 1000);
  }

  stop(): void {
    this.processor?.disconnect();
    this.stream?.getTracks().forEach((t) => t.stop());
    void this.ctx?.close();
    this.stream = undefined;
    this.ctx = undefined;
    this.chunks = [];
    this.stopSpeaking();
    this.set('idle');
  }

  setHandsFree(v: boolean): void {
    this.handsFree = v;
  }

  /** Push-to-talk: begin capturing immediately. */
  beginCapture(): void {
    this.stopSpeaking();
    this.chunks = [];
    this.recordingMs = 0;
    this.silenceMs = 0;
    this.set('listening');
  }

  /** Push-to-talk release: finish the utterance now. */
  endCapture(): void {
    if (this.state === 'listening') this.finish();
  }

  private onAudio(data: Float32Array, ms: number): void {
    let sum = 0;
    for (let i = 0; i < data.length; i++) sum += data[i]! * data[i]!;
    const rms = Math.sqrt(sum / data.length);
    this.analyser?.getByteTimeDomainData(this.waveform);
    this.cb.onLevel(Math.min(1, rms * 8));
    const threshold = Math.max(0.02, this.noiseFloor * 3);
    const speaking = rms > threshold;

    if (this.state === 'idle' || this.state === 'speaking') {
      if (!speaking) this.noiseFloor = this.noiseFloor * 0.95 + rms * 0.05;
      this.speechMs = speaking ? this.speechMs + ms : 0;
      const needed = this.state === 'speaking' ? 350 : 200;
      // Barge-in or hands-free wake on sustained speech.
      if (this.speechMs >= needed && (this.handsFree || this.state === 'speaking')) {
        this.beginCapture();
        this.chunks.push(new Float32Array(data));
      }
      return;
    }
    if (this.state === 'listening') {
      this.chunks.push(new Float32Array(data));
      this.recordingMs += ms;
      this.silenceMs = speaking ? 0 : this.silenceMs + ms;
      if ((this.silenceMs > 900 && this.recordingMs > 600) || this.recordingMs > 30_000) this.finish();
    }
  }

  private finish(): void {
    const total = this.chunks.reduce((n, c) => n + c.length, 0);
    const all = new Float32Array(total);
    let off = 0;
    for (const c of this.chunks) {
      all.set(c, off);
      off += c.length;
    }
    this.chunks = [];
    if (!this.ctx || total < (this.ctx.sampleRate * 0.4)) {
      this.set('idle');
      return;
    }
    this.set('transcribing');
    this.cb.onUtterance(encodeWav(downsample(all, this.ctx.sampleRate), TARGET_RATE));
  }

  markIdle(): void {
    if (this.state !== 'speaking') this.set('idle');
  }

  // ---------------------------------------------------------------- speech output
  static voiceFor(lang: string): SpeechSynthesisVoice | undefined {
    const voices = typeof speechSynthesis !== 'undefined' ? speechSynthesis.getVoices() : [];
    const code = lang.split('-')[0]!.toLowerCase();
    const matches = voices.filter((v) => v.lang.toLowerCase().startsWith(code));
    const preferred = { en: ['en-us', 'en-gb'], ur: ['ur-pk', 'ur-in'], zh: ['zh-cn', 'zh-tw', 'zh-hk'] }[code] ?? [];
    for (const p of preferred) {
      const v = matches.find((x) => x.lang.toLowerCase() === p && /natural|online|neural/i.test(x.name)) ?? matches.find((x) => x.lang.toLowerCase() === p);
      if (v) return v;
    }
    return matches[0];
  }

  /** Speak with Windows voices; falls back to the provided cloud synthesiser. */
  async speak(text: string, lang: string, cloud?: (text: string, lang: string) => Promise<Blob | null>): Promise<'local' | 'cloud' | 'none'> {
    this.stopSpeaking();
    const clean = text.replace(/[#*_`>|-]{1,}/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 1500);
    if (!clean) return 'none';
    const voice = VoiceEngine.voiceFor(lang);
    if (voice) {
      this.set('speaking');
      await new Promise<void>((resolve) => {
        const u = new SpeechSynthesisUtterance(clean);
        u.voice = voice;
        u.lang = voice.lang;
        u.rate = 1.02;
        u.onend = () => resolve();
        u.onerror = () => resolve();
        speechSynthesis.speak(u);
      });
      if (this.state === 'speaking') this.set('idle');
      return 'local';
    }
    const audio = cloud ? await cloud(clean, lang).catch(() => null) : null;
    if (!audio) return 'none';
    this.set('speaking');
    const url = URL.createObjectURL(audio);
    this.currentAudio = new Audio(url);
    await new Promise<void>((resolve) => {
      this.currentAudio!.onended = () => resolve();
      this.currentAudio!.onerror = () => resolve();
      void this.currentAudio!.play().catch(() => resolve());
    });
    URL.revokeObjectURL(url);
    if (this.state === 'speaking') this.set('idle');
    return 'cloud';
  }

  stopSpeaking(): void {
    if (typeof speechSynthesis !== 'undefined') speechSynthesis.cancel();
    this.currentAudio?.pause();
    this.currentAudio = undefined;
    if (this.state === 'speaking') this.set('idle');
  }
}
