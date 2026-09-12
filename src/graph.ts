import type { HostContext, HostFilter, HostGain, HostNode, HostOscillator, HostParam } from './backend.js';
import { TuneError, finite } from './errors.js';
import type { Engine } from './engine.js';
export type Seconds = { seconds: number };
export interface OwnedVoice { readonly state: string; dispose(): void }

export interface ParamMapping { toHost(value: number): number; fromHost(host: number): number }
const IDENTITY_MAPPING: ParamMapping = { toHost: value => value, fromHost: value => value };

export class Param {
  #host?: HostParam;
  #from: number;
  #target: number;
  #start = 0;
  #end = 0;
  readonly #mapping: ParamMapping;
  constructor(private owner: GraphNode, value: number, readonly units: string, readonly min: number, readonly max: number, mapping?: ParamMapping) {
    this.#from = this.#target = finite(value, min, max, units);
    this.#mapping = mapping ?? IDENTITY_MAPPING;
  }
  get value(): number {
    const { toHost, fromHost } = this.#mapping;
    const t = this.owner.engine.currentTime;
    return this.#end <= t ? this.#target : fromHost(toHost(this.#from) + (toHost(this.#target) - toHost(this.#from)) * Math.max(0, (t - this.#start) / (this.#end - this.#start)));
  }
  /** @internal */ bind(host?: HostParam): void {
    if (host) {
      const now = this.owner.engine.currentTime;
      host.setValueAtTime(this.#mapping.toHost(this.value), now);
      if (this.#end > now) host.linearRampToValueAtTime(this.#mapping.toHost(this.#target), this.#end);
    }
    this.#host = host;
  }
  set(value: number): this { return this.rampTo(value, { seconds: 0 }); }
  rampTo(value: number, duration: Seconds): this {
    this.owner.assertAlive();
    finite(value, this.min, this.max, this.units);
    finite(duration.seconds, 0, 3600, 'ramp seconds');
    const now = this.owner.engine.currentTime;
    const current = this.value;
    const { toHost } = this.#mapping;
    // Own the ramp calculation: avoids relying on differing native AudioParam.value semantics.
    if (this.#host) {
      this.#host.cancelScheduledValues(now);
      this.#host.setValueAtTime(toHost(current), now);
      if (duration.seconds === 0) this.#host.setValueAtTime(toHost(value), now);
      else this.#host.linearRampToValueAtTime(toHost(value), now + duration.seconds);
    }
    this.#from = current; this.#target = value; this.#start = now; this.#end = now + duration.seconds;
    return this;
  }
}

export class GraphNode {
  /** @internal */ host?: HostNode;
  /** @internal */ readonly targets = new Set<GraphNode>();
  #disposed = false;
  /** @internal */ constructor(readonly engine: Engine, readonly kind: 'source' | 'gain' | 'filter' | 'bus' | 'pan' | 'delay' | 'reverb' | 'output') {}
  /** @internal */ assertAlive(): void {
    this.engine.assertAlive();
    if (this.#disposed) throw new TuneError('DISPOSED', `${this.kind} is disposed.`, 'Create a new graph object.');
  }
  connect<T extends GraphNode>(target: T): T {
    this.assertAlive(); target.assertAlive();
    if (target.engine !== this.engine) throw new TuneError('CROSS_ENGINE', 'Cannot connect objects owned by different engines.', 'Create both objects in the same engine.');
    if (this.kind === 'output' || target.kind === 'source' || target.reaches(this)) {
      throw new TuneError('INVALID_CONNECTION', 'Routing requires an acyclic source → processor → output graph.', 'Remove the cycle or choose a processor/output target.');
    }
    if (!this.targets.has(target)) {
      if (!this.engine.adapter.hostLimits.fanOut && this.targets.size >= 1) {
        throw new TuneError('UNSUPPORTED', 'This host delivers only one outgoing connection per node.', 'Disconnect the current target first, or mix through a bus.');
      }
      if (this.host && target.input) this.host.connect(target.input);
      this.targets.add(target);
    }
    return target;
  }
  private reaches(target: GraphNode): boolean { return this === target || [...this.targets].some(node => node.reaches(target)); }
  disconnect(target?: GraphNode): void {
    this.assertAlive();
    if (target && target.engine !== this.engine) throw new TuneError('CROSS_ENGINE', 'Target belongs to another engine.', 'Use a target owned by this engine.');
    if (target) this.targets.delete(target); else this.targets.clear();
    this.reconnect();
  }
  /** @internal */ get input(): HostNode | undefined { return this.host; }
  /** @internal */ reconnect(): void {
    this.host?.disconnect();
    for (const target of this.targets) if (target.input) this.host?.connect(target.input);
  }
  /** @internal */ prepare(context: HostContext): void { void context; }
  dispose(): void {
    if (this.#disposed) return;
    if (this.kind === 'output' && this.engine.state !== 'disposed') {
      throw new TuneError('INVALID_CONNECTION', 'The output belongs to the engine.', 'Dispose the engine to release its output.');
    }
    this.#disposed = true;
    const errors: unknown[] = [];
    const host = this.host;
    this.host = undefined;
    this.targets.clear();
    this.engine.nodes.delete(this);
    if (this instanceof Gain) this.gain.bind();
    if (this instanceof Filter) this.frequencyHz.bind();
    for (const node of this.engine.nodes) {
      if (node.targets.delete(this) && this.engine.state !== 'disposed') {
        try { node.reconnect(); } catch (error) { errors.push(error); }
      }
    }
    try { host?.disconnect(); } catch (error) { errors.push(error); }
    if (errors.length) throw new TuneError('HOST_FAILURE', 'Host graph cleanup failed.', 'Dispose the engine to release remaining host resources.', { cause: new AggregateError(errors) });
  }
}
export class Gain extends GraphNode {
  readonly gain: Param;
  /** @internal */ constructor(engine: Engine, value: number) { super(engine, 'gain'); this.gain = new Param(this, value, 'linear gain', 0, 4); }
  /** @internal */ override prepare(context: HostContext): void {
    let host: HostGain | undefined;
    try {
      const gain = context.createGain(); host = gain;
      this.gain.bind(gain.gain);
      this.host = host;
    } catch (cause) {
      try { host?.disconnect(); }
      catch (cleanup) { throw new AggregateError([cause, cleanup], 'Host graph preparation and cleanup failed.'); }
      throw cause;
    }
  }
}
export class Filter extends GraphNode {
  readonly frequencyHz: Param;
  /** @internal */ constructor(engine: Engine, readonly type: 'lowpass' | 'highpass', frequency: number) {
    super(engine, 'filter'); this.frequencyHz = new Param(this, frequency, 'frequency Hz', 10, 20000);
  }
  /** @internal */ override prepare(context: HostContext): void {
    let host: HostFilter | undefined;
    try {
      const filter = context.createBiquadFilter(); host = filter;
      filter.type = this.type; filter.Q.setValueAtTime(0, this.engine.currentTime);
      this.frequencyHz.bind(filter.frequency);
      this.host = host;
    } catch (cause) {
      try { host?.disconnect(); }
      catch (cleanup) { throw new AggregateError([cause, cleanup], 'Host graph preparation and cleanup failed.'); }
      throw cause;
    }
  }
}
export class Oscillator extends GraphNode {
  #voices = new Set<Voice>();
  /** @internal */ constructor(engine: Engine, readonly frequencyHz: number, readonly wave: 'sine' | 'triangle' | 'square' | 'sawtooth') { super(engine, 'source'); }
  /** @internal */ override prepare(context: HostContext): void {
    let host: HostGain | undefined;
    try {
      const gain = context.createGain(); host = gain;
      gain.gain.setValueAtTime(1, this.engine.currentTime);
      this.host = host;
    } catch (cause) {
      try { host?.disconnect(); }
      catch (cleanup) { throw new AggregateError([cause, cleanup], 'Host graph preparation and cleanup failed.'); }
      throw cause;
    }
  }
  play(options: { duration?: Seconds } = {}): Voice {
    this.assertAlive();
    const context = this.engine.runningContext();
    const duration = options.duration && finite(options.duration.seconds, 0.001, 3600, 'duration seconds');
    let oscillator: HostOscillator | undefined;
    let voice: Voice | undefined;
    try {
      oscillator = context.createOscillator();
      oscillator.type = this.wave; oscillator.frequency.setValueAtTime(this.frequencyHz, context.currentTime);
      oscillator.connect(this.host!);
      const currentVoice = new Voice(this.engine, oscillator, () => this.#voices.delete(currentVoice));
      voice = currentVoice;
      this.#voices.add(currentVoice);
      const startFrame = this.engine.currentFrame;
      oscillator.start(this.engine.hostTimeAt(startFrame));
      if (duration !== undefined) oscillator.stop(this.engine.hostTimeAt(startFrame + Math.round(duration * context.sampleRate)));
      return currentVoice;
    } catch (cause) {
      const errors: unknown[] = [cause];
      if (voice) {
        try { voice.dispose(); } catch (error) { errors.push(error); }
      } else if (oscillator) {
        try { this.engine.adapter.setEnded(oscillator, null); } catch (error) { errors.push(error); }
        try { oscillator.disconnect(); } catch (error) { errors.push(error); }
      }
      throw new TuneError('HOST_FAILURE', 'The host could not start the oscillator.', 'Dispose the engine and reactivate output with a new engine.', { cause: errors.length === 1 ? cause : new AggregateError(errors) });
    }
  }
  override dispose(): void {
    const errors: unknown[] = [];
    for (const voice of [...this.#voices]) try { voice.dispose(); } catch (error) { errors.push(error); }
    try { super.dispose(); } catch (error) { errors.push(error); }
    if (errors.length) throw new TuneError('HOST_FAILURE', 'Host source cleanup failed.', 'Dispose the engine to release remaining host resources.', { cause: new AggregateError(errors) });
  }
}
export class Voice {
  #ended = false;
  #stopRequested = false;
  #node?: HostOscillator;
  /** @internal */ constructor(private engine: Engine, node: HostOscillator, private release: (() => void) | undefined) {
    this.#node = node;
    engine.adapter.setEnded(node, () => this.finish());
    engine.voices.add(this);
  }
  get state(): 'playing' | 'stopping' | 'ended' { return this.#ended ? 'ended' : this.#stopRequested ? 'stopping' : 'playing'; }
  stop(): void {
    if (this.#ended || this.#stopRequested) return;
    try { this.#node!.stop(this.engine.hostTimeAt(this.engine.currentFrame)); this.#stopRequested = true; }
    catch (cause) { throw new TuneError('HOST_FAILURE', 'The host could not stop the voice.', 'Dispose the voice or engine to release remaining host resources.', { cause }); }
  }
  private finish(): void {
    if (this.#ended) return;
    this.#ended = true;
    const node = this.#node!;
    const release = this.release;
    this.#node = undefined; this.release = undefined;
    this.engine.voices.delete(this);
    const errors: unknown[] = [];
    try { release?.(); } catch (error) { errors.push(error); }
    try { this.engine.adapter.setEnded(node, null); } catch (error) { errors.push(error); }
    try { node.disconnect(); } catch (error) { errors.push(error); }
    if (errors.length) throw new TuneError('HOST_FAILURE', 'Host voice cleanup failed.', 'Dispose the engine to release remaining host resources.', { cause: new AggregateError(errors) });
  }
  dispose(): void {
    if (this.#ended) return;
    const errors: unknown[] = [];
    try { this.stop(); } catch (error) { errors.push(error); }
    try { this.finish(); } catch (error) { errors.push(error); }
    if (errors.length) throw new TuneError('HOST_FAILURE', 'Host voice disposal failed.', 'Dispose the engine to release remaining host resources.', { cause: new AggregateError(errors) });
  }
}
