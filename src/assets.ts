import { TuneError, finite } from './errors.js';

export interface DecodedWav { sampleRate: number; channels: Float32Array[]; frames: number }

// RIFF/WAVE decoder: chunks may appear in any order after 'WAVE'; chunk sizes pad to even.
// Supports fmt tag 1 (PCM 8/16/24/32-bit int), tag 3 (float32) and 0xFFFE extensible wrapping either.
export function decodeWav(bytes: ArrayBuffer | ArrayBufferView): DecodedWav {
  const view = bytes instanceof ArrayBuffer ? new DataView(bytes)
    : ArrayBuffer.isView(bytes) ? new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    : undefined;
  if (!view) throw new TuneError('INVALID_VALUE', 'decodeWav requires an ArrayBuffer or a view into one.', 'Pass WAV file bytes.');
  const fail = (message: string) => new TuneError('ASSET_FAILED', message, 'Provide an intact PCM WAV file.');
  if (view.byteLength < 12) throw fail('File is shorter than a RIFF/WAVE header.');
  const ascii = (offset: number, length: number) => {
    let text = '';
    for (let i = 0; i < length; i++) text += String.fromCharCode(view.getUint8(offset + i));
    return text;
  };
  if (ascii(0, 4) !== 'RIFF' || ascii(8, 4) !== 'WAVE') throw fail('Not a RIFF/WAVE file.');
  let tag: number | undefined, channels = 0, sampleRate = 0, bits = 0;
  let dataOffset = -1, dataSize = -1;
  let offset = 12;
  while (offset + 8 <= view.byteLength) {
    const id = ascii(offset, 4);
    const size = view.getUint32(offset + 4, true);
    const body = offset + 8;
    if (id === 'fmt ') {
      if (body + 16 > view.byteLength) throw fail('Truncated fmt chunk.');
      tag = view.getUint16(body, true);
      channels = view.getUint16(body + 2, true);
      sampleRate = view.getUint32(body + 4, true);
      bits = view.getUint16(body + 14, true);
      if (tag === 0xFFFE) {
        if (size < 40 || body + 40 > view.byteLength) throw fail('Truncated extensible fmt chunk.');
        tag = view.getUint16(body + 24, true);
      }
    } else if (id === 'data' && dataOffset < 0) {
      if (body + size > view.byteLength) throw fail('Declared data size exceeds the file.');
      dataOffset = body; dataSize = size;
    }
    offset = body + size + (size & 1);
  }
  if (tag === undefined) throw fail('No fmt chunk found.');
  if (tag !== 1 && tag !== 3) throw fail(`Unsupported WAV format tag ${tag}.`);
  if (!channels || !sampleRate) throw fail('WAV has zero channels or a zero sample rate.');
  if (![8, 16, 24, 32].includes(bits) || (tag === 3 && bits !== 32)) throw fail(`Unsupported WAV bit depth ${bits}.`);
  if (dataOffset < 0) throw fail('No data chunk found.');
  const block = channels * (bits / 8);
  const frames = Math.floor(dataSize / block);
  const out: Float32Array[] = Array.from({ length: channels }, () => new Float32Array(frames));
  for (let frame = 0; frame < frames; frame++) {
    for (let channel = 0; channel < channels; channel++) {
      const p = dataOffset + frame * block + channel * (bits / 8);
      let value: number;
      if (tag === 3) value = view.getFloat32(p, true);
      else if (bits === 8) value = (view.getUint8(p) - 128) / 128;
      else if (bits === 16) value = view.getInt16(p, true) / 32768;
      else if (bits === 24) {
        let v = view.getUint8(p) | (view.getUint8(p + 1) << 8) | (view.getUint8(p + 2) << 16);
        if (v & 0x800000) v -= 0x1000000;
        value = v / 8388608;
      } else value = view.getInt32(p, true) / 2147483648;
      out[channel]![frame] = value;
    }
  }
  return { sampleRate, channels: out, frames };
}

// RIFF/WAVE encoder: PCM tag 1, 16-bit little-endian, interleaved. Values are scaled by 32768 and
// clamped into range; `clippedSamples` counts samples whose absolute value exceeded 1.
export function encodeWav(channels: Float32Array[], sampleRate: number): { bytes: ArrayBuffer; clippedSamples: number } {
  finite(sampleRate, 1000, 384000, 'sample rate');
  if (!channels.length) throw new TuneError('INVALID_VALUE', 'encodeWav requires at least one channel.', 'Pass a nonempty channel list.');
  const frames = channels[0]!.length;
  for (const channel of channels) {
    if (channel.length !== frames) throw new TuneError('INVALID_VALUE', 'All channels must have equal lengths.', 'Encode channels of the same frame count.');
    for (let i = 0; i < frames; i++) {
      if (!Number.isFinite(channel[i])) throw new TuneError('INVALID_VALUE', 'Samples must be finite numbers.', 'Remove NaN or infinite values before encoding.');
    }
  }
  const channelCount = channels.length;
  const dataSize = frames * channelCount * 2;
  const bytes = new ArrayBuffer(44 + dataSize);
  const view = new DataView(bytes);
  const ascii = (offset: number, text: string) => { for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i)); };
  ascii(0, 'RIFF'); view.setUint32(4, 36 + dataSize, true); ascii(8, 'WAVE');
  ascii(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, channelCount, true);
  view.setUint32(24, sampleRate, true); view.setUint32(28, sampleRate * channelCount * 2, true);
  view.setUint16(32, channelCount * 2, true); view.setUint16(34, 16, true);
  ascii(36, 'data'); view.setUint32(40, dataSize, true);
  let clippedSamples = 0;
  let p = 44;
  for (let frame = 0; frame < frames; frame++) {
    for (let channel = 0; channel < channelCount; channel++) {
      const value = channels[channel]![frame]!;
      if (Math.abs(value) > 1) clippedSamples++;
      view.setInt16(p, Math.max(-32768, Math.min(32767, Math.round(value * 32768))), true);
      p += 2;
    }
  }
  return { bytes, clippedSamples };
}

