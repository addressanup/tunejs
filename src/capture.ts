import type { HostCapture, HostNode, HostTap, HostTapChunk } from './backend.js';
import { encodeWav } from './assets.js';
import type { Engine } from './engine.js';
import { TuneError, finite } from './errors.js';
import { GraphNode } from './graph.js';
import type { HostContext } from './backend.js';
import type { SampleAsset } from './sample.js';

export interface PCMChunk { sequence: number; startFrame: number; sampleRate: number; channels: Float32Array[]; droppedFramesBefore: number }
export interface TapDiagnostics { delivered: number; droppedFrames: number; queuedFrames: number; peakQueuedFrames: number; state: 'active' | 'cancelled' | 'ended' }

/** @internal bounded chunk queue — capacity in frames; when full, the oldest chunks are dropped and counted. */
export class BoundedChunks {
  frames = 0;
  dropped = 0;
  peak = 0;
  readonly queue: HostTapChunk[] = [];
  constructor(readonly maxFrames: number) {}
  push(chunk: HostTapChunk): void {
    const size = chunk.channels[0]?.length ?? 0;
    while (this.frames + size > this.maxFrames && this.queue.length) {
      const old = this.queue.shift()!;
      this.frames -= old.channels[0]?.length ?? 0;
      this.dropped += old.channels[0]?.length ?? 0;
    }
    this.queue.push(chunk);
    this.frames += size;
    this.peak = Math.max(this.peak, this.frames);
  }
  shift(): HostTapChunk | undefined {
    const chunk = this.queue.shift();
    if (!chunk) return undefined;
    this.frames -= chunk.channels[0]?.length ?? 0;
    const result = { ...chunk, droppedFramesBefore: chunk.droppedFramesBefore + this.dropped };
    this.dropped = 0;
    return result;
  }
}

