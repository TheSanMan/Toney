import { describe, expect, it } from 'vitest';
import { bufferToWav } from '../apps/desktop/src/audio/preview';
import { inspectPcmWav } from '../core/native/wav';

async function fixture() {
  const channel = new Float32Array([0, -0.5, 0.25]);
  return new Uint8Array(await bufferToWav({ numberOfChannels: 1, length: 3, sampleRate: 44100,
    getChannelData: () => channel } as unknown as AudioBuffer).arrayBuffer());
}

describe('native WAV artifact inspection', () => {
  it('reads generated PCM and padded unknown chunks without assuming a fixed header', async () => {
    const original = await fixture();
    expect(inspectPcmWav(original)).toEqual({ channels: 1, sampleRate: 44100, frames: 3, peak: 0.5 });
    const bytes = new Uint8Array(original.length + 10);
    bytes.set(original.subarray(0, 12));
    bytes.set(new TextEncoder().encode('JUNK'), 12);
    const view = new DataView(bytes.buffer);
    view.setUint32(16, 1, true); bytes[20] = 0; bytes[21] = 0;
    bytes.set(original.subarray(12), 22);
    view.setUint32(4, bytes.length - 8, true);
    expect(inspectPcmWav(bytes)).toEqual(inspectPcmWav(original));
  });
  it('rejects truncation, inconsistent frames and unsupported encoded audio', async () => {
    const original = await fixture();
    expect(() => inspectPcmWav(original.subarray(0, original.length - 1))).toThrow('complete');
    for (const corrupt of [
      (view: DataView) => view.setUint16(20, 3, true),
      (view: DataView) => view.setUint16(22, 3, true),
      (view: DataView) => view.setUint16(32, 4, true),
      (view: DataView) => view.setUint32(40, 5, true),
    ]) {
      const bytes = original.slice(); corrupt(new DataView(bytes.buffer));
      expect(() => inspectPcmWav(bytes)).toThrow('complete');
    }
  });
});
