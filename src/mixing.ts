import type { HostContext, HostConvolver, HostDelay, HostGain, HostNode, HostPanner } from './backend.js';
import type { Engine } from './engine.js';
import { TuneError, finite } from './errors.js';
import { GraphNode, Param } from './graph.js';
import type { Seconds } from './graph.js';

const unity = (node: { gain: { setValueAtTime(v: number, t: number): unknown } }, at: number) => node.gain.setValueAtTime(1, at);

export class Bus extends GraphNode {
  readonly gainDb: Param;
  /** @internal */ constructor(engine: Engine, gainDb: number) {
    super(engine, 'bus');
    this.gainDb = new Param(this, finite(gainDb, -60, 12, 'bus gain dB'), 'gain dB', -60, 12, { toHost: db => 10 ** (db / 20), fromHost: gain => 20 * Math.log10(gain) });
  }
  /** @internal */ override prepare(context: HostContext): void {
    let host: HostGain | undefined;
    try {
      const gain = context.createGain(); host = gain;
      this.gainDb.bind(gain.gain);
      this.host = host;
    } catch (cause) {
      try { host?.disconnect(); }
      catch (cleanup) { throw new AggregateError([cause, cleanup], 'Host graph preparation and cleanup failed.'); }
      throw cause;
    }
  }
}

export class Pan extends GraphNode {
  readonly pan: Param;
  /** @internal */ constructor(engine: Engine, pan: number) {
    super(engine, 'pan');
    this.pan = new Param(this, finite(pan, -1, 1, 'pan'), 'pan', -1, 1);
  }
  /** @internal */ override prepare(context: HostContext): void {
    let host: HostPanner | undefined;
    try {
      const panner = context.createStereoPanner(); host = panner;
      this.pan.bind(panner.pan);
      this.host = host;
    } catch (cause) {
      try { host?.disconnect(); }
      catch (cleanup) { throw new AggregateError([cause, cleanup], 'Host graph preparation and cleanup failed.'); }
      throw cause;
    }
  }
}

