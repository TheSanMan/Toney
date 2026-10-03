/** Inspect RIFF chunks instead of assuming every PCM WAV has a 44-byte header. */
export function inspectPcmWav(bytes: Uint8Array): { sampleRate: number; channels: number; frames: number; peak: number } {
  const invalid = (): never => { throw new Error('Native audio must be a complete mono/stereo 16-bit PCM WAV.'); };
  if (bytes.length < 44 || bytes.length > 32 * 1024 * 1024) return invalid();
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (offset: number) => String.fromCharCode(...bytes.subarray(offset, offset + 4));
  if (tag(0) !== 'RIFF' || tag(8) !== 'WAVE' || view.getUint32(4, true) + 8 !== bytes.length) return invalid();
  let channels = 0; let sampleRate = 0; let blockAlign = 0; let dataOffset = 0; let dataLength = 0;
  let formatSeen = false; let dataSeen = false; let offset = 12;
  while (offset < bytes.length) {
    if (offset + 8 > bytes.length) return invalid();
    const size = view.getUint32(offset + 4, true);
    const start = offset + 8;
    if (start + size + size % 2 > bytes.length) return invalid();
    if (tag(offset) === 'fmt ') {
      if (formatSeen || size < 16 || view.getUint16(start, true) !== 1 || view.getUint16(start + 14, true) !== 16) return invalid();
      formatSeen = true;
      channels = view.getUint16(start + 2, true);
      sampleRate = view.getUint32(start + 4, true);
      blockAlign = view.getUint16(start + 12, true);
      if (![1, 2].includes(channels) || sampleRate < 8000 || sampleRate > 96000 || blockAlign !== channels * 2
        || view.getUint32(start + 8, true) !== sampleRate * blockAlign) return invalid();
    }
    if (tag(offset) === 'data') {
      if (dataSeen) return invalid();
      dataSeen = true; dataOffset = start; dataLength = size;
    }
    offset = start + size + size % 2;
  }
  if (!formatSeen || !dataSeen || dataLength === 0 || dataLength % blockAlign !== 0) return invalid();
  let peak = 0;
  for (let at = dataOffset; at < dataOffset + dataLength; at += 2) {
    const value = view.getInt16(at, true);
    peak = Math.max(peak, Math.abs(value / (value < 0 ? 32768 : 32767)));
  }
  return { sampleRate, channels, frames: dataLength / blockAlign, peak };
}
