import type { HostContext, HostGain } from './backend.js';
import type { Engine } from './engine.js';
import { TuneError, finite } from './errors.js';
import { GraphNode, Param } from './graph.js';
import { InstrumentVoice, SynthVoice, resolveStartFrame, validateEnvelope, validateLayer, validateMaxVoices } from './instrument.js';
import type { Envelope, InstrumentLayer, PlayOptions } from './instrument.js';

export interface HitPreset { frequencyHz: number; layers: readonly InstrumentLayer[]; envelope: Envelope }
export interface KitPreset { name: string; hits: Readonly<Record<string, HitPreset>>; level: number; maxVoices?: number }

const STEAL_RELEASE_SECONDS = 0.02;

interface FrozenHit { frequencyHz: number; layers: readonly ReturnType<typeof validateLayer>[]; envelope: Envelope }

export class Kit extends GraphNode {
  readonly level: Param;
  readonly preset: KitPreset;
  readonly maxVoices: number;
  readonly hits: readonly string[];
  #hits: Readonly<Record<string, FrozenHit>>;
  #live = new Set<SynthVoice>();
  /** @internal */ constructor(engine: Engine, preset: KitPreset, options: { maxVoices?: number } = {}) {
    super(engine, 'source');
    if (typeof preset !== 'object' || preset === null || typeof preset.name !== 'string' || !preset.name) {
      throw new TuneError('INVALID_VALUE', 'A kit preset needs a nonempty name.', 'Provide a preset object with a name.');
    }
    if (typeof preset.hits !== 'object' || preset.hits === null) throw new TuneError('INVALID_VALUE', 'A kit needs a hits record.', 'Map hit names to { frequencyHz, layers, envelope }.');
    const entries = Object.entries(preset.hits);
    if (entries.length < 1 || entries.length > 16) throw new TuneError('INVALID_VALUE', 'A kit needs 1-16 hits.', 'Choose fewer hits.');
    const frozen: Record<string, FrozenHit> = {};
    for (const [name, hit] of entries) {
      if (!name) throw new TuneError('INVALID_VALUE', 'Hit names must be nonempty.', 'Use a name like "kick" or "snare".');
      const frequencyHz = finite(hit?.frequencyHz, 1, 20000, 'hit frequency Hz');
      if (!Array.isArray(hit.layers) || hit.layers.length < 1 || hit.layers.length > 8) {
        throw new TuneError('INVALID_VALUE', `Hit '${name}' needs 1-8 layers.`, 'Choose fewer layers.');
      }
      frozen[name] = Object.freeze({ frequencyHz, layers: Object.freeze(hit.layers.map(validateLayer)), envelope: Object.freeze(validateEnvelope(hit.envelope)) });
    }
    const level = finite(preset.level, 0, 4, 'kit level');
    this.maxVoices = validateMaxVoices(options.maxVoices ?? preset.maxVoices ?? 16);
    this.#hits = Object.freeze(frozen);
    this.hits = Object.freeze(entries.map(([name]) => name));
    this.level = new Param(this, level, 'kit level', 0, 4);
    this.preset = preset;
  }
  get activeVoices(): number { return this.#live.size; }
  /** @internal */ register(voice: SynthVoice): void { this.#live.add(voice); }
  /** @internal */ unregister(voice: SynthVoice): void { this.#live.delete(voice); }
  /** @internal */ validateNames(names: readonly string[]): void {
    for (const name of names) {
      if (!this.#hits[name]) throw new TuneError('INVALID_VALUE', `Unknown hit '${name}'.`, `Available hits: ${this.hits.join(', ')}.`);
    }
  }
  /** @internal */ override prepare(context: HostContext): void {
    let levelGain: HostGain | undefined;
    try {
      levelGain = context.createGain();
      this.level.bind(levelGain.gain);
      this.host = levelGain;
    } catch (cause) {
      const errors: unknown[] = [cause];
      this.level.bind();
      try { levelGain?.disconnect(); } catch (error) { errors.push(error); }
      if (errors.length === 1) throw cause;
      throw new AggregateError(errors, 'Host graph preparation and cleanup failed.');
    }
  }
  play(hit: string | string[], options: PlayOptions = {}): InstrumentVoice {
    this.assertAlive();
    const context = this.engine.runningContext();
    const velocity = finite(options.velocity ?? 0.8, 0, 1, 'velocity');
    const duration = options.duration && finite(options.duration.seconds, 0.001, 3600, 'duration seconds');
    const startFrame = resolveStartFrame(this.engine, options.at);
    const names = Array.isArray(hit) ? hit : [hit];
    if (!names.length) throw new TuneError('INVALID_VALUE', 'play requires at least one hit.', 'Pass a hit name like "kick".');
    if (names.length > this.maxVoices) throw new TuneError('INVALID_VALUE', 'The hit list exceeds the voice limit.', 'Play fewer hits or raise maxVoices.');
    const hits = names.map(name => {
      const found = typeof name === 'string' ? this.#hits[name] : undefined;
      if (!found) throw new TuneError('INVALID_VALUE', `Unknown hit '${String(name)}'.`, `Available hits: ${this.hits.join(', ')}.`);
      return found;
    });
    const created: SynthVoice[] = [];
    try {
      for (const found of hits) {
        if (this.#live.size >= this.maxVoices) {
          const victim = [...this.#live].find(voice => !voice.stopping);
          if (victim) victim.release(STEAL_RELEASE_SECONDS);
        }
        const voice = new SynthVoice({ engine: this.engine, voiceInput: this.host!, layers: found.layers, envelope: { ...found.envelope }, frequencyHz: found.frequencyHz, register: v => this.register(v), unregister: v => this.unregister(v) }, velocity, duration, context, startFrame);
        this.register(voice);
        created.push(voice);
      }
    } catch (cause) {
      const errors: unknown[] = [cause];
      for (const voice of created) try { voice.dispose(); } catch (error) { errors.push(error); }
      throw new TuneError('HOST_FAILURE', 'The host could not start the kit voice.', 'Dispose the engine and reactivate output with a new engine.', { cause: errors.length === 1 ? cause : new AggregateError(errors) });
    }
    return new InstrumentVoice(created.slice(), Object.freeze(hits.map(found => found.frequencyHz)));
  }
  stopAll(): void {
    for (const voice of [...this.#live]) voice.release();
  }
  override dispose(): void {
    const errors: unknown[] = [];
    for (const voice of [...this.#live]) try { voice.dispose(); } catch (error) { errors.push(error); }
    try { super.dispose(); } catch (error) { errors.push(error); }
    this.level.bind();
    if (errors.length) throw new TuneError('HOST_FAILURE', 'Host kit cleanup failed.', 'Dispose the engine to release remaining host resources.', { cause: new AggregateError(errors) });
  }
}
