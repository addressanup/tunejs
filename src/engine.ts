import type { Adapter, HostContext } from './backend.js';
import { TuneError, finite, integerFrame } from './errors.js';
import { Filter, Gain, GraphNode, Oscillator } from './graph.js';
import type { OwnedVoice } from './graph.js';
import { Instrument } from './instrument.js';
import type { InstrumentPreset } from './instrument.js';
export type EngineState = 'idle' | 'starting' | 'running' | 'suspended' | 'interrupted' | 'failed' | 'disposed';

export class Engine {
  /** @internal */ readonly nodes = new Set<GraphNode>();
  /** @internal */ readonly voices = new Set<OwnedVoice>();
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
  readonly capabilities = Object.freeze({ oscillator: true, gain: true, filter: true, instrument: true, presets: true, spatial: false, capture: false, projects: false, offline: false, backgroundPlayback: false });
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
  instrument(preset: InstrumentPreset, options: { maxVoices?: number } = {}): Instrument {
    this.assertAlive();
    return this.add(new Instrument(this, preset, options));
  }
  private add<T extends GraphNode>(node: T): T {
    try { this.materialize(node); }
    catch (cause) { throw new TuneError('HOST_FAILURE', 'The host could not prepare the graph object.', 'Dispose the engine if host cleanup failed, then retry with a new engine.', { cause }); }
    this.nodes.add(node); return node;
  }
  private materialize(node: GraphNode): void {
    if (!this.#context || node.host) return;
    node.prepare(this.#context);
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
