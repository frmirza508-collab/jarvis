import { describe, expect, it } from 'vitest';
import { downsample, encodeWav } from '../../apps/desktop/src/voice-ui/wav.js';

describe('voice capture encoding', () => {
  it('encodes 16-bit PCM mono WAV with a valid header', async () => {
    const wav = encodeWav(new Float32Array([0, 0.5, -0.5, 1, -1]), 16000);
    const b = Buffer.from(await wav.arrayBuffer());
    expect(b.subarray(0, 4).toString()).toBe('RIFF');
    expect(b.subarray(8, 12).toString()).toBe('WAVE');
    expect(b.readUInt32LE(24)).toBe(16000);
    expect(b.readUInt16LE(34)).toBe(16);
    expect(b.readInt16LE(44 + 3 * 2)).toBe(32767);
    expect(b.readInt16LE(44 + 4 * 2)).toBe(-32768);
  });
  it('downsamples 48 kHz to 16 kHz', () => {
    expect(downsample(new Float32Array(48000), 48000).length).toBe(16000);
  });
});
