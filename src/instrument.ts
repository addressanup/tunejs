import type { HostContext, HostFilter, HostGain, HostNode, HostScheduledSource } from './backend.js';
import type { Engine } from './engine.js';
import { TuneError, finite } from './errors.js';
import { GraphNode, Param } from './graph.js';
import type { OwnedVoice, Seconds } from './graph.js';

export type Wave = 'sine' | 'triangle' | 'square' | 'sawtooth';
export interface Envelope { attack: number; decay: number; sustain: number; release: number }
export interface InstrumentLayer {
  source?: 'oscillator' | 'noise';
  wave?: Wave;
  ratio?: number;
  detuneCents?: number;
  level?: number;
  pitch?: { startRatio: number; seconds: number };
  filter?: { type: 'lowpass' | 'highpass'; frequencyHz: number };
}
export interface InstrumentPreset { name: string; layers: readonly InstrumentLayer[]; envelope: Envelope; filter?: { type: 'lowpass' | 'highpass'; frequencyHz: number }; level: number; maxVoices?: number }
export interface PlayOptions { velocity?: number; duration?: Seconds; at?: { frame: number } }

/** @internal */ export function validateLayer(layer: InstrumentLayer): Readonly<Required<Pick<InstrumentLayer, 'source' | 'ratio' | 'detuneCents' | 'level'>>> & Pick<InstrumentLayer, 'wave' | 'pitch' | 'filter'> {
  if (!layer || typeof layer !== 'object') throw new TuneError('INVALID_VALUE', 'A layer must be an object.', 'Provide a layer with a wave or noise source.');
  const source = layer.source ?? 'oscillator';
  if (source !== 'oscillator' && source !== 'noise') throw new TuneError('INVALID_VALUE', 'Unknown layer source.', "Use 'oscillator' or 'noise'.");
  if (source === 'noise' && (layer.wave !== undefined || layer.ratio !== undefined || layer.detuneCents !== undefined || layer.pitch !== undefined)) {
    throw new TuneError('INVALID_VALUE', 'Noise layers do not accept wave, ratio, detuneCents or pitch.', 'Use { source: "noise", level, filter }.');
  }
  const wave = layer.wave ?? 'sine';
  if (!WAVES.includes(wave)) throw new TuneError('INVALID_VALUE', 'Unknown layer wave.', 'Use sine, triangle, square, or sawtooth.');
  const ratio = finite(layer.ratio ?? 1, 0.01, 64, 'layer ratio');
  const detuneCents = finite(layer.detuneCents ?? 0, -4800, 4800, 'layer detune cents');
  const level = finite(layer.level ?? 1, 0, 1, 'layer level');
  const pitch = layer.pitch === undefined ? undefined : Object.freeze({
    startRatio: finite(layer.pitch.startRatio, 0.1, 16, 'pitch start ratio'),
    seconds: finite(layer.pitch.seconds, 0.001, 2, 'pitch seconds'),
  });
  const filter = layer.filter === undefined ? undefined : Object.freeze({
    type: layer.filter.type === 'lowpass' || layer.filter.type === 'highpass' ? layer.filter.type : (() => { throw new TuneError('INVALID_VALUE', 'Unknown layer filter type.', 'Use lowpass or highpass.'); })(),
    frequencyHz: finite(layer.filter.frequencyHz, 10, 20000, 'layer filter frequency Hz'),
  });
  return Object.freeze({ source, wave, ratio, detuneCents, level, pitch, filter });
}

/** @internal */ export function validateEnvelope(envelope: Envelope | undefined): Envelope {
  return {
    attack: finite(envelope?.attack ?? NaN, 0, 10, 'envelope attack seconds'),
    decay: finite(envelope?.decay ?? NaN, 0, 10, 'envelope decay seconds'),
    sustain: finite(envelope?.sustain ?? NaN, 0, 1, 'envelope sustain level'),
    release: finite(envelope?.release ?? NaN, 0.001, 10, 'envelope release seconds'),
  };
}

/** @internal */ export function validateMaxVoices(value: number): number {
  if (!Number.isInteger(value) || value < 1 || value > 64) throw new TuneError('INVALID_VALUE', 'maxVoices must be an integer in [1, 64].', 'Choose a whole voice count.');
  return value;
}