const besselI0 = (x: number): number => {
  let sum = 1, term = 1;
  const x2 = (x / 2) * (x / 2);
  for (let k = 1; k <= 60; k++) {
    term = term * x2 / (k * k);
    sum += term;
    if (term < 1e-17 * sum) break;
  }
  return sum;
};
const gcd = (a: number, b: number): number => { while (b) { const t = b; b = a % b; a = t; } return a; };

// Kaiser-windowed sinc resampler, 64 taps (half=32), beta=12. Cutoff fc = 0.5·min(1, toRate/fromRate)
// cycles per source sample, so downsampling anti-aliases. For output n: x = n·fromRate/toRate,
// i0 = floor(x), taps i = i0-31..i0+32, t = x-i, w = sinc(t)·kaiser(t) with
// sinc = t===0 ? 2fc : sin(2π·fc·t)/(πt), kaiser = |t/32|>1 ? 0 : I0(β√(1-(t/32)²))/I0(β);
// out[n] = Σ s[clamp(i)]·w / Σw. When both rates are integers the fractional phase repeats every
// P = toRate/gcd(from,to) outputs, so P ≤ 4096 phases are tabulated once and shared by all channels.
export function resample(channels: readonly Float32Array[], fromRate: number, toRate: number): Float32Array[] {
  finite(fromRate, 1000, 384000, 'source sample rate');
  finite(toRate, 1000, 384000, 'target sample rate');
  if (!channels.length) throw new TuneError('INVALID_VALUE', 'resample requires at least one channel.', 'Pass a nonempty channel list.');
  const frames = channels[0]!.length;
  for (const channel of channels) {
    if (channel.length !== frames) throw new TuneError('INVALID_VALUE', 'All channels must have equal lengths.', 'Resample channels of the same frame count.');
  }
  if (fromRate === toRate) return channels.map(channel => channel.slice());
  const outLength = Math.round(frames * toRate / fromRate);
  const half = 32, beta = 12, fc = 0.5 * Math.min(1, toRate / fromRate);
  const norm = besselI0(beta);
  const weight = (t: number): number => {
    const u = t / half;
    if (Math.abs(u) > 1) return 0;
    const sinc = t === 0 ? 2 * fc : Math.sin(2 * Math.PI * fc * t) / (Math.PI * t);
    return sinc * besselI0(beta * Math.sqrt(1 - u * u)) / norm;
  };
  const intRates = Number.isInteger(fromRate) && Number.isInteger(toRate);
  const g = intRates ? gcd(fromRate, toRate) : 1;
  const phases = intRates ? toRate / g : 0;
  let table: Float64Array | undefined, tableSums: Float64Array | undefined;
  if (intRates && phases <= 4096) {
    table = new Float64Array(phases * 64); tableSums = new Float64Array(phases);
    for (let p = 0; p < phases; p++) {
      const frac = p / phases;
      let sum = 0;
      for (let j = 0; j < 64; j++) { const w = weight(frac + half - 1 - j); table[p * 64 + j] = w; sum += w; }
      tableSums[p] = sum;
    }
  }
  const clampIndex = (i: number) => Math.min(Math.max(i, 0), frames - 1);
  return channels.map(source => {
    const out = new Float32Array(outLength);
    for (let n = 0; n < outLength; n++) {
      let i0: number, frac: number, phase = -1;
      if (intRates) {
        const q = n * fromRate;
        i0 = Math.floor(q / toRate); phase = (q % toRate) / g; frac = phase / phases;
      } else {
        const x = n * fromRate / toRate; i0 = Math.floor(x); frac = x - i0;
      }
      let sum = 0, weightSum = 0;
      if (table && phase >= 0) {
        const base = phase * 64;
        for (let j = 0; j < 64; j++) sum += source[clampIndex(i0 - half + 1 + j)]! * table[base + j]!;
        weightSum = tableSums![phase]!;
      } else {
        for (let j = 0; j < 64; j++) {
          const w = weight(frac + half - 1 - j);
          weightSum += w;
          sum += source[clampIndex(i0 - half + 1 + j)]! * w;
        }
      }
      out[n] = sum / weightSum;
    }
    return out;
  });
}