export class Tap {
  readonly chunkFrames: number;
  readonly maxBufferedFrames: number;
  endReason: 'cancelled' | 'source-disposed' | 'engine-disposed' | null = null;
  #queue: BoundedChunks;
  #waiters: (() => void)[] = [];
  #delivered = 0;
  #droppedFrames = 0;
  /** @internal */ constructor(readonly engine: Engine, readonly source: GraphNode, readonly hostTap: HostTap, chunkFrames: number, maxBufferedFrames: number) {
    this.chunkFrames = chunkFrames;
    this.maxBufferedFrames = maxBufferedFrames;
    this.#queue = new BoundedChunks(maxBufferedFrames);
    hostTap.onChunk(chunk => this.#onChunk(chunk));
  }
  /** @internal */ #onChunk(chunk: HostTapChunk): void {
    if (!chunk.channels[0] || chunk.channels[0].length === 0) {
      // Host flush chunks carry only the pending drop count; never yielded.
      this.#droppedFrames += chunk.droppedFramesBefore;
      return;
    }
    this.#queue.push(chunk);
    const waiters = this.#waiters; this.#waiters = [];
    for (const wake of waiters) wake();
  }
  /** @internal */ get state(): 'active' | 'cancelled' | 'ended' {
    return this.endReason === null ? 'active' : this.endReason === 'cancelled' ? 'cancelled' : 'ended';
  }
  get diagnostics(): TapDiagnostics {
    return { delivered: this.#delivered, droppedFrames: this.#droppedFrames, queuedFrames: this.#queue.frames, peakQueuedFrames: this.#queue.peak, state: this.state };
  }
  async *[Symbol.asyncIterator](): AsyncGenerator<PCMChunk> {
    while (true) {
      const chunk = this.#queue.shift();
      if (chunk) {
        this.#hostAck(chunk.sequence);
        this.#delivered += 1;
        this.#droppedFrames += chunk.droppedFramesBefore;
        yield { sequence: chunk.sequence, startFrame: chunk.startFrame, sampleRate: this.engine.sampleRate ?? 0, channels: chunk.channels, droppedFramesBefore: chunk.droppedFramesBefore };
        continue;
      }
      if (this.endReason !== null) return;
      await new Promise<void>(resolve => this.#waiters.push(resolve));
    }
  }
  /** @internal */ #hostAck(sequence: number): void {
    try { this.hostTap.acknowledge(sequence); } catch { /* host teardown races are tolerated */ }
  }
  cancel(): void { this.endBy('cancelled'); }
  /** @internal */ endBy(reason: 'cancelled' | 'source-disposed' | 'engine-disposed'): void {
    if (this.endReason !== null) return;
    this.endReason = reason;
    const errors: unknown[] = [];
    if (reason === 'cancelled') {
      // Targeted disconnect keeps the source's other edges; hosts that ignore the argument still work.
      try { (this.source.host as { disconnect(target?: HostNode): unknown } | undefined)?.disconnect(this.hostTap); } catch (error) { errors.push(error); }
    }
    try { this.hostTap.close(); } catch (error) { errors.push(error); }
    try { this.hostTap.onChunk(null); } catch { /* ignore */ }
    try { this.hostTap.disconnect(); } catch (error) { errors.push(error); }
    this.engine.taps.delete(this);
    const waiters = this.#waiters; this.#waiters = [];
    for (const wake of waiters) wake();
  }
}

export class Input extends GraphNode {
  /** @internal */ readonly capture: HostCapture;
  /** @internal */ constructor(engine: Engine, capture: HostCapture) {
    super(engine, 'source');
    this.capture = capture;
  }
  /** @internal */ override prepare(context: HostContext): void {
    let gain: HostNode | undefined;
    try {
      const host = context.createGain();
      host.gain.setValueAtTime(1, context.currentTime);
      this.capture.node.connect(host);
      gain = host; this.host = host;
    } catch (cause) {
      try { gain?.disconnect(); } catch (cleanup) { throw new AggregateError([cause, cleanup], 'Host input preparation and cleanup failed.'); }
      throw cause;
    }
  }
  override dispose(): void {
    const errors: unknown[] = [];
    try { this.capture.stop(); } catch (error) { errors.push(error); }
    try { super.dispose(); } catch (error) { errors.push(error); }
    if (errors.length) throw new TuneError('HOST_FAILURE', 'Host input cleanup failed.', 'Dispose the engine to release remaining host resources.', { cause: new AggregateError(errors) });
  }
}

export class Recording {
  /** @internal */ constructor(readonly channels: Float32Array[], readonly sampleRate: number, readonly frames: number, readonly reason: 'stopped' | 'duration-limit') {}
  toWav(): { bytes: ArrayBuffer; clippedSamples: number } { return encodeWav(this.channels, this.sampleRate); }
  asAsset(id: string): SampleAsset { return { id, bytes: this.toWav().bytes }; }
}

export class Recorder {
  #state: 'idle' | 'recording' | 'stopped' | 'failed' = 'idle';
  #tap?: Tap;
  #failure?: TuneError;
  #recording?: Recording;
  #buffers: Float32Array[] = [];
  #frames = 0;
  #stalled = false;
  #stallWake?: () => void;
  #consumer?: Promise<void>;
  readonly #maxFrames: number;
  /** @internal */ constructor(readonly engine: Engine, readonly source: GraphNode, readonly maxSeconds: number, readonly maxBufferedFrames?: number) {
    finite(maxSeconds, 0, 600, 'max seconds');
    if (maxSeconds <= 0) throw new TuneError('INVALID_VALUE', 'maxSeconds must exceed zero.', 'Choose a positive limit.');
    this.#maxFrames = Math.floor(maxSeconds * (engine.sampleRate ?? 48000));
  }
  get state(): 'idle' | 'recording' | 'stopped' | 'failed' { return this.#state; }
  async start(): Promise<void> {
    if (this.#state !== 'idle') throw new TuneError('INVALID_VALUE', 'The recorder already started.', 'Create a new recorder.');
    this.#tap = await this.engine.tap({ source: this.source, chunkFrames: 1024, maxBufferedFrames: this.maxBufferedFrames });
    this.#state = 'recording';
    this.#consumer = this.#consume();
  }
  /** @internal */ stall(flag: boolean): void {
    this.#stalled = flag;
    if (!flag) this.#stallWake?.();
  }
  async #consume(): Promise<void> {
    const tap = this.#tap!;
    try {
      for await (const chunk of tap) {
        while (this.#stalled) await new Promise<void>(resolve => { this.#stallWake = resolve; });
        if (chunk.droppedFramesBefore > 0 && !this.#failure) {
          this.#failure = new TuneError('OVERFLOW', `Recording dropped ${chunk.droppedFramesBefore} frames before a chunk.`, 'Reduce the source or raise maxBufferedFrames; the take is not continuous.');
        }
        if (this.#state !== 'recording') continue;
        const room = this.#maxFrames - this.#frames;
        for (let c = 0; c < chunk.channels.length; c += 1) {
          const src = chunk.channels[c]!;
          const taken = src.subarray(0, Math.max(0, Math.min(room, src.length)));
          if (!this.#buffers[c]) this.#buffers[c] = new Float32Array(this.#maxFrames);
          this.#buffers[c]!.set(taken, this.#frames);
        }
        this.#frames += Math.max(0, Math.min(room, chunk.channels[0]?.length ?? 0));
        if (this.#frames >= this.#maxFrames) this.#finalize('duration-limit');
      }
    } catch (error) {
      if (!this.#failure) this.#failure = error instanceof TuneError ? error : new TuneError('HOST_FAILURE', 'The recorder consumer failed.', 'Dispose the engine and retry.', { cause: error });
    }
  }
  /** @internal */ #finalize(reason: 'stopped' | 'duration-limit'): void {
    const channels = this.#buffers.map(buffer => buffer.slice(0, this.#frames));
    this.#recording = new Recording(channels, this.engine.sampleRate ?? 48000, this.#frames, reason);
    this.#state = this.#failure ? 'failed' : 'stopped';
    this.#tap?.cancel();
  }
  async stop(): Promise<Recording> {
    if (this.#state === 'idle') throw new TuneError('INVALID_VALUE', 'The recorder never started.', 'Call start() first.');
    this.#tap?.endBy('cancelled'); // closes the tap; the host flush folds pending drops into diagnostics
    if (this.#consumer) await this.#consumer;
    if (this.#tap && this.#tap.diagnostics.droppedFrames > 0 && !this.#failure) {
      this.#failure = new TuneError('OVERFLOW', `Recording dropped ${this.#tap.diagnostics.droppedFrames} frames.`, 'Reduce the source or raise maxBufferedFrames; the take is not continuous.');
    }
    if (this.#failure) { this.#state = 'failed'; throw this.#failure; }
    if (!this.#recording) this.#finalize('stopped');
    return this.#recording!;
  }
}

export interface MeterSnapshot {
  frame: number; frames: number; sampleRate: number;
  peak: number[]; rms: number[];
  waveform: { min: Float32Array; max: Float32Array };
}
export interface MeterTimers { now(): number; set(fn: () => void, ms: number): unknown; clear(handle: unknown): void }

export class Meter {
  #tap?: Tap;
  #latest?: PCMChunk;
  #dirty = false;
  #lastDelivery = -Infinity;
  #subscribers = new Set<(snapshot: MeterSnapshot) => void>();
  #interval: unknown = null;
  #disposed = false;
  readonly #timers: MeterTimers;
  readonly #minIntervalMs: number;
  /** The underlying tap's diagnostics — queue depth and drop accounting. */
  get diagnostics(): TapDiagnostics | { state: 'active'; delivered: 0; droppedFrames: 0; queuedFrames: 0; peakQueuedFrames: 0 } {
    return this.#tap?.diagnostics ?? { state: 'active', delivered: 0, droppedFrames: 0, queuedFrames: 0, peakQueuedFrames: 0 };
  }
  /** @internal */ constructor(readonly engine: Engine, readonly source: GraphNode, readonly updatesPerSecond: number, timers?: MeterTimers) {
    this.#timers = timers ?? { now: () => globalThis.performance.now(), set: (fn, ms) => globalThis.setInterval(fn, ms), clear: handle => { globalThis.clearInterval(handle as Parameters<typeof clearInterval>[0]); } };
    this.#minIntervalMs = 1000 / updatesPerSecond;
  }
  /** @internal */ attach(tap: Tap): void {
    this.#tap = tap;
    void (async () => { for await (const chunk of tap) { this.#latest = chunk; this.#dirty = true; } })().catch(() => { /* tap teardown ends the loop */ });
  }
  read(): MeterSnapshot {
    const chunk = this.#latest;
    const rate = this.engine.sampleRate ?? 48000;
    if (!chunk) {
      return { frame: 0, frames: 0, sampleRate: rate, peak: [0], rms: [0], waveform: { min: new Float32Array(64), max: new Float32Array(64) } };
    }
    const peak = chunk.channels.map(channel => channel.reduce((m, v) => Math.max(m, Math.abs(v)), 0));
    const rms = chunk.channels.map(channel => Math.sqrt(channel.reduce((sum, v) => sum + v * v, 0) / Math.max(1, channel.length)));
    const min = new Float32Array(64); const max = new Float32Array(64);
    const channel = chunk.channels[0]!;
    const frames = channel.length;
    for (let bucket = 0; bucket < 64; bucket += 1) {
      const from = Math.floor(bucket * frames / 64);
      const to = Math.max(from + 1, Math.floor((bucket + 1) * frames / 64));
      let lo = Infinity; let hi = -Infinity;
      for (let i = from; i < Math.min(to, frames); i += 1) { const v = channel[i]!; if (v < lo) lo = v; if (v > hi) hi = v; }
      min[bucket] = lo === Infinity ? 0 : lo; max[bucket] = hi === -Infinity ? 0 : hi;
    }
    return { frame: chunk.startFrame, frames, sampleRate: chunk.sampleRate || rate, peak, rms, waveform: { min, max } };
  }
  subscribe(callback: (snapshot: MeterSnapshot) => void): () => void {
    if (this.#disposed) throw new TuneError('DISPOSED', 'The meter is disposed.', 'Create a new meter.');
    this.#subscribers.add(callback);
    if (this.#subscribers.size === 1 && this.#interval === null) {
      this.#interval = this.#timers.set(() => this.flush(), this.#minIntervalMs);
    }
    return () => {
      this.#subscribers.delete(callback);
      if (this.#subscribers.size === 0 && this.#interval !== null) { this.#timers.clear(this.#interval); this.#interval = null; }
    };
  }
  /** @internal */ flush(): void {
    if (!this.#dirty || this.#subscribers.size === 0) return;
    const now = this.#timers.now();
    if (this.#lastDelivery !== -Infinity && now - this.#lastDelivery < this.#minIntervalMs) return;
    this.#lastDelivery = now;
    this.#dirty = false;
    const snapshot = this.read();
    for (const callback of [...this.#subscribers]) callback(snapshot);
  }
  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    if (this.#interval !== null) { this.#timers.clear(this.#interval); this.#interval = null; }
    this.#subscribers.clear();
    this.#tap?.endBy('cancelled');
  }
}
