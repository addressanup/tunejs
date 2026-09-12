import type { Engine } from './engine.js';
import { TuneError, finite } from './errors.js';
import { Instrument, noteToFrequency } from './instrument.js';
import { Kit } from './kit.js';
import { Sample } from './sample.js';
import type { InstrumentVoice } from './instrument.js';
import type { SampleVoice } from './sample.js';

export type Beats = { beats: number };
export interface PatternEvent { beat: number; notes: string | string[]; duration: Beats; velocity?: number; region?: { start: number; end?: number } }
export interface PatternData { length: Beats; events: readonly PatternEvent[] }
export interface TempoAck { effectiveBeat: number; appliedAt: 'now' | 'next-bar' }

/** Validated, frozen pattern. Events are stored sorted by beat (stable). */
export class Pattern {
  readonly length: Beats;
  readonly events: readonly Readonly<PatternEvent>[];
  /** @internal */ constructor(data: PatternData) {
    if (!data || typeof data !== 'object') throw new TuneError('INVALID_VALUE', 'A pattern needs data.', 'Provide { length: { beats }, events: [...] }.');
    const lengthBeats = finite(data.length?.beats ?? NaN, 0, 4096, 'pattern length beats');
    if (lengthBeats <= 0) throw new TuneError('INVALID_VALUE', 'Pattern length must exceed zero beats.', 'Choose a positive length.');
    if (!Array.isArray(data.events)) throw new TuneError('INVALID_VALUE', 'Pattern events must be an array.', 'Provide an events array.');
    const events = data.events.map((event, index) => {
      const beat = finite(event?.beat ?? NaN, 0, 4096, `event ${index} beat`);
      if (beat >= lengthBeats) throw new TuneError('INVALID_VALUE', `Event ${index} beat is outside the pattern.`, 'Keep beats below the pattern length.');
      const durationBeats = finite(event?.duration?.beats ?? NaN, 0, 4096, `event ${index} duration beats`);
      if (durationBeats <= 0) throw new TuneError('INVALID_VALUE', `Event ${index} duration must exceed zero beats.`, 'Choose a positive duration.');
      const velocity = finite(event?.velocity ?? 0.8, 0, 1, `event ${index} velocity`);
      const notes = event?.notes;
      if (typeof notes === 'string' ? !notes : !Array.isArray(notes) || notes.length === 0 || notes.some(note => typeof note !== 'string' || !note)) {
        throw new TuneError('INVALID_VALUE', `Event ${index} needs nonempty note or hit names.`, 'Pass a name string or a nonempty array of names.');
      }
      const region = event?.region === undefined ? undefined : (() => {
        const start = finite(event.region?.start ?? NaN, 0, Number.MAX_SAFE_INTEGER, `event ${index} region start`);
        const end = event.region?.end === undefined ? undefined : finite(event.region.end, 0, Number.MAX_SAFE_INTEGER, `event ${index} region end`);
        if (end !== undefined && end <= start) throw new TuneError('INVALID_VALUE', `Event ${index} region end must exceed its start.`, 'Choose an end after start.');
        return Object.freeze({ start, ...(end === undefined ? {} : { end }) });
      })();
      return Object.freeze({ beat, notes: Array.isArray(notes) ? Object.freeze(notes.slice()) : notes, duration: Object.freeze({ beats: durationBeats }), velocity, ...(region === undefined ? {} : { region }) });
    });
    // Array.prototype.sort is stable; equal beats keep declaration order.
    events.sort((a, b) => a.beat - b.beat);
    this.length = Object.freeze({ beats: lengthBeats });
    this.events = Object.freeze(events);
    Object.freeze(this);
  }
}

interface TempoSegment { startBeat: number; startFrame: number; framesPerBeat: number; bpm: number }

