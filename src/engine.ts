import type { Adapter, HostContext, HostNode, HostParam, HostOscillator } from './backend.js';
import { TuneError, finite, integerFrame } from './errors.js';
export type EngineState = 'idle' | 'starting' | 'running' | 'suspended' | 'interrupted' | 'failed' | 'disposed';
export type Seconds = { seconds: number };

export class Param {
  #host?: HostParam;
  #from: number;
  #target: number;
  #start = 0;
  #end = 0;
  constructor(private owner: GraphNode, value: number, readonly units: string, readonly min: number, readonly max: number) {
    this.#from = this.#target = finite(value, min, max, units);
  }
  get value(): number {
    const t = this.owner.engine.currentTime;
    return this.#end <= t ? this.#target : this.#from + (this.#target - this.#from) * Math.max(0, (t - this.#start) / (this.#end - this.#start));
  }
  /** @internal */ bind(host?: HostParam): void {
    if (host) {
      const now = this.owner.engine.currentTime;
      host.setValueAtTime(this.value, now);
      if (this.#end > now) host.linearRampToValueAtTime(this.#target, this.#end);
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
    // Own the ramp calculation: avoids relying on differing native AudioParam.value semantics.
    if (this.#host) {
      this.#host.cancelScheduledValues(now);
      this.#host.setValueAtTime(current, now);
      if (duration.seconds === 0) this.#host.setValueAtTime(value, now);
      else this.#host.linearRampToValueAtTime(value, now + duration.seconds);
    }
    this.#from = current; this.#target = value; this.#start = now; this.#end = now + duration.seconds;
    return this;
  }
}

export class GraphNode {
  /** @internal */ host?: HostNode;
  /** @internal */ readonly targets = new Set<GraphNode>();
  #disposed = false;
  /** @internal */ constructor(readonly engine: Engine, readonly kind: 'source' | 'gain' | 'filter' | 'output') {}
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
      if (this.host && target.host) this.host.connect(target.host);
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
  /** @internal */ reconnect(): void {
    this.host?.disconnect();
    for (const target of this.targets) if (target.host) this.host?.connect(target.host);
  }
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
}
export class Filter extends GraphNode {
  readonly frequencyHz: Param;
  /** @internal */ constructor(engine: Engine, readonly type: 'lowpass' | 'highpass', frequency: number) {
    super(engine, 'filter'); this.frequencyHz = new Param(this, frequency, 'frequency Hz', 10, 20000);
  }
}
export class Oscillator extends GraphNode {
  #voices = new Set<Voice>();
  /** @internal */ constructor(engine: Engine, readonly frequencyHz: number, readonly wave: 'sine' | 'triangle' | 'square' | 'sawtooth') { super(engine, 'source'); }
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
export class Engine {
  /** @internal */ readonly nodes = new Set<GraphNode>();
  /** @internal */ readonly voices = new Set<Voice>();
  readonly output: GraphNode;
  /** @internal */ readonly adapter: Adapter;
  #context?: HostContext;
  #state: EngineState = 'idle';
  #starting?: Promise<void>;
  #suspending?: Promise<void>;
  #disposing?: Promise<void>;
  constructor(options: { adapter: Adapter }) {
    this.adapter = options.adapter; this.output = new GraphNode(this, 'output'); this.nodes.add(this.output);
  }
  get state(): EngineState {
    if (this.#state === 'running' && this.#context?.state !== 'running') return this.#context?.state === 'suspended' ? 'suspended' : 'interrupted';
    return this.#state;
  }
  get currentTime(): number { return this.#context?.currentTime ?? 0; }
  get sampleRate(): number | null { return this.#context?.sampleRate ?? null; }
  get currentFrame(): number { return this.#context ? Math.round(this.#context.currentTime * this.#context.sampleRate) : 0; }
  /** @internal */ hostTimeAt(frame: number): number { return this.adapter.hostTime(integerFrame(frame, 'frame'), this.#context!.sampleRate); }
  get diagnostics() {
    return { state: this.state, backend: this.adapter.name, sampleRate: this.#context?.sampleRate ?? null, nodes: this.nodes.size, voices: this.voices.size, cachedAssetBytes: 0, taps: 0, underruns: null, outputLatencySeconds: null };
  }
  readonly capabilities = Object.freeze({ oscillator: true, gain: true, filter: true, spatial: false, capture: false, projects: false, offline: false, backgroundPlayback: false });
  /** @internal */ assertAlive(): void { if (this.#state === 'disposed') throw new TuneError('DISPOSED', 'Engine is disposed.', 'Create a new engine.'); }
  /** @internal */ runningContext(): HostContext {
    this.assertAlive();
    if (this.state !== 'running' || this.#suspending) throw new TuneError('NOT_RUNNING', 'Output is not running.', 'Call and await engine.start() from a user gesture.');
    return this.#context!;
  }
  start(): Promise<void> {
    try {
      this.assertAlive();
      if (this.#suspending) return Promise.reject(new TuneError('NOT_RUNNING', 'Output is being suspended.', 'Wait for suspend(), then activate output again.'));
      if (this.#starting) return this.#starting;
      if (this.state === 'running') return Promise.resolve();
      this.#state = 'starting';
      if (!this.#context) {
        this.#context = this.adapter.createContext();
      }
      this.output.host = this.#context.destination;
      for (const node of this.nodes) this.materialize(node);
      for (const node of this.nodes) if (node !== this.output) node.reconnect();
      // Must be invoked synchronously in the caller's gesture, before any await.
      const activation = this.#context.resume();
      this.#starting = activation.then(() => {
        this.assertAlive();
        if (this.#context?.state !== 'running') throw new Error(`Host remained ${this.#context?.state}`);
        this.#state = 'running';
      }).catch(cause => {
        if (this.#state === 'disposed') throw new TuneError('DISPOSED', 'Engine disposed during activation.', 'Create a new engine.', { cause });
        this.#state = 'failed';
        throw new TuneError('ACTIVATION_FAILED', 'Could not activate audio output.', 'Retry from a user gesture; check audio route and host permissions.', { cause });
      }).finally(() => { this.#starting = undefined; });
      return this.#starting;
    } catch (cause) {
      if (this.#state !== 'disposed') this.#state = 'failed';
      return Promise.reject(cause instanceof TuneError ? cause : new TuneError('ACTIVATION_FAILED', 'Could not prepare audio output.', 'Dispose this engine and retry with a new one.', { cause }));
    }
  }
  suspend(): Promise<void> {
    try { this.assertAlive(); } catch (error) { return Promise.reject(error); }
    if (this.#suspending) return this.#suspending;
    this.#suspending = (async () => {
      await this.#starting; this.assertAlive();
      const errors: unknown[] = [];
      for (const voice of [...this.voices]) try { voice.dispose(); } catch (error) { errors.push(error); }
      try { await this.#context?.suspend(); this.assertAlive(); this.#state = 'suspended'; } catch (error) { this.assertAlive(); this.#state = 'failed'; errors.push(error); }
      this.assertAlive();
      if (errors.length) throw new TuneError('HOST_FAILURE', 'Host suspension or voice cleanup failed.', 'Dispose the engine if cleanup failed; otherwise retry activation from a user gesture.', { cause: new AggregateError(errors) });
    })().finally(() => { this.#suspending = undefined; });
    return this.#suspending;
  }
  oscillator(options: { frequencyHz?: number; wave?: 'sine' | 'triangle' | 'square' | 'sawtooth' } = {}): Oscillator {
    this.assertAlive();
    const frequency = finite(options.frequencyHz ?? 440, 1, 20000, 'frequency Hz');
    const wave = options.wave ?? 'sine';
    if (!['sine', 'triangle', 'square', 'sawtooth'].includes(wave)) throw new TuneError('INVALID_VALUE', 'Unknown oscillator wave.', 'Use sine, triangle, square, or sawtooth.');
    return this.add(new Oscillator(this, frequency, wave));
  }
  gain(options: { gain?: number } = {}): Gain { this.assertAlive(); return this.add(new Gain(this, options.gain ?? 0.1)); }
  filter(options: { type?: 'lowpass' | 'highpass'; frequencyHz?: number } = {}): Filter {
    this.assertAlive(); const type = options.type ?? 'lowpass';
    if (type !== 'lowpass' && type !== 'highpass') throw new TuneError('INVALID_VALUE', 'Unknown filter type.', 'Use lowpass or highpass.');
    return this.add(new Filter(this, type, options.frequencyHz ?? 1200));
  }
  private add<T extends GraphNode>(node: T): T {
    try { this.materialize(node); }
    catch (cause) { throw new TuneError('HOST_FAILURE', 'The host could not prepare the graph object.', 'Dispose the engine if host cleanup failed, then retry with a new engine.', { cause }); }
    this.nodes.add(node); return node;
  }
  private materialize(node: GraphNode): void {
    if (!this.#context || node.host) return;
    let host: HostNode | undefined;
    try {
      if (node instanceof Filter) {
        const filter = this.#context.createBiquadFilter(); host = filter;
        filter.type = node.type; filter.Q.setValueAtTime(0, this.currentTime);
        node.frequencyHz.bind(filter.frequency);
      } else if (node instanceof Gain || node instanceof Oscillator) {
        const gain = this.#context.createGain(); host = gain;
        if (node instanceof Gain) node.gain.bind(gain.gain); else gain.gain.setValueAtTime(1, this.currentTime);
      }
      node.host = host;
    } catch (cause) {
      try { host?.disconnect(); }
      catch (cleanup) { throw new AggregateError([cause, cleanup], 'Host graph preparation and cleanup failed.'); }
      throw cause;
    }
  }
  dispose(): Promise<void> {
    if (this.#disposing) return this.#disposing;
    this.#state = 'disposed';
    this.#disposing = (async () => {
      const errors: unknown[] = [];
      for (const voice of [...this.voices]) try { voice.dispose(); } catch (error) { errors.push(error); }
      for (const node of [...this.nodes]) try { node.dispose(); } catch (error) { errors.push(error); }
      try { await this.#context?.close(); } catch (error) { errors.push(error); }
      if (errors.length) throw new TuneError('HOST_FAILURE', 'Host cleanup failed.', 'Inspect the cause; the engine cannot be reused.', { cause: new AggregateError(errors) });
    })();
    return this.#disposing;
  }
}
