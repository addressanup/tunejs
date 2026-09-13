/** Deterministic mulberry32 PRNG — shared by noise layers, reverb IRs, and fixtures. */
export function mulberry32(seed: number) {
  let state = seed >>> 0;
  return () => { state = (state + 0x6D2B79F5) >>> 0; let t = state; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

/** Render quantum — the worklet block size and the offline renderer's block size. */
export const BLOCK = 128;

/** Integer delay length shared by live Delay nodes and the offline renderer. */
export function delayFramesFor(timeSeconds: number, sampleRate: number): number {
  return Math.max(1, Math.round(timeSeconds * sampleRate));
}

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

/**
 * Feedforward echo, float64, identical math in the worklet and the offline renderer:
 * wet = Σ_{k=1..taps} feedback^k · x[n − k·delayFrames]; dst = src + mix·wet.
 * `inputs`/`outputs` are channel buffers; mono input feeds every output channel.
 */
export class DelayEffect {
  readonly #rings: Float64Array[];
  readonly #taps: number;
  readonly #d: number;
  readonly #feedback: number;
  readonly #gains: number[];
  #write = 0;
  constructor(channels: number, delayFrames: number, taps: number, feedback: number) {
    this.#d = delayFrames; this.#taps = taps; this.#feedback = feedback;
    this.#gains = Array.from({ length: taps }, (_, k) => feedback ** (k + 1));
    this.#rings = Array.from({ length: channels }, () => new Float64Array(delayFrames * taps + BLOCK));
  }
  process(inputs: Float64Array[], outputs: Float64Array[], mix: Timeline, t0: number, sampleRate: number, frames = BLOCK): void {
    const size = this.#d * this.#taps + BLOCK;
    for (let c = 0; c < outputs.length; c++) {
      const src = inputs[Math.min(c, inputs.length - 1)]!;
      const dst = outputs[c]!; const ring = this.#rings[Math.min(c, this.#rings.length - 1)]!;
      let write = this.#write % size;
      for (let i = 0; i < frames; i++) {
        ring[write] = src[i]!;
        let wet = 0;
        for (let k = 1; k <= this.#taps; k++) wet += ring[(write - k * this.#d + size * 2) % size]! * this.#gains[k - 1]!;
        dst[i] = src[i]! + wet * mix.valueAt(t0 + i / sampleRate);
        write = (write + 1) % size;
      }
    }
    this.#write = (this.#write + frames) % size;
  }
}

/**
 * Zero-added-latency two-level uniform partitioned FFT convolution, float64.
 * HEAD: 128-sample partitions (FFT 256) over kernel[0, 2048) — up to 16 partitions, one
 * frequency-domain delay line of input spectra, complex MAC per block, one IFFT + overlap-add.
 * TAIL (kernel longer than 2048): 1024-sample partitions (FFT 2048) over kernel[2048, ∞). A
 * completed 1024-frame input block B_k is first needed for the output block starting at
 * 2048 + k·1024 — one full tail-block of slack — so its MACs are spread evenly over the next
 * eight 128-frame sub-blocks and the IFFT runs at the boundary.
 * process() writes the wet signal only.
 */
export class PartitionedConvolver {
  static readonly #HEAD_PARTITIONS = 16;
  static readonly #TAIL_PARTITION = 1024;
  readonly #headH: { re: Float64Array; im: Float64Array }[] = [];
  readonly #tailH: { re: Float64Array; im: Float64Array }[] = [];
  readonly #headX: { re: Float64Array; im: Float64Array }[] = [];
  readonly #tailX: { re: Float64Array; im: Float64Array }[] = [];
  readonly #headAccRe = new Float64Array(256);
  readonly #headAccIm = new Float64Array(256);
  readonly #headOla = new Float64Array(BLOCK);
  readonly #tailAccRe = new Float64Array(2048);
  readonly #tailAccIm = new Float64Array(2048);
  readonly #tailIn = new Float64Array(PartitionedConvolver.#TAIL_PARTITION);
  readonly #tailOla = new Float64Array(PartitionedConvolver.#TAIL_PARTITION);
  readonly #tailOut = new Float64Array(PartitionedConvolver.#TAIL_PARTITION);
  #blockIndex = 0;
  constructor(kernel: ArrayLike<number>) {
    const heads = Math.min(PartitionedConvolver.#HEAD_PARTITIONS, Math.ceil(kernel.length / BLOCK));
    for (let j = 0; j < heads; j++) {
      const re = new Float64Array(256); const im = new Float64Array(256);
      for (let i = 0; i < BLOCK; i++) re[i] = j * BLOCK + i < kernel.length ? kernel[j * BLOCK + i]! : 0;
      fft(re, im); this.#headH.push({ re, im });
    }
    const tailLength = kernel.length - PartitionedConvolver.#HEAD_PARTITIONS * BLOCK;
    const tails = Math.max(0, Math.ceil(tailLength / PartitionedConvolver.#TAIL_PARTITION));
    for (let j = 0; j < tails; j++) {
      const re = new Float64Array(2048); const im = new Float64Array(2048);
      const offset = PartitionedConvolver.#HEAD_PARTITIONS * BLOCK + j * PartitionedConvolver.#TAIL_PARTITION;
      for (let i = 0; i < PartitionedConvolver.#TAIL_PARTITION; i++) re[i] = offset + i < kernel.length ? kernel[offset + i]! : 0;
      fft(re, im); this.#tailH.push({ re, im });
    }
  }
  /** `input`/`output` are one 128-frame block each; output gains the wet signal. */
  process(input: Float64Array, output: Float64Array): void {
    const block = this.#blockIndex++;
    // Head partitions: spectrum of the current block, then Σ_j X_{b−j}·H_j.
    const re = this.#headAccRe; const im = this.#headAccIm;
    re.fill(0); re.set(input); im.fill(0);
    fft(re, im);
    this.#headX.unshift({ re: re.slice(), im: im.slice() });
    if (this.#headX.length > this.#headH.length) this.#headX.pop();
    const outRe = re.fill(0); const outIm = im.fill(0);
    for (let j = 0; j < this.#headX.length; j++) {
      const x = this.#headX[j]!; const h = this.#headH[j]!;
      for (let i = 0; i < 256; i++) {
        outRe[i] = outRe[i]! + x.re[i]! * h.re[i]! - x.im[i]! * h.im[i]!;
        outIm[i] = outIm[i]! + x.re[i]! * h.im[i]! + x.im[i]! * h.re[i]!;
      }
    }
    fft(outRe, outIm, true);
    for (let i = 0; i < BLOCK; i++) { output[i] = outRe[i]! + this.#headOla[i]!; this.#headOla[i] = outRe[BLOCK + i]!; }
    if (!this.#tailH.length) return;
    const sub = block % 8;
    // tailOut holds the wet tail for the current 1024-frame output block (computed at the
    // previous tail boundary); emit this sub-block's slice.
    const off = sub * BLOCK;
    for (let i = 0; i < BLOCK; i++) output[i] = output[i]! + this.#tailOut[off + i]!;
    this.#tailIn.set(input, off);
    // Spread the next output block's partition MACs over these eight sub-blocks: output block
    // m = floor(block/8) + 1 needs X_{m−2−j}·H_j, and #tailX[j] is exactly X_{m−2−j} here
    // (the newest entry X_{m−2} was pushed at the end of input block m−2).
    const per = Math.ceil(this.#tailH.length / 8);
    for (let j = sub * per; j < Math.min((sub + 1) * per, this.#tailH.length, this.#tailX.length); j++) {
      const x = this.#tailX[j]!; const h = this.#tailH[j]!;
      for (let i = 0; i < 2048; i++) {
        this.#tailAccRe[i] = this.#tailAccRe[i]! + x.re[i]! * h.re[i]! - x.im[i]! * h.im[i]!;
        this.#tailAccIm[i] = this.#tailAccIm[i]! + x.re[i]! * h.im[i]! + x.im[i]! * h.re[i]!;
      }
    }
    if (sub === 7) {
      // The 1024-frame input block completes: FFT it into the tail FDL after this output
      // block's MACs consumed the list.
      const xre = new Float64Array(2048); const xim = new Float64Array(2048);
      xre.set(this.#tailIn); fft(xre, xim);
      this.#tailX.unshift({ re: xre, im: xim });
      if (this.#tailX.length > this.#tailH.length + 2) this.#tailX.pop();
      // IFFT the accumulated spectrum → next output block, overlap-added with the pending
      // second half of the previous tail transform.
      fft(this.#tailAccRe, this.#tailAccIm, true);
      for (let i = 0; i < PartitionedConvolver.#TAIL_PARTITION; i++) {
        this.#tailOut[i] = this.#tailAccRe[i]! + this.#tailOla[i]!;
        this.#tailOla[i] = this.#tailAccRe[PartitionedConvolver.#TAIL_PARTITION + i]!;
      }
      this.#tailAccRe.fill(0); this.#tailAccIm.fill(0);
    }
  }
}

/**
 * Stereo convolver effect: one PartitionedConvolver per output channel (mono input feeds both
 * ears, mono response feeds both channels). dst = src + mix·wet; outputs are always 2 channels.
 * A partial final block (frames < BLOCK) is only valid as the last block — it is zero-padded.
 */
export class ConvolverEffect {
  readonly #convolvers: PartitionedConvolver[];
  readonly #wet: [Float64Array, Float64Array];
  constructor(response: ArrayLike<number>[]) {
    this.#convolvers = [new PartitionedConvolver(response[0]!), new PartitionedConvolver(response[Math.min(1, response.length - 1)]!)];
    this.#wet = [new Float64Array(BLOCK), new Float64Array(BLOCK)];
  }
  process(inputs: Float64Array[], outputs: Float64Array[], mix: Timeline, t0: number, sampleRate: number, frames = BLOCK): void {
    for (let c = 0; c < 2; c++) {
      const src = inputs[Math.min(c, inputs.length - 1)]!;
      const wet = this.#wet[c]!;
      if (frames === BLOCK) this.#convolvers[c]!.process(src, wet);
      else {
        const padded = new Float64Array(BLOCK); padded.set(src.subarray(0, frames));
        wet.fill(0); this.#convolvers[c]!.process(padded, wet);
      }
      const dst = outputs[c]!;
      for (let i = 0; i < frames; i++) dst[i] = src[i]! + wet[i]! * mix.valueAt(t0 + i / sampleRate);
    }
  }
}
