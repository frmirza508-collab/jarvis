import { describe, expect, it } from 'vitest';
import { LanguageRegistry } from '@jarvis/shared';
import { detectLanguage, VoiceLanguageManager, WhisperCompatibleSTT } from '../src/index.js';

describe('language detection', () => {
  it('detects English, Urdu (script and roman) and Mandarin', () => {
    expect(detectLanguage('Open my documents folder').code).toBe('en');
    expect(detectLanguage('میرے دستاویزات کا فولڈر کھولیں').code).toBe('ur');
    expect(detectLanguage('mujhe aaj ka weather batao kya hai').code).toBe('ur');
    expect(detectLanguage('打开我的文档文件夹').code).toBe('zh');
  });
  it('supports adding languages later', () => {
    const reg = new LanguageRegistry();
    const vm = new VoiceLanguageManager(reg);
    vm.addLanguage({ tag: 'hi-IN', code: 'hi', name: 'Hindi', nativeName: 'हिन्दी', direction: 'ltr', script: 'Deva', builtIn: false });
    expect(detectLanguage('मेरा फ़ोल्डर खोलो', reg).code).toBe('hi');
    expect(vm.enabled().map((l) => l.code)).toEqual(['en', 'ur', 'zh', 'hi']);
  });
});

describe('whisper-compatible STT', () => {
  it('posts multipart audio and normalises language', async () => {
    let form: FormData | undefined;
    const stt = new WhisperCompatibleSTT({
      baseUrl: 'https://api.example/v1',
      model: 'whisper-1',
      apiKey: () => 'k',
      requiresKey: true,
      fetchImpl: (async (_u: string, init: RequestInit) => {
        form = init.body as FormData;
        return new Response(JSON.stringify({ text: 'السلام علیکم', language: 'urdu' }), { status: 200 });
      }) as unknown as typeof fetch,
    });
    const t = await stt.transcribe(Buffer.from('RIFF'), { mimeType: 'audio/wav' });
    expect(t).toMatchObject({ text: 'السلام علیکم', language: 'ur' });
    expect(form!.get('model')).toBe('whisper-1');
  });
});
