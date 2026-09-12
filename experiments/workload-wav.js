// Small float32 WAV writer for synthetic workload assets (mono sine, one second by default).
export function wavBytes(sampleRate, seconds, frequency, amplitude) {
  const frames = Math.round(sampleRate * seconds);
  const buffer = new ArrayBuffer(44 + frames * 4), view = new DataView(buffer), bytes = new Uint8Array(buffer);
  const ascii = (offset, text) => { for (let i = 0; i < text.length; i++) bytes[offset + i] = text.charCodeAt(i); };
  ascii(0, 'RIFF'); view.setUint32(4, 36 + frames * 4, true); ascii(8, 'WAVE');
  ascii(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 3, true); view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true); view.setUint32(28, sampleRate * 4, true); view.setUint16(32, 4, true); view.setUint16(34, 32, true);
  ascii(36, 'data'); view.setUint32(40, frames * 4, true);
  for (let i = 0; i < frames; i++) view.setFloat32(44 + i * 4, amplitude * Math.sin(2 * Math.PI * frequency * i / sampleRate), true);
  return buffer;
}
