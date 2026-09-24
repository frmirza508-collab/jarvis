import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createJarvisCore } from '../../src/core.js';
import { createServer } from '../../src/server.js';
import { encodeWav } from '../../../../apps/desktop/src/voice-ui/wav.js';

const TOKEN = 'v'.repeat(48);
let base: string;
let app: Awaited<ReturnType<typeof createServer>>;
let core: ReturnType<typeof createJarvisCore>;
const seen: Array<{ url: string; model?: string; language?: string; size: number }> = [];

beforeAll(async () => {
  // Stand-in for a Whisper-compatible HTTP endpoint: returns Urdu text for "ur" hints, Chinese for "zh".
  const fetchImpl = (async (url: string, init: RequestInit) => {
    const form = init.body as FormData;
    const file = form.get('file') as Blob;
    const language = (form.get('language') as string | null) ?? undefined;
    seen.push({ url, model: form.get('model') as string, language, size: file.size });
    const text =
      language === 'zh' ? '打开我的文档' : language === 'ur' ? 'میرے دستاویزات کھولو' : 'open my documents';
    return new Response(
      JSON.stringify({
        text,
        language: language === 'zh' ? 'chinese' : language === 'ur' ? 'urdu' : 'english',
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );
  }) as unknown as typeof fetch;
  core = createJarvisCore({
    fetchImpl,
    settings: { stt: { baseUrl: 'https://stt.example/v1', model: 'whisper-1' } },
  });
  core.secrets.set('STT_API_KEY', 'stt-test-key-1234');
  app = await createServer({ core, token: TOKEN, version: 'test' });
  base = await app.listen({ host: '127.0.0.1', port: 0 });
});
afterAll(async () => {
  await app.close();
  await core.shutdown();
});

function wav(): Blob {
  const samples = new Float32Array(16000);
  for (let i = 0; i < samples.length; i++) samples[i] = Math.sin((i / 16000) * 2 * Math.PI * 440) * 0.3;
  return encodeWav(samples, 16000);
}

describe('voice pipeline API', () => {
  it.each([
    ['en', undefined, 'open my documents'],
    ['ur', 'ur', 'میرے دستاویزات کھولو'],
    ['zh', 'zh', '打开我的文档'],
  ])('transcribes %s audio and reports the language', async (expected, hint, text) => {
    const body = await wav().arrayBuffer();
    const res = await fetch(`${base}/voice/transcribe`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        'Content-Type': 'audio/wav',
        ...(hint ? { 'X-Language-Hint': hint } : {}),
      },
      body,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ text, language: expected, provider: 'whisper' });
    expect(seen.at(-1)).toMatchObject({
      url: 'https://stt.example/v1/audio/transcriptions',
      model: 'whisper-1',
    });
    expect(seen.at(-1)!.size).toBe(44 + 16000 * 2);
  });

  it('reports speech synthesis as not configured instead of faking audio', async () => {
    const res = await fetch(`${base}/voice/speak`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'hi', language: 'en' }),
    });
    expect(res.status).toBe(409);
  });

  it('rejects empty audio', async () => {
    const res = await fetch(`${base}/voice/transcribe`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'audio/wav' },
      body: new Uint8Array(10),
    });
    expect(res.status).toBe(400);
  });
});