/** @internal exported for tests. Maps absolute beats to absolute frames across tempo changes — positions are always computed from absolute beats, never accumulated. */
export class TempoMap {
  #segments: TempoSegment[] = [];
  constructor(startBeat: number, startFrame: number, bpm: number, readonly sampleRate: number) {
    this.#segments.push({ startBeat, startFrame, framesPerBeat: 60 * sampleRate / bpm, bpm });
  }
  frameAtBeat(beat: number): number {
    let seg = this.#segments[0]!;
    for (const candidate of this.#segments) { if (candidate.startBeat <= beat) seg = candidate; else break; }
    return Math.round(seg.startFrame + (beat - seg.startBeat) * seg.framesPerBeat);
  }
  beatAtFrame(frame: number): number {
    let seg = this.#segments[0]!;
    for (const candidate of this.#segments) { if (candidate.startFrame <= frame) seg = candidate; else break; }
    return seg.startBeat + (frame - seg.startFrame) / seg.framesPerBeat;
  }
  bpmAt(beat: number): number {
    let seg = this.#segments[0]!;
    for (const candidate of this.#segments) { if (candidate.startBeat <= beat) seg = candidate; else break; }
    return seg.bpm;
  }
  append(startBeat: number, bpm: number): void {
    const startFrame = this.frameAtBeat(startBeat);
    this.#segments.push({ startBeat, startFrame, framesPerBeat: 60 * this.sampleRate / bpm, bpm });
    this.#segments.sort((a, b) => a.startBeat - b.startBeat);
  }
}

type PartState = 'scheduled' | 'playing' | 'cancelled';
interface Occurrence { beat: number; event: Readonly<PatternEvent> }

export class Part {
  state: PartState = 'scheduled';
  lastError: unknown = undefined;
  /** Absolute beat where the active pattern's iteration 0 begins. */
  #epochBeat: number;
  #pattern: Pattern;
  #pending: { pattern: Pattern; atBeat: number } | null = null;
  /** Next unscheduled occurrence within the active pattern. */
  #cursor = { iteration: 0, index: 0 };
  readonly #live = new Set<InstrumentVoice | SampleVoice>();
  /** @internal */ constructor(readonly transport: Transport, pattern: Pattern, readonly target: Instrument | Kit | Sample, readonly startBeat: number, readonly loop: boolean) {
    this.#pattern = pattern;
    this.#epochBeat = startBeat;
  }
  get pattern(): Pattern { return this.#pattern; }
  /** @internal */ get pendingReplace(): { pattern: Pattern; atBeat: number } | null { return this.#pending; }
  /** Next occurrence after the cursor, or null when a non-looping part is exhausted. */
  #nextOccurrence(): Occurrence | null {
    const events = this.#pattern.events;
    while (true) {
      if (this.#cursor.index >= events.length) {
        if (!this.loop || !events.length) return null;
        this.#cursor = { iteration: this.#cursor.iteration + 1, index: 0 };
        continue;
      }
      const event = events[this.#cursor.index]!;
      return { beat: this.#epochBeat + this.#cursor.iteration * this.#pattern.length.beats + event.beat, event };
    }
  }
  /** Advance the cursor past one occurrence. */
  #advance(): void { this.#cursor = { iteration: this.#cursor.iteration, index: this.#cursor.index + 1 }; }
  /** Apply a pending replacement once occurrences reach its effective beat. */
  #maybeApplyPending(beat: number): void {
    if (this.#pending && beat >= this.#pending.atBeat) {
      this.#pattern = this.#pending.pattern;
      this.#epochBeat = this.#pending.atBeat;
      this.#cursor = { iteration: 0, index: 0 };
      this.#pending = null;
    }
  }
  /** @internal */ skipBefore(beat: number): void {
    while (true) {
      const next = this.#nextOccurrence();
      if (!next) return;
      this.#maybeApplyPending(next.beat);
      const after = this.#nextOccurrence();
      if (!after || after.beat >= beat) return;
      this.#advance();
    }
  }
  /** @internal */ scheduleUpTo(transport: Transport, horizonFrame: number, currentFrame: number, sampleRate: number): void {
    for (const handle of [...this.#live]) if (handle.state === 'ended') this.#live.delete(handle);
    if (this.state === 'scheduled' && transport.currentBeat >= this.startBeat) this.state = 'playing';
    while (true) {
      const next = this.#nextOccurrence();
      if (!next) return;
      this.#maybeApplyPending(next.beat);
      const occurrence = this.#nextOccurrence();
      if (!occurrence) return;
      const startFrame = transport.frameAtBeat(occurrence.beat);
      if (startFrame >= horizonFrame) return;
      const endFrame = transport.frameAtBeat(occurrence.beat + occurrence.event.duration.beats);
      this.#advance();
      if (endFrame <= currentFrame) { transport.noteSkipped(); continue; }
      let start = startFrame;
      if (startFrame < currentFrame) { transport.noteLate((currentFrame - startFrame) / sampleRate); start = currentFrame; }
      try {
        const handle = this.target instanceof Sample
          ? this.target.play({ at: { frame: start }, duration: { seconds: (endFrame - start) / sampleRate }, region: occurrence.event.region })
          : this.target.play(occurrence.event.notes as string | string[], { velocity: occurrence.event.velocity, duration: { seconds: (endFrame - start) / sampleRate }, at: { frame: start } });
        this.#live.add(handle);
        transport.noteScheduled();
      } catch (error) {
        this.lastError = error;
        transport.noteError(error);
      }
    }
  }
  replace(pattern: Pattern, _options: { boundary: 'next-bar' }): { effectiveBeat: number } {
    const transport = this.transport;
    if (this.state === 'cancelled') throw new TuneError('INVALID_VALUE', 'The part is cancelled.', 'Schedule a new part instead.');
    if (transport.state === 'running') {
      const effectiveBeat = transport.nextBarBoundary(Math.max(transport.currentBeat, transport.horizonBeat, this.startBeat));
      this.#pending = { pattern, atBeat: effectiveBeat };
      return { effectiveBeat };
    }
    this.#pattern = pattern;
    this.#epochBeat = this.startBeat;
    this.#cursor = { iteration: 0, index: 0 };
    this.#pending = null;
    return { effectiveBeat: transport.position.beat };
  }
  cancel(): void {
    if (this.state === 'cancelled') return;
    this.state = 'cancelled';
    for (const handle of this.#live) try { handle.stop(); } catch { /* release best effort */ }
    this.#live.clear();
    this.#pending = null;
  }
  /** @internal */ releaseVoices(): void {
    for (const handle of this.#live) try { handle.stop(); } catch { /* best effort */ }
    this.#live.clear();
  }
  /** @internal */ reset(): void {
    this.#epochBeat = this.startBeat;
    this.#cursor = { iteration: 0, index: 0 };
    this.#pending = null;
    if (this.state === 'playing') this.state = 'scheduled';
  }
  /** @internal */ get liveVoices(): readonly (InstrumentVoice | SampleVoice)[] { return [...this.#live]; }
}

export class Transport {
  #state: 'stopped' | 'running' | 'paused' = 'stopped';
  #map: TempoMap | null = null;
  #bpm = 120;
  #pendingBpm: { bpm: number; effectiveBeat: number } | null = null;
  #pauseBeat = 0;
  #beatsPerBar = 4;
  #interval: unknown = null;
  #disposed = false;
  readonly #parts = new Set<Part>();
  readonly lookaheadSeconds = 0.25;
  readonly tickMs = 25;
  readonly prerollSeconds = 0.05;
  #lateEvents = 0;
  #maxLatenessSeconds = 0;
  #skippedEvents = 0;
  #scheduledEvents = 0;
  #interruptions = 0;
  #errors = 0;
  /** @internal */ timers = { set: (fn: () => void, ms: number): unknown => globalThis.setInterval(fn, ms), clear: (handle: unknown) => { globalThis.clearInterval(handle as Parameters<typeof clearInterval>[0]); } };
  /** @internal */ constructor(readonly engine: Engine) {}
  get meter(): { beatsPerBar: number } { return { beatsPerBar: this.#beatsPerBar }; }
  setMeter(meter: { beatsPerBar: number }): void {
    if (this.#state !== 'stopped') throw new TuneError('INVALID_VALUE', 'Meter is fixed while the transport runs.', 'Stop the transport first.');
    const beatsPerBar = meter?.beatsPerBar;
    if (!Number.isInteger(beatsPerBar) || beatsPerBar < 1 || beatsPerBar > 16) throw new TuneError('INVALID_VALUE', 'beatsPerBar must be an integer in [1, 16].', 'Choose a whole bar length.');
    this.#beatsPerBar = beatsPerBar;
  }
  get bpm(): { readonly value: number; readonly pending: number | null; set(value: number): TempoAck } {
    const self = this;
    return {
      get value() { return self.state === 'stopped' ? self.#bpm : self.#map!.bpmAt(self.currentBeat); },
      get pending() { return self.#pendingBpm && self.currentBeat < self.#pendingBpm.effectiveBeat ? self.#pendingBpm.bpm : null; },
      set(value: number) { return self.setBpm(value); },
    };
  }
  /** @internal */ get parts(): ReadonlySet<Part> { return this.#parts; }
  /** @internal */ get pendingTempo(): { bpm: number; effectiveBeat: number } | null { return this.#pendingBpm; }
  get state(): 'stopped' | 'running' | 'paused' { return this.#state; }
  /** @internal */ get currentBeat(): number {
    if (this.#state === 'stopped' || !this.#map) return 0;
    if (this.#state === 'paused') return this.#pauseBeat;
    return Math.max(0, this.#map.beatAtFrame(this.engine.currentFrame));
  }
  /** @internal */ get horizonBeat(): number {
    if (!this.#map) return 0;
    const lookaheadFrames = Math.round(this.lookaheadSeconds * this.engine.sampleRate!);
    return Math.max(0, this.#map.beatAtFrame(this.engine.currentFrame + lookaheadFrames));
  }
  get position(): { beat: number; bar: number; beatInBar: number } {
    if (this.#state === 'stopped') return { beat: 0, bar: 0, beatInBar: 0 };
    const beat = this.currentBeat;
    const bar = Math.floor(beat / this.#beatsPerBar);
    return { beat, bar, beatInBar: beat - bar * this.#beatsPerBar };
  }
  /** @internal */ frameAtBeat(beat: number): number { return this.#map!.frameAtBeat(beat); }
  /** @internal */ nextBarBoundary(beat: number): number { return Math.ceil(beat / this.#beatsPerBar) * this.#beatsPerBar; }
  private setBpm(value: number): TempoAck {
    const bpm = finite(value, 20, 400, 'bpm');
    this.#bpm = bpm;
    if (this.#state !== 'running') {
      const effectiveBeat = this.position.beat;
      if (this.#map) this.#map.append(effectiveBeat, bpm);
      this.#pendingBpm = null;
      return { effectiveBeat, appliedAt: 'now' };
    }
    const effectiveBeat = this.nextBarBoundary(Math.max(this.currentBeat, this.horizonBeat));
    this.#map!.append(effectiveBeat, bpm);
    this.#pendingBpm = { bpm, effectiveBeat };
    return { effectiveBeat, appliedAt: 'next-bar' };
  }
  start(): void {
    const context = this.engine.runningContext();
    if (this.#state === 'running') return;
    const resumeBeat = this.#state === 'paused' ? this.#pauseBeat : 0;
    const anchorFrame = this.engine.currentFrame + Math.round(this.prerollSeconds * context.sampleRate);
    let bpm = this.#map ? this.#map.bpmAt(resumeBeat) : this.#bpm;
    const pending = this.#pendingBpm;
    if (pending && pending.effectiveBeat <= resumeBeat) bpm = pending.bpm;
    this.#map = new TempoMap(resumeBeat, anchorFrame, bpm, context.sampleRate);
    // A queued tempo change survives the pause: future effective beats are re-appended to the rebased map.
    if (pending && pending.effectiveBeat > resumeBeat) {
      this.#map.append(pending.effectiveBeat, pending.bpm);
    } else {
      this.#pendingBpm = null;
    }
    for (const part of this.#parts) if (part.state !== 'cancelled') part.skipBefore(resumeBeat);
    this.#state = 'running';
    this.#interval = this.timers.set(() => this.tick(), this.tickMs);
    this.tick();
  }
  /** @internal */ tick(): void {
    if (this.#state !== 'running' || !this.#map) return;
    if (this.engine.state !== 'running') {
      this.#pauseBeat = this.#map.beatAtFrame(this.engine.currentFrame);
      if (this.#interval !== null) { this.timers.clear(this.#interval); this.#interval = null; }
      this.#state = 'paused';
      this.#interruptions++;
      return;
    }
    const sampleRate = this.engine.sampleRate!;
    const horizonFrame = this.engine.currentFrame + Math.round(this.lookaheadSeconds * sampleRate);
    for (const part of this.#parts) {
      if (part.state === 'cancelled') continue;
      try { part.scheduleUpTo(this, horizonFrame, this.engine.currentFrame, sampleRate); }
      catch (error) { part.lastError = error; this.noteError(error); }
    }
  }
  pause(): void {
    if (this.#state !== 'running' || !this.#map) return;
    this.#pauseBeat = this.#map.beatAtFrame(this.engine.currentFrame);
    if (this.#interval !== null) { this.timers.clear(this.#interval); this.#interval = null; }
    this.#state = 'paused';
  }
  stop(): void {
    if (this.#state === 'stopped') return;
    if (this.#interval !== null) { this.timers.clear(this.#interval); this.#interval = null; }
    for (const part of this.#parts) { part.releaseVoices(); if (part.state !== 'cancelled') part.reset(); }
    this.#state = 'stopped';
    this.#pauseBeat = 0;
    this.#pendingBpm = null;
    this.#map = null;
  }
  schedule(pattern: Pattern, target: Instrument | Kit | Sample, options: { at?: Beats; loop?: boolean } = {}): Part {
    if (this.#disposed) throw new TuneError('DISPOSED', 'The transport is disposed.', 'Create a new engine.');
    if (!(target instanceof Instrument) && !(target instanceof Kit) && !(target instanceof Sample)) throw new TuneError('INVALID_VALUE', 'A part target must be an instrument, kit or sample.', 'Pass an Instrument, Kit or Sample owned by this engine.');
    if (target.engine !== this.engine) throw new TuneError('CROSS_ENGINE', 'The target belongs to another engine.', 'Use a target owned by this engine.');
    if (!(pattern instanceof Pattern)) throw new TuneError('INVALID_VALUE', 'schedule needs an engine.pattern() value.', 'Build the pattern first.');
    const events = pattern.events;
    target.validateNames([...new Set(events.flatMap(event => Array.isArray(event.notes) ? event.notes : [event.notes]))]);
    const loop = options.loop ?? true;
    let startBeat: number;
    if (options.at !== undefined) {
      startBeat = finite(options.at.beats, 0, Number.MAX_SAFE_INTEGER, 'schedule at beats');
    } else if (this.#state === 'stopped') {
      startBeat = 0;
    } else {
      startBeat = this.nextBarBoundary(this.horizonBeat);
    }
    const part = new Part(this, pattern, target, startBeat, loop);
    this.#parts.add(part);
    return part;
  }
  /** @internal */ dispose(): void {
    this.stop();
    this.#disposed = true;
    for (const part of this.#parts) part.cancel();
  }
  get diagnostics() {
    return { state: this.#state, bpm: this.bpm.value, position: this.position, lateEvents: this.#lateEvents, maxLatenessSeconds: this.#maxLatenessSeconds, skippedEvents: this.#skippedEvents, scheduledEvents: this.#scheduledEvents, interruptions: this.#interruptions, errors: this.#errors };
  }
  /** @internal */ noteLate(seconds: number): void { this.#lateEvents++; if (seconds > this.#maxLatenessSeconds) this.#maxLatenessSeconds = seconds; }
  /** @internal */ noteSkipped(): void { this.#skippedEvents++; }
  /** @internal */ noteScheduled(): void { this.#scheduledEvents++; }
  /** @internal */ noteError(_error: unknown): void { this.#errors++; }
}
