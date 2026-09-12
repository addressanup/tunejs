import type { HostBuffer, HostBufferSource, HostContext, HostGain } from './backend.js';
import type { DecodedWav } from './assets.js';
import { resample } from './assets.js';
import type { Engine } from './engine.js';
import { TuneError, finite, integerFrame } from './errors.js';
import { GraphNode } from './graph.js';
import type { OwnedVoice, Seconds } from './graph.js';

export interface SampleAsset { id: string; bytes?: ArrayBuffer | ArrayBufferView; url?: string }
/** @internal */ export interface SampleEntry {
  id: string;
  decoded: DecodedWav;
  refs: Set<Sample>;
  hostBuffers: Map<number, HostBuffer>;
}

export class Sample extends GraphNode {
  #voices = new Set<SampleVoice>();
  readonly id: string;
  /** @internal */ readonly entry: SampleEntry;
  /** @internal */ constructor(engine: Engine, entry: SampleEntry) {
    super(engine, 'source');
    this.entry = entry;
    this.id = entry.id;
    entry.refs.add(this);
  }
  get sampleRate(): number { return this.entry.decoded.sampleRate; }
  get channels(): number { return this.entry.decoded.channels.length; }
  get frames(): number { return this.entry.decoded.frames; }
  get duration(): number { return this.frames / this.sampleRate; }
  /** @internal */ validateNames(_names: readonly string[]): void { /* every name is valid for a sample target */ }
  /** @internal */ register(voice: SampleVoice): void { this.#voices.add(voice); }
  /** @internal */ unregister(voice: SampleVoice): void { this.#voices.delete(voice); }
  /** @internal */ override prepare(context: HostContext): void {
    let host: HostGain | undefined;
    try {
      const gain = context.createGain(); host = gain;
      gain.gain.setValueAtTime(1, this.engine.currentTime);
      if (!this.entry.hostBuffers.has(context.sampleRate)) {
        const decoded = this.entry.decoded;
        const data = decoded.sampleRate === context.sampleRate ? decoded.channels : resample(decoded.channels, decoded.sampleRate, context.sampleRate);
        const buffer = context.createBuffer(data.length, data[0]!.length, context.sampleRate);
        for (let channel = 0; channel < data.length; channel++) buffer.copyToChannel(data[channel]!, channel);
        this.entry.hostBuffers.set(context.sampleRate, buffer);
      }
      this.host = host;
    } catch (cause) {
      try { host?.disconnect(); }
      catch (cleanup) { throw new AggregateError([cause, cleanup], 'Host graph preparation and cleanup failed.'); }
      throw cause;
    }
  }
  play(options: { region?: { start: number; end?: number }; loop?: boolean; rate?: number; duration?: Seconds; at?: { frame: number } } = {}): SampleVoice {
    this.assertAlive();
    const context = this.engine.runningContext();
    const rate = finite(options.rate ?? 1, 0.25, 4, 'playback rate');
    const duration = options.duration && finite(options.duration.seconds, 0.001, 3600, 'duration seconds');
    const startFrame = options.at === undefined ? this.engine.currentFrame : integerFrame(finite(options.at.frame, 0, Number.MAX_SAFE_INTEGER, 'at frame'), 'at frame');
    const regionStart = options.region?.start ?? 0;
    if (!Number.isFinite(regionStart) || regionStart < 0 || regionStart >= this.duration) {
      throw new TuneError('INVALID_VALUE', 'Region start must be within [0, duration).', 'Choose a start inside the asset.');
    }
    const regionEnd = options.region?.end ?? this.duration;
    if (!Number.isFinite(regionEnd) || regionEnd <= regionStart || regionEnd > this.duration) {
      throw new TuneError('INVALID_VALUE', 'Region end must be within (start, duration].', 'Choose an end after start and inside the asset.');
    }
    const loop = options.loop ?? false;
    let voice: SampleVoice | undefined;
    try {
      const created = new SampleVoice(this.engine, this, regionStart, regionEnd, rate, loop, duration, context, startFrame);
      voice = created;
      this.register(created);
      return created;
    } catch (cause) {
      const errors: unknown[] = [cause];
      if (voice) {
        try { voice.dispose(); } catch (error) { errors.push(error); }
      }
      throw new TuneError('HOST_FAILURE', 'The host could not start the sample voice.', 'Dispose the engine and reactivate output with a new engine.', { cause: errors.length === 1 ? cause : new AggregateError(errors) });
    }
  }
  stopAll(): void {
    for (const voice of [...this.#voices]) voice.stop();
  }
  override dispose(): void {
    const errors: unknown[] = [];
    for (const voice of [...this.#voices]) try { voice.dispose(); } catch (error) { errors.push(error); }
    try { super.dispose(); } catch (error) { errors.push(error); }
    this.entry.refs.delete(this);
    if (errors.length) throw new TuneError('HOST_FAILURE', 'Host sample cleanup failed.', 'Dispose the engine to release remaining host resources.', { cause: new AggregateError(errors) });
  }
}

export class SampleVoice implements OwnedVoice {
  #ended = false;
  #stopping = false;
  #generation = 0;
  #source?: HostBufferSource;
  readonly #startOffset: number;
  #offset: number;
  #startTime: number;
  #stopFrame?: number;
  #lastPosition?: number;
  constructor(private engine: Engine, private sample: Sample, private regionStart: number, private regionEnd: number, private rate: number, private loop: boolean, duration: number | undefined, private context: HostContext, startFrame = engine.currentFrame) {
    this.#startOffset = this.#offset = regionStart;
    this.#startTime = engine.hostTimeAt(startFrame);
    try {
      const source = this.createSource(regionStart);
      this.#source = source;
      source.start(engine.hostTimeAt(startFrame), regionStart, loop ? undefined : regionEnd - regionStart);
      if (duration !== undefined) {
        this.#stopFrame = startFrame + Math.round(duration * context.sampleRate);
        source.stop(engine.hostTimeAt(this.#stopFrame));
      }
      const generation = ++this.#generation;
      engine.adapter.setEnded(source, () => { if (generation === this.#generation) this.finish(); });
      engine.voices.add(this);
    } catch (cause) {
      const errors: unknown[] = [cause];
      if (this.#source) try { this.engine.adapter.setEnded(this.#source, null); } catch (error) { errors.push(error); }
      try { this.#source?.disconnect(); } catch (error) { errors.push(error); }
      if (errors.length === 1) throw cause;
      throw new AggregateError(errors, 'Host voice preparation and cleanup failed.');
    }
  }
  get state(): 'playing' | 'stopping' | 'ended' { return this.#ended ? 'ended' : this.#stopping ? 'stopping' : 'playing'; }
  get position(): number { return this.#ended ? this.#lastPosition ?? 0 : this.computePosition(); }
  private computePosition(): number {
    const elapsed = (this.context.currentTime - this.#startTime) * this.rate;
    const position = this.#offset + elapsed;
    if (!this.loop) return Math.min(Math.max(position, this.regionStart), this.regionEnd);
    const span = this.regionEnd - this.regionStart;
    return this.regionStart + (((position - this.regionStart) % span) + span) % span;
  }
  private createSource(offset: number): HostBufferSource {
    const source = this.context.createBufferSource();
    source.buffer = this.sample.entry.hostBuffers.get(this.context.sampleRate) ?? null;
    source.playbackRate.setValueAtTime(this.rate, this.context.currentTime);
    if (this.loop) { source.loop = true; source.loopStart = this.regionStart; source.loopEnd = this.regionEnd; }
    source.connect(this.sample.host!);
    return source;
  }
  stop(): void {
    if (this.#ended || this.#stopping) return;
    // Immediate stop; no release fade yet — abrupt endings can click.
    try { this.#source!.stop(this.engine.hostTimeAt(this.engine.currentFrame)); this.#stopping = true; }
    catch (cause) { throw new TuneError('HOST_FAILURE', 'The host could not stop the voice.', 'Dispose the voice or engine to release remaining host resources.', { cause }); }
  }
  async seek(seconds: number): Promise<{ position: number }> {
    if (this.#ended) throw new TuneError('DISPOSED', 'The voice has ended.', 'Play a new voice instead of seeking.');
    if (this.#stopping) throw new TuneError('DISPOSED', 'The voice is stopping.', 'Seek before calling stop(), or play a new voice.');
    if (!Number.isFinite(seconds) || seconds < this.regionStart || seconds >= this.regionEnd) {
      throw new TuneError('INVALID_VALUE', 'Seek target must be inside the play region.', 'Choose a position within [region.start, region.end).');
    }
    const applied = Math.round(seconds * this.sample.sampleRate) / this.sample.sampleRate;
    let next: HostBufferSource | undefined;
    try {
      const at = this.engine.hostTimeAt(this.engine.currentFrame);
      const generation = this.#generation + 1;
      next = this.createSource(applied);
      this.engine.adapter.setEnded(next, () => { if (generation === this.#generation) this.finish(); });
      next.start(at, applied, this.loop ? undefined : this.regionEnd - applied);
      const previous = this.#source!;
      previous.stop(at);
      this.engine.adapter.setEnded(previous, null);
      if (this.#stopFrame !== undefined) next.stop(this.engine.hostTimeAt(this.#stopFrame));
      this.#generation = generation;
      this.#source = next;
      this.#startTime = this.context.currentTime; this.#offset = applied;
      return { position: applied };
    } catch (cause) {
      try { next && this.engine.adapter.setEnded(next, null); next?.disconnect(); } catch { /* secondary cleanup failure */ }
      throw new TuneError('HOST_FAILURE', 'The host could not seek the voice.', 'Retry the seek or dispose the voice.', { cause });
    }
  }
  private finish(): void {
    if (this.#ended) return;
    this.#ended = true;
    this.#lastPosition = this.computePosition();
    const source = this.#source;
    this.#source = undefined;
    this.engine.voices.delete(this);
    this.sample.unregister(this);
    const errors: unknown[] = [];
    try { source && this.engine.adapter.setEnded(source, null); } catch (error) { errors.push(error); }
    try { source?.disconnect(); } catch (error) { errors.push(error); }
    if (errors.length) throw new TuneError('HOST_FAILURE', 'Host voice cleanup failed.', 'Dispose the engine to release remaining host resources.', { cause: new AggregateError(errors) });
  }
  dispose(): void {
    if (this.#ended) return;
    const errors: unknown[] = [];
    try { this.#source!.stop(this.engine.hostTimeAt(this.engine.currentFrame)); } catch (error) { errors.push(error); }
    try { this.finish(); } catch (error) { errors.push(error); }
    if (errors.length) throw new TuneError('HOST_FAILURE', 'Host voice disposal failed.', 'Dispose the engine to release remaining host resources.', { cause: new AggregateError(errors) });
  }
}
