import { VoiceEngine } from './voice-engine';
import { core, sendRequest } from '../lib/actions';
import { getState, notify, setState } from '../lib/store';
import type { RequestResult } from '../lib/types';

let engine: VoiceEngine | undefined;
let awaitingRequest: string | undefined;

async function cloudTts(text: string, language: string): Promise<Blob | null> {
  try {
    return await core().request<Blob>('POST', '/voice/speak', { text, language });
  } catch {
    return null;
  }
}

export function voiceEngine(): VoiceEngine {
  if (engine) return engine;
  engine = new VoiceEngine({
    onState: (s) => setState((st) => ({ voice: { ...st.voice, state: s === 'idle' && awaitingRequest ? 'thinking' : s } })),
    onLevel: (level) => {
      const v = getState().voice;
      if (Math.abs(v.level - level) > 0.02) setState({ voice: { ...v, level } });
    },
    onError: (m) => notify('error', m),
    onUtterance: async (wav) => {
      const hint = getState().prefs.voiceLanguage;
      try {
        const t = await core().request<{ text: string; language: string }>('POST', '/voice/transcribe', undefined, {
          data: wav,
          contentType: 'audio/wav',
          headers: hint !== 'auto' ? { 'X-Language-Hint': hint } : {},
        });
        if (!t.text.trim()) {
          engine!.markIdle();
          return;
        }
        setState((s) => ({ voice: { ...s.voice, state: 'thinking', lastLanguage: t.language } }));
        awaitingRequest = await sendRequest(t.text, t.language);
        if (!awaitingRequest) engine!.markIdle();
      } catch (e) {
        notify('error', (e as Error).message);
        engine!.markIdle();
      }
    },
  });
  window.addEventListener('jarvis-reply', (ev) => {
    const r = (ev as CustomEvent<RequestResult>).detail;
    if (r.requestId !== awaitingRequest) return;
    awaitingRequest = undefined;
    const prefs = getState().prefs;
    if (!prefs.speakReplies) {
      engine!.markIdle();
      return;
    }
    void engine!.speak(r.reply, r.language, cloudTts).then((how) => {
      if (how === 'none') {
        notify('warning', `No ${r.language === 'ur' ? 'Urdu' : r.language === 'zh' ? 'Chinese' : r.language} voice is installed. Add one in Windows Settings > Time & language > Speech, or configure cloud TTS.`);
        engine!.markIdle();
      }
    });
  });
  return engine;
}

export async function toggleMicrophone(): Promise<void> {
  const e = voiceEngine();
  if (e.active) {
    e.stop();
    return;
  }
  await e.start(getState().prefs.handsFree);
  if (!getState().prefs.handsFree) e.beginCapture();
}

export function pushToTalk(down: boolean): void {
  const e = voiceEngine();
  if (!e.active) return;
  if (down) e.beginCapture();
  else e.endCapture();
}

/** Speak any text (used for typed requests when "speak replies" is on). */
export function speakText(text: string, lang: string): void {
  void voiceEngine().speak(text, lang, cloudTts);
}
