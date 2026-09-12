import type { HostContext, HostFilter, HostGain, HostNode, HostOscillator } from './backend.js';
import type { Engine } from './engine.js';
import { TuneError, finite } from './errors.js';
import { GraphNode, Param } from './graph.js';
import type { OwnedVoice, Seconds } from './graph.js';

export type Wave = 'sine' | 'triangle' | 'square' | 'sawtooth';
export interface Envelope { attack: number; decay: number; sustain: number; release: number }
export interface InstrumentLayer { wave: Wave; ratio?: number; detuneCents?: number; level?: number }
export interface InstrumentPreset { name: string; layers: readonly InstrumentLayer[]; envelope: Envelope; filter?: { type: 'lowpass' | 'highpass'; frequencyHz: number }; level: number; maxVoices?: number }
const STEAL_RELEASE_SECONDS = 0.02;
const WAVES: readonly string[] = ['sine', 'triangle', 'square', 'sawtooth'];
const SEMITONES: Record<string, number> = { c: 0, d: 2, e: 4, f: 5, g: 7, a: 9, b: 11 };

export function noteToFrequency(note: string): number {
  const match = /^([A-Ga-g])([#b]?)(-?\d)$/.exec(note);
  if (!match) throw new TuneError('INVALID_VALUE', `'${note}' is not a note name.`, 'Use a name like C4, F#3 or Bb5.');
  const letter = match[1]!.toLowerCase();
  const accidental = match[2]!;
  const octave = parseInt(match[3]!, 10);
  if (octave < -1 || octave > 9) throw new TuneError('INVALID_VALUE', `'${note}' is outside the supported octave range.`, 'Use octaves -1 through 9.');
  let semitone = SEMITONES[letter]!;
  if (accidental === '#') semitone += 1; else if (accidental === 'b') semitone -= 1;
  const midi = (octave + 1) * 12 + semitone;
  if (midi < 0 || midi > 127) throw new TuneError('INVALID_VALUE', `'${note}' maps outside MIDI 0-127.`, 'Choose a note between C-1 and G9.');
  return 440 * 2 ** ((midi - 69) / 12);
}

export class Instrument extends GraphNode {
  /** @internal */ input?: HostNode;
  readonly preset: InstrumentPreset;
  readonly level: Param;
  readonly filterHz: Param;
  readonly maxVoices: number;
  #envelope: Envelope;
  #live = new Set<SynthVoice>();
  /** @internal */ constructor(engine: Engine, preset: InstrumentPreset, options: { maxVoices?: number } = {}) {
    super(engine, 'source');
    if (typeof preset !== 'object' || preset === null || typeof preset.name !== 'string' || !preset.name) {
      throw new TuneError('INVALID_VALUE', 'A preset needs a nonempty name.', 'Provide a preset object with a name.');
    }
    const layers = preset.layers;
    if (!Array.isArray(layers) || layers.length < 1 || layers.length > 8) {
      throw new TuneError('INVALID_VALUE', 'A preset needs 1-8 layers.', 'Choose fewer layers.');
    }
    const frozenLayers = layers.map(layer => {
      if (!layer || !WAVES.includes(layer.wave)) throw new TuneError('INVALID_VALUE', 'Unknown layer wave.', 'Use sine, triangle, square, or sawtooth.');
      const ratio = finite(layer.ratio ?? 1, 0.01, 64, 'layer ratio');
      const detuneCents = finite(layer.detuneCents ?? 0, -4800, 4800, 'layer detune cents');
      const level = finite(layer.level ?? 1, 0, 1, 'layer level');
      return Object.freeze({ wave: layer.wave, ratio, detuneCents, level });
    });
    const envelope = preset.envelope;
    const attack = finite(envelope?.attack, 0, 10, 'envelope attack seconds');
    const decay = finite(envelope?.decay, 0, 10, 'envelope decay seconds');
    const sustain = finite(envelope?.sustain, 0, 1, 'envelope sustain level');
    const release = finite(envelope?.release, 0.001, 10, 'envelope release seconds');
    const filterType = preset.filter?.type ?? 'lowpass';
    if (filterType !== 'lowpass' && filterType !== 'highpass') throw new TuneError('INVALID_VALUE', 'Unknown preset filter type.', 'Use lowpass or highpass.');
    const filterFrequency = finite(preset.filter?.frequencyHz ?? 20000, 10, 20000, 'filter frequency Hz');
    const level = finite(preset.level, 0, 4, 'instrument level');
    const maxVoices = options.maxVoices ?? preset.maxVoices ?? 16;
    if (!Number.isInteger(maxVoices) || maxVoices < 1 || maxVoices > 64) {
      throw new TuneError('INVALID_VALUE', 'maxVoices must be an integer in [1, 64].', 'Choose a whole voice count.');
    }
    this.preset = Object.freeze({
      name: preset.name, layers: Object.freeze(frozenLayers),
      envelope: Object.freeze({ attack, decay, sustain, release }),
      filter: Object.freeze({ type: filterType, frequencyHz: filterFrequency }),
      level, maxVoices,
    });
    this.#envelope = { attack, decay, sustain, release };
    this.maxVoices = maxVoices;
    this.level = new Param(this, level, 'instrument level', 0, 4);
    this.filterHz = new Param(this, filterFrequency, 'filter frequency Hz', 10, 20000);
  }
  get envelope(): Envelope { return Object.freeze({ ...this.#envelope }); }
  setEnvelope(patch: Partial<Envelope>): this {
    this.assertAlive();
    const next = { ...this.#envelope };
    if (patch.attack !== undefined) next.attack = finite(patch.attack, 0, 10, 'envelope attack seconds');
    if (patch.decay !== undefined) next.decay = finite(patch.decay, 0, 10, 'envelope decay seconds');
    if (patch.sustain !== undefined) next.sustain = finite(patch.sustain, 0, 1, 'envelope sustain level');
    if (patch.release !== undefined) next.release = finite(patch.release, 0.001, 10, 'envelope release seconds');
    this.#envelope = next;
    return this;
  }
  get activeVoices(): number { return this.#live.size; }
  /** @internal */ register(voice: SynthVoice): void { this.#live.add(voice); }
  /** @internal */ unregister(voice: SynthVoice): void { this.#live.delete(voice); }
  /** @internal */ override prepare(context: HostContext): void {
    let filter: HostFilter | undefined; let levelGain: HostGain | undefined;
    try {
      filter = context.createBiquadFilter();
      filter.type = this.preset.filter!.type; filter.Q.setValueAtTime(0, this.engine.currentTime);
      this.filterHz.bind(filter.frequency);
      levelGain = context.createGain();
      this.level.bind(levelGain.gain);
      filter.connect(levelGain);
      this.input = filter; this.host = levelGain;
    } catch (cause) {
      const errors: unknown[] = [cause];
      this.filterHz.bind(); this.level.bind();
      try { filter?.disconnect(); } catch (error) { errors.push(error); }
      try { levelGain?.disconnect(); } catch (error) { errors.push(error); }
      if (errors.length === 1) throw cause;
      throw new AggregateError(errors, 'Host graph preparation and cleanup failed.');
    }
  }
  play(notes: string | { frequencyHz: number } | Array<string | { frequencyHz: number }>, options: { velocity?: number; duration?: Seconds } = {}): InstrumentVoice {
    this.assertAlive();
    const context = this.engine.runningContext();
    const velocity = finite(options.velocity ?? 0.8, 0, 1, 'velocity');
    const duration = options.duration && finite(options.duration.seconds, 0.001, 3600, 'duration seconds');
    const list = (Array.isArray(notes) ? notes : [notes]) as Array<string | { frequencyHz: number }>;
    if (!list.length) throw new TuneError('INVALID_VALUE', 'play requires at least one note.', 'Pass a note name or a frequency object.');
    if (list.length > this.maxVoices) throw new TuneError('INVALID_VALUE', 'The chord exceeds the voice limit.', 'Play fewer notes or raise maxVoices.');
    const frequencies = list.map(note => typeof note === 'string' ? noteToFrequency(note) : finite(note?.frequencyHz ?? NaN, 1, 20000, 'frequency Hz'));
    for (const frequency of frequencies) {
      for (const layer of this.preset.layers) {
        finite(frequency * (layer.ratio ?? 1) * 2 ** ((layer.detuneCents ?? 0) / 1200), 1, 20000, 'layer frequency Hz');
      }
    }
    const created: SynthVoice[] = [];
    try {
      for (const frequency of frequencies) {
        if (this.#live.size >= this.maxVoices) {
          // Bounded overshoot: when every live voice is already stealing, allocate anyway.
          const victim = [...this.#live].find(voice => !voice.stopping);
          if (victim) victim.release(STEAL_RELEASE_SECONDS);
        }
        const voice = new SynthVoice(this.engine, this, frequency, velocity, duration, { ...this.#envelope }, context);
        this.register(voice);
        created.push(voice);
      }
    } catch (cause) {
      const errors: unknown[] = [cause];
      for (const voice of created) try { voice.dispose(); } catch (error) { errors.push(error); }
      throw new TuneError('HOST_FAILURE', 'The host could not start the instrument voice.', 'Dispose the engine and reactivate output with a new engine.', { cause: errors.length === 1 ? cause : new AggregateError(errors) });
    }
    return new InstrumentVoice(created.slice(), Object.freeze(frequencies.slice()));
  }
  stopAll(): void {
    for (const voice of [...this.#live]) voice.release();
  }
  override dispose(): void {
    const errors: unknown[] = [];
    for (const voice of [...this.#live]) try { voice.dispose(); } catch (error) { errors.push(error); }
    try { super.dispose(); } catch (error) { errors.push(error); }
    this.level.bind();
    this.filterHz.bind();
    try { this.input?.disconnect(); this.input = undefined; } catch (error) { errors.push(error); }
    if (errors.length) throw new TuneError('HOST_FAILURE', 'Host instrument cleanup failed.', 'Dispose the engine to release remaining host resources.', { cause: new AggregateError(errors) });
  }
}

class SynthVoice implements OwnedVoice {
  #ended = false;
  #stopping = false;
  readonly #oscs: HostOscillator[] = [];
  readonly #layerGains: HostGain[] = [];
  #env?: HostGain;
  readonly #t0: number;
  readonly #peak: number;
  readonly #envelope: Envelope;
  readonly #releaseSeconds: number;
  #releaseStart?: number;
  #releaseStartValue?: number;
  #releaseEnd?: number;
  constructor(private engine: Engine, private instrument: Instrument, frequencyHz: number, velocity: number, duration: number | undefined, envelope: Envelope, private context: HostContext) {
    this.#envelope = envelope;
    this.#releaseSeconds = envelope.release;
    const t0 = context.currentTime;
    this.#t0 = t0;
    this.#peak = velocity;
    try {
      const env = context.createGain(); this.#env = env;
      const layers = instrument.preset.layers;
      for (let index = 0; index < layers.length; index++) {
        const layer = layers[index]!;
        const osc = context.createOscillator();
        osc.type = layer.wave;
        osc.frequency.setValueAtTime(frequencyHz * (layer.ratio ?? 1) * 2 ** ((layer.detuneCents ?? 0) / 1200), t0);
        const layerGain = context.createGain();
        layerGain.gain.setValueAtTime(layer.level ?? 1, t0);
        osc.connect(layerGain); layerGain.connect(env);
        this.#oscs.push(osc); this.#layerGains.push(layerGain);
      }
      env.connect(instrument.input!);
      const gain = env.gain;
      const { attack, decay, sustain, release } = envelope;
      const peak = this.#peak;
      gain.setValueAtTime(0, t0);
      if (duration === undefined) {
        if (attack > 0) gain.linearRampToValueAtTime(peak, t0 + attack); else gain.setValueAtTime(peak, t0);
        if (decay > 0) gain.linearRampToValueAtTime(peak * sustain, t0 + attack + decay); else gain.setValueAtTime(peak * sustain, t0 + attack);
      } else {
        const tRel = t0 + duration;
        if (duration <= attack) {
          gain.linearRampToValueAtTime(peak * duration / attack, tRel);
        } else if (duration <= attack + decay) {
          gain.linearRampToValueAtTime(peak, t0 + attack);
          gain.linearRampToValueAtTime(this.adsValue(tRel), tRel);
        } else {
          if (attack > 0) gain.linearRampToValueAtTime(peak, t0 + attack); else gain.setValueAtTime(peak, t0);
          if (decay > 0) gain.linearRampToValueAtTime(peak * sustain, t0 + attack + decay); else gain.setValueAtTime(peak * sustain, t0 + attack);
          gain.setValueAtTime(peak * sustain, tRel);
        }
        gain.linearRampToValueAtTime(0, tRel + release);
        this.#releaseStart = tRel; this.#releaseStartValue = this.adsValue(tRel); this.#releaseEnd = tRel + release;
      }
      const startAt = engine.hostTimeAt(engine.currentFrame);
      for (const osc of this.#oscs) osc.start(startAt);
      if (duration !== undefined) {
        const stopAt = engine.hostTimeAt(Math.round((t0 + duration + release) * context.sampleRate) + 1);
        for (const osc of this.#oscs) osc.stop(stopAt);
      }
      engine.adapter.setEnded(this.#oscs[0]!, () => this.finish());
    } catch (cause) {
      const errors: unknown[] = [cause];
      if (this.#oscs[0]) try { engine.adapter.setEnded(this.#oscs[0], null); } catch (error) { errors.push(error); }
      for (const osc of this.#oscs) try { osc.disconnect(); } catch (error) { errors.push(error); }
      for (const gain of this.#layerGains) try { gain.disconnect(); } catch (error) { errors.push(error); }
      try { this.#env?.disconnect(); } catch (error) { errors.push(error); }
      if (errors.length === 1) throw cause;
      throw new AggregateError(errors, 'Host voice preparation and cleanup failed.');
    }
    engine.voices.add(this);
  }
  get state(): 'playing' | 'stopping' | 'ended' { return this.#ended ? 'ended' : this.#stopping ? 'stopping' : 'playing'; }
  /** @internal */ get stopping(): boolean { return this.#stopping && !this.#ended; }
  private adsValue(t: number): number {
    const { attack, decay, sustain } = this.#envelope;
    const t0 = this.#t0;
    if (t <= t0) return 0;
    if (t <= t0 + attack) return attack > 0 ? this.#peak * (t - t0) / attack : this.#peak;
    if (t <= t0 + attack + decay) return decay > 0 ? this.#peak + (this.#peak * sustain - this.#peak) * (t - t0 - attack) / decay : this.#peak * sustain;
    return this.#peak * sustain;
  }
  private valueAt(t: number): number {
    if (this.#releaseStart !== undefined && t >= this.#releaseStart) {
      const span = this.#releaseEnd! - this.#releaseStart;
      return this.#releaseStartValue! * Math.max(0, 1 - (t - this.#releaseStart) / span);
    }
    return this.adsValue(t);
  }
  release(seconds?: number): void {
    if (this.#ended) return;
    const secs = seconds ?? this.#releaseSeconds;
    const now = this.context.currentTime;
    if (this.#releaseStart !== undefined && this.#releaseEnd! - now <= secs) return;
    const v = this.valueAt(now);
    const env = this.#env!;
    env.gain.cancelScheduledValues(now);
    env.gain.setValueAtTime(v, now);
    env.gain.linearRampToValueAtTime(0, now + secs);
    const stopAt = this.engine.hostTimeAt(Math.round((now + secs) * this.context.sampleRate) + 1);
    for (const osc of this.#oscs) osc.stop(stopAt);
    this.#stopping = true;
    this.#releaseStart = now; this.#releaseStartValue = v; this.#releaseEnd = now + secs;
  }
  private finish(): void {
    if (this.#ended) return;
    this.#ended = true;
    this.engine.voices.delete(this);
    this.instrument.unregister(this);
    const errors: unknown[] = [];
    try { this.engine.adapter.setEnded(this.#oscs[0]!, null); } catch (error) { errors.push(error); }
    for (const osc of this.#oscs) try { osc.disconnect(); } catch (error) { errors.push(error); }
    for (const gain of this.#layerGains) try { gain.disconnect(); } catch (error) { errors.push(error); }
    try { this.#env?.disconnect(); } catch (error) { errors.push(error); }
    if (errors.length) throw new TuneError('HOST_FAILURE', 'Host instrument voice cleanup failed.', 'Dispose the engine to release remaining host resources.', { cause: new AggregateError(errors) });
  }
  dispose(): void {
    if (this.#ended) return;
    const errors: unknown[] = [];
    let stopAt: number | undefined;
    try { stopAt = this.engine.hostTimeAt(this.engine.currentFrame); } catch (error) { errors.push(error); }
    for (const osc of this.#oscs) try { osc.stop(stopAt); } catch (error) { errors.push(error); }
    try { this.finish(); } catch (error) { errors.push(error); }
    if (errors.length) throw new TuneError('HOST_FAILURE', 'Host instrument voice disposal failed.', 'Dispose the engine to release remaining host resources.', { cause: new AggregateError(errors) });
  }
}

export class InstrumentVoice {
  /** @internal */ constructor(private voices: readonly SynthVoice[], readonly frequenciesHz: readonly number[]) {}
  get state(): 'playing' | 'stopping' | 'ended' {
    if (this.voices.some(voice => voice.state === 'playing')) return 'playing';
    if (this.voices.some(voice => voice.state !== 'ended')) return 'stopping';
    return 'ended';
  }
  stop(): void {
    for (const voice of this.voices) voice.release();
  }
  dispose(): void {
    const errors: unknown[] = [];
    for (const voice of this.voices) try { voice.dispose(); } catch (error) { errors.push(error); }
    if (errors.length) throw new TuneError('HOST_FAILURE', 'Host instrument voice disposal failed.', 'Dispose the engine to release remaining host resources.', { cause: new AggregateError(errors) });
  }
}
