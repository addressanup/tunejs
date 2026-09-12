import { mulberry32 } from './mixing.js';

interface TimelineEvent { t: number; v: number; ramp: boolean }

/** Deterministic a-rate automation: set/linear-ramp/cancel, evaluated per sample. */
export class Timeline {
  #events: TimelineEvent[] = [];
  #insert(t: number, v: number, ramp: boolean): void {
    const event = { t, v, ramp };
    let i = this.#events.length;
    while (i > 0 && this.#events[i - 1]!.t > t) i--;
    this.#events.splice(i, 0, event);
  }
  set(value: number, time: number): void { this.#insert(time, value, false); }
  ramp(value: number, time: number): void { this.#insert(time, value, true); }
  cancel(time: number): void { this.#events = this.#events.filter(event => event.t < time); }
  valueAt(t: number): number {
    let v = 0; let tPrev = 0;
    for (const event of this.#events) {
      if (event.t <= t) { v = event.v; tPrev = event.t; continue; }
      if (event.ramp && event.t > tPrev) return v + (event.v - v) * (t - tPrev) / (event.t - tPrev);
      return v;
    }
    return v;
  }
}

/** In-place iterative radix-2 FFT; `inverse` conjugates. Lengths must be powers of two. */
export function fft(real: Float64Array, imag: Float64Array, inverse = false): void {
  const n = real.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { [real[i], real[j]] = [real[j]!, real[i]!]; [imag[i], imag[j]] = [imag[j]!, imag[i]!]; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const angle = 2 * Math.PI / len * (inverse ? 1 : -1);
    const wr = Math.cos(angle); const wi = Math.sin(angle);
    for (let i = 0; i < n; i += len) {
      let curR = 1; let curI = 0;
      for (let k = 0; k < len / 2; k++) {
        const aR = real[i + k]!; const aI = imag[i + k]!;
        const bR = real[i + k + len / 2]! * curR - imag[i + k + len / 2]! * curI;
        const bI = real[i + k + len / 2]! * curI + imag[i + k + len / 2]! * curR;
        real[i + k] = aR + bR; imag[i + k] = aI + bI;
        real[i + k + len / 2] = aR - bR; imag[i + k + len / 2] = aI - bI;
        const nextR = curR * wr - curI * wi; curI = curR * wi + curI * wr; curR = nextR;
      }
    }
  }
  if (inverse) { for (let i = 0; i < n; i++) { real[i]! /= n; imag[i]! /= n; } }
}

/** Single-partition FFT convolution of `signal` with `kernel`, output length signal.length + kernel.length - 1. */
export function convolve(signal: ArrayLike<number>, kernel: ArrayLike<number>): Float64Array {
  const outLength = signal.length + kernel.length - 1;
  let n = 1;
  while (n < outLength) n <<= 1;
  const aR = new Float64Array(n); const aI = new Float64Array(n);
  const bR = new Float64Array(n); const bI = new Float64Array(n);
  for (let i = 0; i < signal.length; i++) aR[i] = signal[i]!;
  for (let i = 0; i < kernel.length; i++) bR[i] = kernel[i]!;
  fft(aR, aI); fft(bR, bI);
  for (let i = 0; i < n; i++) {
    const r = aR[i]! * bR[i]! - aI[i]! * bI[i]!;
    aI[i] = aR[i]! * bI[i]! + aI[i]! * bR[i]!;
    aR[i] = r;
  }
  fft(aR, aI, true);
  return aR.subarray(0, outLength);
}

/** Streaming overlap-add convolver: feed 128-frame blocks, receive wet output blocks. */
export class BlockConvolver {
  readonly #kernel: Float64Array;
  readonly #tail: Float64Array;
  constructor(kernel: ArrayLike<number>) {
    this.#kernel = Float64Array.from(kernel as ArrayLike<number>);
    this.#tail = new Float64Array(this.#kernel.length - 1);
  }
  process(input: Float64Array, output: Float64Array): void {
    const wet = convolve(input, this.#kernel);
    for (let i = 0; i < input.length; i++) output[i] = wet[i]! + this.#tail[i]!;
    // Shift the accumulator one block and add this block's overflow — contributions from several
    // previous blocks overlap the same output region, so they must sum, not replace.
    for (let i = 0; i < this.#tail.length; i++) this.#tail[i] = (this.#tail[i + input.length] ?? 0) + (wet[input.length + i] ?? 0);
  }
}

export interface BiquadCoeffs { b0: number; b1: number; b2: number; a1: number; a2: number }

/** RBJ biquad, Web Audio formulation: Q in dB (q = 10^(Q/20)); normalized so a0 = 1. */
export function biquadCoeffs(type: 'lowpass' | 'highpass', frequency: number, sampleRate: number, qDb = 0): BiquadCoeffs {
  const w = 2 * Math.PI * frequency / sampleRate;
  const q = 10 ** (qDb / 20);
  const alpha = Math.sin(w) / (2 * q);
  const cw = Math.cos(w);
  let b0: number; let b1: number; let b2: number;
  if (type === 'lowpass') { b0 = (1 - cw) / 2; b1 = 1 - cw; b2 = b0; }
  else { b0 = (1 + cw) / 2; b1 = -(1 + cw); b2 = b0; }
  const a0 = 1 + alpha;
  return { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: (-2 * cw) / a0, a2: (1 - alpha) / a0 };
}

/** Direct form I biquad in doubles. */
export class Biquad {
  #x1 = 0; #x2 = 0; #y1 = 0; #y2 = 0;
  coeffs: BiquadCoeffs;
  constructor(coeffs: BiquadCoeffs) { this.coeffs = coeffs; }
  step(x: number): number {
    const c = this.coeffs;
    const y = c.b0 * x + c.b1 * this.#x1 + c.b2 * this.#x2 - c.a1 * this.#y1 - c.a2 * this.#y2;
    this.#x2 = this.#x1; this.#x1 = x; this.#y2 = this.#y1; this.#y1 = y;
    return y;
  }
}

/** Ideal (non-band-limited) oscillator value at phase φ ∈ [0, 1). */
export function oscillatorValue(wave: 'sine' | 'triangle' | 'square' | 'sawtooth', phase: number): number {
  switch (wave) {
    case 'sine': return Math.sin(2 * Math.PI * phase);
    case 'square': return phase < 0.5 ? 1 : -1;
    case 'sawtooth': return phase < 0.5 ? 2 * phase : 2 * phase - 2;
    case 'triangle': return phase < 0.25 ? 4 * phase : phase < 0.75 ? 2 - 4 * phase : 4 * phase - 4;
  }
}

/** The 2-second mulberry32 noise buffer every noise layer shares, generated at the render rate. */
export function noiseBufferData(sampleRate: number): Float64Array {
  const data = new Float64Array(2 * sampleRate);
  const random = mulberry32(0x4E4F4953);
  for (let i = 0; i < data.length; i++) data[i] = random() * 2 - 1;
  return data;
}