// Finite feedforward echo: input → d1 → d2 … → d_taps delays (each `time` seconds), each delay
// tapping through a gain of feedback^k into the wet mix; the dry path passes at unity. No feedback
// loop — React Native Audio API may silently drop a graph edge that would form a cycle.
export class Delay extends GraphNode {
  readonly timeSeconds: number;
  readonly feedback: number;
  readonly taps: number;
  readonly mix: Param;
  #input?: HostGain;
  #internals: HostNode[] = [];
  /** @internal */ constructor(engine: Engine, options: { time?: Seconds; feedback?: number; mix?: number; taps?: number }) {
    super(engine, 'delay');
    this.timeSeconds = finite(options.time?.seconds ?? 0.25, 0.001, 5, 'delay time seconds');
    this.feedback = finite(options.feedback ?? 0.4, 0, 0.9, 'delay feedback');
    this.taps = options.taps ?? 8;
    if (!Number.isSafeInteger(this.taps) || this.taps < 1 || this.taps > 16) {
      throw new TuneError('INVALID_VALUE', 'Delay taps must be an integer in [1, 16].', 'Choose 1–16 taps.');
    }
    this.mix = new Param(this, finite(options.mix ?? 0.3, 0, 1, 'wet mix'), 'wet mix', 0, 1);
  }
  /** @internal */ override get input(): HostNode | undefined { return this.#input; }
  /** @internal */ override prepare(context: HostContext): void {
    const created: HostNode[] = [];
    const now = this.engine.currentTime;
    try {
      const inputGain = context.createGain(); created.push(inputGain); unity(inputGain, now);
      const outGain = context.createGain(); created.push(outGain); unity(outGain, now);
      inputGain.connect(outGain);
      const wet = context.createGain(); created.push(wet);
      this.mix.bind(wet.gain);
      wet.connect(outGain);
      let previous: HostNode = inputGain;
      for (let k = 1; k <= this.taps; k++) {
        const delay = context.createDelay(this.timeSeconds); created.push(delay);
        delay.delayTime.setValueAtTime(this.timeSeconds, now);
        previous.connect(delay);
        const tap = context.createGain(); created.push(tap);
        tap.gain.setValueAtTime(this.feedback ** k, now);
        delay.connect(tap); tap.connect(wet);
        previous = delay;
      }
      this.#input = inputGain; this.#internals = created.filter(node => node !== outGain); this.host = outGain;
    } catch (cause) {
      const errors: unknown[] = [cause];
      for (const node of created) try { node.disconnect(); } catch (error) { errors.push(error); }
      if (errors.length === 1) throw cause;
      throw new AggregateError(errors, 'Host graph preparation and cleanup failed.');
    }
  }
  override dispose(): void {
    this.mix.bind();
    const errors: unknown[] = [];
    for (const node of this.#internals) try { node.disconnect(); } catch (error) { errors.push(error); }
    this.#internals = []; this.#input = undefined;
    try { super.dispose(); } catch (error) { errors.push(error); }
    if (errors.length) throw new TuneError('HOST_FAILURE', 'Host delay cleanup failed.', 'Dispose the engine to release remaining host resources.', { cause: new AggregateError(errors) });
  }
}

function mulberry32(seed: number) {
  let state = seed >>> 0;
  return () => { state = (state + 0x6D2B79F5) >>> 0; let t = state; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

// synthetic-convolution-v1: two channels of seeded mulberry32 noise decaying −60 dB over `decaySeconds`
// (exp(-3·ln10·i/frames)), energy-normalized per channel (Σx² = 1). Deterministic per (decay, sampleRate).
export function syntheticReverbResponse(decaySeconds: number, sampleRate: number): Float32Array[] {
  const frames = Math.ceil(decaySeconds * sampleRate);
  return [0x54554E45, 0x4A530001].map(seed => {
    const random = mulberry32(seed);
    const data = new Float32Array(frames);
    for (let i = 0; i < frames; i++) data[i] = (random() * 2 - 1) * Math.exp(-3 * Math.LN10 * i / frames);
    let energy = 0;
    for (const x of data) energy += x * x;
    const scale = 1 / Math.sqrt(energy);
    for (let i = 0; i < frames; i++) data[i]! *= scale;
    return data;
  });
}

export class Reverb extends GraphNode {
  readonly decaySeconds: number;
  readonly mix: Param;
  #input?: HostGain;
  #internals: HostNode[] = [];
  /** @internal */ constructor(engine: Engine, options: { decay?: Seconds; mix?: number }) {
    super(engine, 'reverb');
    this.decaySeconds = finite(options.decay?.seconds ?? 2, 0.1, 10, 'reverb decay seconds');
    this.mix = new Param(this, finite(options.mix ?? 0.25, 0, 1, 'wet mix'), 'wet mix', 0, 1);
  }
  /** @internal */ override get input(): HostNode | undefined { return this.#input; }
  /** @internal */ override prepare(context: HostContext): void {
    const created: HostNode[] = [];
    const now = this.engine.currentTime;
    try {
      const inputGain = context.createGain(); created.push(inputGain); unity(inputGain, now);
      const outGain = context.createGain(); created.push(outGain); unity(outGain, now);
      inputGain.connect(outGain);
      const wet = context.createGain(); created.push(wet);
      this.mix.bind(wet.gain);
      wet.connect(outGain);
      const convolver: HostConvolver = context.createConvolver(); created.push(convolver);
      convolver.normalize = false;
      const response = syntheticReverbResponse(this.decaySeconds, context.sampleRate);
      const buffer = context.createBuffer(response.length, response[0]!.length, context.sampleRate);
      for (let channel = 0; channel < response.length; channel++) buffer.copyToChannel(response[channel]!, channel);
      convolver.buffer = buffer;
      inputGain.connect(convolver); convolver.connect(wet);
      this.#input = inputGain; this.#internals = created.filter(node => node !== outGain); this.host = outGain;
    } catch (cause) {
      const errors: unknown[] = [cause];
      for (const node of created) try { node.disconnect(); } catch (error) { errors.push(error); }
      if (errors.length === 1) throw cause;
      throw new AggregateError(errors, 'Host graph preparation and cleanup failed.');
    }
  }
  override dispose(): void {
    this.mix.bind();
    const errors: unknown[] = [];
    for (const node of this.#internals) try { node.disconnect(); } catch (error) { errors.push(error); }
    this.#internals = []; this.#input = undefined;
    try { super.dispose(); } catch (error) { errors.push(error); }
    if (errors.length) throw new TuneError('HOST_FAILURE', 'Host reverb cleanup failed.', 'Dispose the engine to release remaining host resources.', { cause: new AggregateError(errors) });
  }
}