/** @internal */ export function resolveStartFrame(engine: Engine, at: { frame: number } | undefined): number {
  if (at === undefined) return engine.currentFrame;
  if (!Number.isInteger(at.frame) || at.frame < 0) throw new TuneError('INVALID_VALUE', 'at.frame must be a nonnegative integer frame.', 'Pass the frame at which the voice should start.');
  if (at.frame < engine.currentFrame) throw new TuneError('INVALID_VALUE', 'The scheduled frame must not be in the past.', 'Use a frame at or after engine.currentFrame.');
  return at.frame;
}
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
  /** @internal */ voiceInput?: HostNode;
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
    const frozenLayers = layers.map(validateLayer);
    const { attack, decay, sustain, release } = validateEnvelope(preset.envelope);
    const filterType = preset.filter?.type ?? 'lowpass';
    if (filterType !== 'lowpass' && filterType !== 'highpass') throw new TuneError('INVALID_VALUE', 'Unknown preset filter type.', 'Use lowpass or highpass.');
    const filterFrequency = finite(preset.filter?.frequencyHz ?? 20000, 10, 20000, 'filter frequency Hz');
    const level = finite(preset.level, 0, 4, 'instrument level');
    const maxVoices = validateMaxVoices(options.maxVoices ?? preset.maxVoices ?? 16);
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
  /** @internal */ validateNames(names: readonly string[]): void { for (const name of names) noteToFrequency(name); }
  /** @internal */ override prepare(context: HostContext): void {
    let filter: HostFilter | undefined; let levelGain: HostGain | undefined;
    try {
      filter = context.createBiquadFilter();
      filter.type = this.preset.filter!.type; filter.Q.setValueAtTime(0, this.engine.currentTime);
      this.filterHz.bind(filter.frequency);
      levelGain = context.createGain();
      this.level.bind(levelGain.gain);
      filter.connect(levelGain);
      this.voiceInput = filter; this.host = levelGain;
    } catch (cause) {
      const errors: unknown[] = [cause];
      this.filterHz.bind(); this.level.bind();
      try { filter?.disconnect(); } catch (error) { errors.push(error); }
      try { levelGain?.disconnect(); } catch (error) { errors.push(error); }
      if (errors.length === 1) throw cause;
      throw new AggregateError(errors, 'Host graph preparation and cleanup failed.');
    }
  }
  play(notes: string | { frequencyHz: number } | Array<string | { frequencyHz: number }>, options: PlayOptions = {}): InstrumentVoice {
    this.assertAlive();
    const context = this.engine.runningContext();
    const velocity = finite(options.velocity ?? 0.8, 0, 1, 'velocity');
    const duration = options.duration && finite(options.duration.seconds, 0.001, 3600, 'duration seconds');
    const startFrame = resolveStartFrame(this.engine, options.at);
    const list = (Array.isArray(notes) ? notes : [notes]) as Array<string | { frequencyHz: number }>;
    if (!list.length) throw new TuneError('INVALID_VALUE', 'play requires at least one note.', 'Pass a note name or a frequency object.');
    if (list.length > this.maxVoices) throw new TuneError('INVALID_VALUE', 'The chord exceeds the voice limit.', 'Play fewer notes or raise maxVoices.');
    const frequencies = list.map(note => typeof note === 'string' ? noteToFrequency(note) : finite(note?.frequencyHz ?? NaN, 1, 20000, 'frequency Hz'));
    for (const frequency of frequencies) {
      for (const layer of this.preset.layers) {
        if (layer.source === 'noise') continue;
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
        const voice = new SynthVoice({ engine: this.engine, voiceInput: this.voiceInput!, layers: this.preset.layers, envelope: { ...this.#envelope }, frequencyHz: frequency, register: v => this.register(v), unregister: v => this.unregister(v) }, velocity, duration, context, startFrame);
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
    try { this.voiceInput?.disconnect(); this.voiceInput = undefined; } catch (error) { errors.push(error); }
    if (errors.length) throw new TuneError('HOST_FAILURE', 'Host instrument cleanup failed.', 'Dispose the engine to release remaining host resources.', { cause: new AggregateError(errors) });
  }
}

/** @internal */ export interface VoiceHost {
  engine: Engine;
  voiceInput: HostNode;
  layers: readonly InstrumentLayer[];
  envelope: Envelope;
  frequencyHz: number | null;
  register(voice: SynthVoice): void;
  unregister(voice: SynthVoice): void;
}

export class SynthVoice implements OwnedVoice {
  #ended = false;
  #stopping = false;
  readonly #sources: HostScheduledSource[] = [];
  readonly #layerGains: HostGain[] = [];
  readonly #layerFilters: HostFilter[] = [];
  #env?: HostGain;
  readonly #t0: number;
  readonly #peak: number;
  readonly #envelope: Envelope;
  readonly #releaseSeconds: number;
  #releaseStart?: number;
  #releaseStartValue?: number;
  #releaseEnd?: number;
  /** @internal */ constructor(private voiceHost: VoiceHost, velocity: number, duration: number | undefined, private context: HostContext, startFrame: number) {
    const engine = voiceHost.engine;
    const envelope = voiceHost.envelope;
    this.#envelope = envelope;
    this.#releaseSeconds = envelope.release;
    const t0 = startFrame / context.sampleRate;
    this.#t0 = t0;
    this.#peak = velocity;
    try {
      const env = context.createGain(); this.#env = env;
      for (const layer of voiceHost.layers) {
        let source: HostScheduledSource;
        if (layer.source === 'noise') {
          const noise = context.createBufferSource();
          noise.buffer = engine.noiseBuffer(context);
          noise.loop = true;
          source = noise;
        } else {
          const osc = context.createOscillator();
          osc.type = layer.wave ?? 'sine';
          const f = voiceHost.frequencyHz! * (layer.ratio ?? 1) * 2 ** ((layer.detuneCents ?? 0) / 1200);
          if (layer.pitch) {
            osc.frequency.setValueAtTime(f * layer.pitch.startRatio, t0);
            osc.frequency.linearRampToValueAtTime(f, t0 + layer.pitch.seconds);
          } else {
            osc.frequency.setValueAtTime(f, t0);
          }
          source = osc;
        }
        let tail: HostNode = source;
        if (layer.filter) {
          const layerFilter = context.createBiquadFilter();
          layerFilter.type = layer.filter.type;
          layerFilter.frequency.setValueAtTime(layer.filter.frequencyHz, t0);
          layerFilter.Q.setValueAtTime(0, t0);
          tail.connect(layerFilter); tail = layerFilter;
          this.#layerFilters.push(layerFilter);
        }
        const layerGain = context.createGain();
        layerGain.gain.setValueAtTime(layer.level ?? 1, t0);
        tail.connect(layerGain); layerGain.connect(env);
        this.#sources.push(source); this.#layerGains.push(layerGain);
      }
      env.connect(voiceHost.voiceInput);
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
      const startAt = engine.hostTimeAt(startFrame);
      for (const source of this.#sources) source.start(startAt);
      if (duration !== undefined) {
        const stopAt = engine.hostTimeAt(Math.round((t0 + duration + release) * context.sampleRate) + 1);
        for (const source of this.#sources) source.stop(stopAt);
      } else if (envelope.sustain === 0) {
        // A sustain-0 envelope is inaudible after the decay; release the sources on the decay+release tail.
        const stopAt = engine.hostTimeAt(Math.round((t0 + attack + decay + release) * context.sampleRate) + 1);
        for (const source of this.#sources) source.stop(stopAt);
      }
      engine.adapter.setEnded(this.#sources[0]!, () => this.finish());
    } catch (cause) {
      const errors: unknown[] = [cause];
      if (this.#sources[0]) try { engine.adapter.setEnded(this.#sources[0], null); } catch (error) { errors.push(error); }
      for (const source of this.#sources) try { source.disconnect(); } catch (error) { errors.push(error); }
      for (const filter of this.#layerFilters) try { filter.disconnect(); } catch (error) { errors.push(error); }
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
    const stopAt = this.voiceHost.engine.hostTimeAt(Math.round((now + secs) * this.context.sampleRate) + 1);
    for (const source of this.#sources) source.stop(stopAt);
    this.#stopping = true;
    this.#releaseStart = now; this.#releaseStartValue = v; this.#releaseEnd = now + secs;
  }
  private finish(): void {
    if (this.#ended) return;
    this.#ended = true;
    this.voiceHost.engine.voices.delete(this);
    this.voiceHost.unregister(this);
    const errors: unknown[] = [];
    try { this.voiceHost.engine.adapter.setEnded(this.#sources[0]!, null); } catch (error) { errors.push(error); }
    for (const source of this.#sources) try { source.disconnect(); } catch (error) { errors.push(error); }
    for (const filter of this.#layerFilters) try { filter.disconnect(); } catch (error) { errors.push(error); }
    for (const gain of this.#layerGains) try { gain.disconnect(); } catch (error) { errors.push(error); }
    try { this.#env?.disconnect(); } catch (error) { errors.push(error); }
    if (errors.length) throw new TuneError('HOST_FAILURE', 'Host instrument voice cleanup failed.', 'Dispose the engine to release remaining host resources.', { cause: new AggregateError(errors) });
  }
  dispose(): void {
    if (this.#ended) return;
    const errors: unknown[] = [];
    let stopAt: number | undefined;
    try { stopAt = this.voiceHost.engine.hostTimeAt(this.voiceHost.engine.currentFrame); } catch (error) { errors.push(error); }
    for (const source of this.#sources) try { source.stop(stopAt); } catch (error) { errors.push(error); }
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
