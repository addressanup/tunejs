import type { Adapter, HostContext } from './backend.js';
import { decodeWav } from './assets.js';
import { TuneError, finite, integerFrame } from './errors.js';
import { Filter, Gain, GraphNode, Oscillator } from './graph.js';
import type { OwnedVoice, Seconds } from './graph.js';
import { Instrument } from './instrument.js';
import type { InstrumentPreset } from './instrument.js';
import { Sample } from './sample.js';
import type { SampleAsset, SampleEntry } from './sample.js';
import { Bus, Delay, Pan, Reverb, mulberry32 } from './mixing.js';
import { Kit } from './kit.js';
import type { KitPreset } from './kit.js';
import { Pattern, Transport } from './transport.js';
import type { PatternData } from './transport.js';
import { Listener, SpatialSource } from './spatial.js';
import type { SpatialSourceOptions } from './spatial.js';
import { Input, Meter, Recorder, Tap } from './capture.js';
import type { MeterTimers } from './capture.js';
import { exportProject, importProject } from './project.js';
import { renderProject } from './render.js';
import type { RenderResult } from './render.js';
import type { ProjectV1 } from './project.js';
import type { HostBuffer, HostGain } from './backend.js';
export type EngineState = 'idle' | 'starting' | 'running' | 'suspended' | 'interrupted' | 'failed' | 'disposed';

export class Engine {
  /** Deterministic TuneJS-DSP offline render of a project — identical output on every host. */
  static async render(project: ProjectV1, options: {
    range: { fromBeat: number; toBeat: number } | { fromSeconds: number; toSeconds: number };
    tail: { seconds: number };
    sampleRate: 44100 | 48000;
    resolveAsset?: (id: string) => Promise<ArrayBuffer | ArrayBufferView>;
    maxSeconds?: number;
  }): Promise<RenderResult> { return renderProject(project, options); }

  /** @internal */ readonly nodes = new Set<GraphNode>();
  /** @internal */ readonly voices = new Set<OwnedVoice>();
  readonly output: GraphNode;
  readonly transport: Transport;
  readonly listener: Listener;
  /** @internal */ readonly spatial = new Set<SpatialSource>();
  /** @internal */ readonly taps = new Set<Tap>();
  /** @internal */ readonly adapter: Adapter;
  #context?: HostContext;
  #master?: HostGain;
  #noiseBuffers = new Map<number, HostBuffer>();
  #assets = new Map<string, SampleEntry>();
  #state: EngineState = 'idle';
  #starting?: Promise<void>;
  #suspending?: Promise<void>;
  #disposing?: Promise<void>;
  constructor(options: { adapter: Adapter }) {
    this.adapter = options.adapter; this.output = new GraphNode(this, 'output'); this.output.nodeId = 'output'; this.nodes.add(this.output);
    this.transport = new Transport(this);
    this.listener = new Listener(this);
    const fanOut = this.adapter.hostLimits.fanOut;
    this.capabilities = Object.freeze({ oscillator: true, gain: true, filter: true, instrument: true, presets: true, samples: true, mixing: true, kits: true, transport: true, patterns: true, fanOut, delay: fanOut, reverb: fanOut, spatial: true, binaural: false, stereoSpatial: true, taps: !!this.adapter.tapping, capture: !!this.adapter.capture, recorder: !!this.adapter.tapping, meters: !!this.adapter.tapping, projects: true, offline: false, backgroundPlayback: false });
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
    return { state: this.state, backend: this.adapter.name, sampleRate: this.#context?.sampleRate ?? null, nodes: this.nodes.size, voices: this.voices.size, cachedAssetBytes: [...this.#assets.values()].reduce((bytes, entry) => bytes + entry.decoded.channels.reduce((total, channel) => total + channel.length, 0) * 4, 0), taps: this.taps.size, underruns: null, outputLatencySeconds: null };
  }
  readonly capabilities;
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
      // A TuneJS-owned master gain fans everything into a single destination edge — the native
      // destination silently drops fan-in edges (see docs/backend-decision.md).
      if (!this.#master) {
        const master = this.#context.createGain();
        master.gain.setValueAtTime(1, this.#context.currentTime);
        master.connect(this.#context.destination);
        this.#master = master;
      }
      this.output.host = this.#master;
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
      this.transport.pause();
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
  pattern(data: PatternData): Pattern { this.assertAlive(); return new Pattern(data); }
  exportProject() { return exportProject(this); }
  async importProject(project: unknown, options: { resolveAsset?: (id: string) => Promise<ArrayBuffer | ArrayBufferView> } = {}) { return importProject(this, project, options); }
  async tap(options: { source: GraphNode; chunkFrames?: number; maxBufferedFrames?: number }): Promise<Tap> {
    const context = this.runningContext();
    const source = options?.source;
    if (!(source instanceof GraphNode)) throw new TuneError('INVALID_VALUE', 'tap requires a graph node source.', 'Pass a node created by this engine.');
    if (source.engine !== this) throw new TuneError('CROSS_ENGINE', 'Tap source belongs to another engine.', 'Create the tap on the engine that owns the source.');
    if (source === this.output) throw new TuneError('INVALID_CONNECTION', 'The output node cannot be tapped.', 'Tap a node upstream of the output.');
    const chunkFrames = integerFrame(finite(options.chunkFrames ?? 1024, 128, 16384, 'chunk frames'), 'chunk frames');
    if (chunkFrames % 128 !== 0) throw new TuneError('INVALID_VALUE', 'chunkFrames must be a multiple of 128.', 'Use a render-quantum multiple such as 1024.');
    const maxBufferedFrames = options.maxBufferedFrames ?? Math.ceil(context.sampleRate / chunkFrames) * chunkFrames;
    if (maxBufferedFrames < chunkFrames) throw new TuneError('INVALID_VALUE', 'maxBufferedFrames must hold at least one chunk.', 'Raise maxBufferedFrames to at least chunkFrames.');
    if (!this.adapter.tapping) throw new TuneError('UNSUPPORTED', 'This host does not provide PCM taps.', 'Use the browser adapter, or wait for native tap support.');
    let hostTap;
    try { hostTap = await this.adapter.tapping.createTap(context, { chunkFrames, inFlightChunks: Math.ceil(maxBufferedFrames / chunkFrames) }); }
    catch (cause) {
      if (cause instanceof TuneError) throw cause;
      throw new TuneError('HOST_FAILURE', 'The host could not create the tap.', 'Check AudioWorklet availability, then retry.', { cause });
    }
    const tap = new Tap(this, source, hostTap, chunkFrames, maxBufferedFrames);
    source.host!.connect(hostTap);
    this.taps.add(tap);
    return tap;
  }
  async input(options: { kind: 'microphone' }, request: { signal?: AbortSignal } = {}): Promise<Input> {
    const context = this.runningContext();
    if (options?.kind !== 'microphone') throw new TuneError('INVALID_VALUE', 'input requires a known kind.', "Use { kind: 'microphone' }.");
    if (!this.adapter.capture) throw new TuneError('UNSUPPORTED', 'This host does not provide microphone capture.', 'Use the browser adapter, or wait for native capture support.');
    if (request.signal?.aborted) throw new TuneError('CANCELLED', 'The input request was aborted.', 'Retry without an aborted signal.');
    let capture;
    try { capture = await this.adapter.capture(context, { kind: 'microphone', signal: request.signal }); }
    catch (cause) {
      if (cause instanceof TuneError) throw cause;
      const name = cause instanceof Error ? cause.name : '';
      if (name === 'NotAllowedError' || name === 'SecurityError') throw new TuneError('PERMISSION_DENIED', 'Microphone permission was denied.', 'Grant microphone access in the browser or system settings.', { cause });
      if (name === 'NotFoundError' || name === 'OverconstrainedError' || name === 'NotReadableError') throw new TuneError('NO_DEVICE', 'No usable microphone was found.', 'Connect or enable a microphone, then retry.', { cause });
      if (name === 'AbortError' || request.signal?.aborted) throw new TuneError('CANCELLED', 'The input request was aborted.', 'Retry without an aborted signal.', { cause });
      throw new TuneError('HOST_FAILURE', 'The host could not open the microphone.', 'Check the device and permission settings, then retry.', { cause });
    }
    const input = new Input(this, capture);
    try { this.add(input); }
    catch (cause) { try { capture.stop(); } catch { /* best effort */ } throw cause; }
    return input;
  }
  recorder(options: { source: GraphNode; maxSeconds?: number; maxBufferedFrames?: number }): Recorder {
    this.assertAlive();
    const maxSeconds = options?.maxSeconds ?? 60;
    finite(maxSeconds, 0, 600, 'max seconds');
    if (maxSeconds <= 0) throw new TuneError('INVALID_VALUE', 'maxSeconds must exceed zero.', 'Choose a positive limit.');
    return new Recorder(this, options.source, maxSeconds, options.maxBufferedFrames);
  }
  async meter(options: { source: GraphNode; updatesPerSecond?: number }, request: { timers?: MeterTimers } = {}): Promise<Meter> {
    const updatesPerSecond = options?.updatesPerSecond ?? 30;
    if (!Number.isInteger(updatesPerSecond) || updatesPerSecond < 1 || updatesPerSecond > 60) throw new TuneError('INVALID_VALUE', 'updatesPerSecond must be an integer in [1, 60].', 'Choose a meter rate between 1 and 60 Hz.');
    const meter = new Meter(this, options.source, updatesPerSecond, request.timers);
    meter.attach(await this.tap({ source: options.source, chunkFrames: 1024 }));
    return meter;
  }
  /** @internal */ endTapsFor(node: GraphNode): void {
    for (const tap of [...this.taps]) if (tap.source === node) tap.endBy('source-disposed');
  }
  async spatialSource(options: SpatialSourceOptions): Promise<SpatialSource> {
    this.assertAlive();
    const source = this.add(new SpatialSource(this, options));
    this.spatial.add(source);
    source.evaluate(0);
    return source;
  }
  filter(options: { type?: 'lowpass' | 'highpass'; frequencyHz?: number } = {}): Filter {
    this.assertAlive(); const type = options.type ?? 'lowpass';
    if (type !== 'lowpass' && type !== 'highpass') throw new TuneError('INVALID_VALUE', 'Unknown filter type.', 'Use lowpass or highpass.');
    return this.add(new Filter(this, type, options.frequencyHz ?? 1200));
  }
  instrument(preset: InstrumentPreset, options: { maxVoices?: number } = {}): Instrument {
    this.assertAlive();
    return this.add(new Instrument(this, preset, options));
  }
  kit(preset: KitPreset, options: { maxVoices?: number } = {}): Kit {
    this.assertAlive();
    return this.add(new Kit(this, preset, options));
  }
  /** @internal */ noiseBuffer(context: HostContext): HostBuffer {
    const rate = context.sampleRate;
    let buffer = this.#noiseBuffers.get(rate);
    if (!buffer) {
      const frames = 2 * rate;
      const data = new Float32Array(frames);
      const random = mulberry32(0x4E4F4953);
      for (let i = 0; i < frames; i++) data[i] = random() * 2 - 1;
      buffer = context.createBuffer(1, frames, rate);
      buffer.copyToChannel(data, 0);
      this.#noiseBuffers.set(rate, buffer);
    }
    return buffer;
  }
  async sample(asset: SampleAsset, options: { signal?: AbortSignal } = {}): Promise<Sample> {
    this.assertAlive();
    if (typeof asset !== 'object' || asset === null || typeof asset.id !== 'string' || !asset.id) {
      throw new TuneError('INVALID_VALUE', 'sample() requires an asset with a nonempty id.', 'Pass { id, bytes } or { id, url }.');
    }
    if ((asset.bytes === undefined) === (asset.url === undefined)) {
      throw new TuneError('INVALID_VALUE', 'An asset needs exactly one of bytes or url.', 'Provide WAV bytes or a URL, not both.');
    }
    const signal = options.signal;
    const cancelled = () => new TuneError('CANCELLED', `Loading sample '${asset.id}' was cancelled.`, 'Retry with a signal that has not aborted.');
    if (signal?.aborted) throw cancelled();
    let entry = this.#assets.get(asset.id);
    if (!entry) {
      const check = () => { this.assertAlive(); if (signal?.aborted) throw cancelled(); };
      let bytes = asset.bytes;
      if (bytes === undefined) {
        if (typeof globalThis.fetch !== 'function') throw new TuneError('UNSUPPORTED', 'This host cannot fetch URL assets.', 'Pass decoded WAV bytes instead.');
        let response;
        try { response = await globalThis.fetch(asset.url!, { signal }); }
        catch (cause) {
          if (signal?.aborted) throw cancelled();
          throw new TuneError('ASSET_FAILED', `Fetching sample '${asset.id}' failed.`, 'Check the URL and network.', { cause });
        }
        check();
        if (!response.ok) throw new TuneError('ASSET_FAILED', `Fetching sample '${asset.id}' returned HTTP ${response.status}.`, 'Check the URL and asset deployment.');
        try { bytes = await response.arrayBuffer(); }
        catch (cause) {
          if (signal?.aborted) throw cancelled();
          throw new TuneError('ASSET_FAILED', `Reading sample '${asset.id}' failed.`, 'Check the URL and network.', { cause });
        }
        check();
      }
      let decoded;
      try { decoded = decodeWav(bytes); }
      catch (cause) {
        if (cause instanceof TuneError) throw new TuneError('ASSET_FAILED', `Sample '${asset.id}': ${cause.message}`, 'Provide an intact PCM WAV file.', { cause });
        throw cause;
      }
      check();
      if (!decoded.frames) throw new TuneError('ASSET_FAILED', `Sample '${asset.id}' decoded to zero frames.`, 'Provide a nonempty PCM WAV file.');
      const existing = this.#assets.get(asset.id);
      if (existing) entry = existing;
      else {
        entry = { id: asset.id, decoded, refs: new Set(), hostBuffers: new Map() };
        this.#assets.set(asset.id, entry);
      }
    }
    return this.add(new Sample(this, entry));
  }
  bus(options: { gainDb?: number } = {}): Bus {
    this.assertAlive();
    return this.add(new Bus(this, options.gainDb ?? 0));
  }
  pan(options: { pan?: number } = {}): Pan {
    this.assertAlive();
    return this.add(new Pan(this, options.pan ?? 0));
  }
  delay(options: { time?: Seconds; feedback?: number; mix?: number; taps?: number } = {}): Delay {
    this.assertAlive();
    if (!this.adapter.hostLimits.fanOut) throw new TuneError('UNSUPPORTED', 'Parallel wet/dry effects are unsupported on this host.', 'Use the browser adapter, or wait for the TuneJS DSP effect path.');
    return this.add(new Delay(this, options));
  }
  reverb(options: { decay?: Seconds; mix?: number } = {}): Reverb {
    this.assertAlive();
    if (!this.adapter.hostLimits.fanOut) throw new TuneError('UNSUPPORTED', 'Parallel wet/dry effects are unsupported on this host.', 'Use the browser adapter, or wait for the TuneJS DSP effect path.');
    return this.add(new Reverb(this, options));
  }
  clearAssets(): number {
    let released = 0;
    for (const [id, entry] of this.#assets) {
      if (!entry.refs.size) {
        released += entry.decoded.channels.reduce((total, channel) => total + channel.length, 0) * 4;
        this.#assets.delete(id);
      }
    }
    return released;
  }
  #nodeCounter = 0;
  /** @internal */ continueNodeCounter(value: number): void { if (value > this.#nodeCounter) this.#nodeCounter = value; }
  private add<T extends GraphNode>(node: T): T {
    node.nodeId = `n${++this.#nodeCounter}`;
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
    // The engine owns the master gain's disconnect, not output.dispose() — keep it single.
    const master = this.#master;
    this.#master = undefined;
    this.output.host = undefined;
    this.transport.dispose();
    for (const tap of [...this.taps]) try { tap.endBy('engine-disposed'); } catch { /* teardown best effort */ }
    this.#disposing = (async () => {
      const errors: unknown[] = [];
      for (const voice of [...this.voices]) try { voice.dispose(); } catch (error) { errors.push(error); }
      for (const node of [...this.nodes]) try { node.dispose(); } catch (error) { errors.push(error); }
      this.#assets.clear();
      this.#noiseBuffers.clear();
      try { master?.disconnect(); } catch (error) { errors.push(error); }
      try { await this.#context?.close(); } catch (error) { errors.push(error); }
      if (errors.length) throw new TuneError('HOST_FAILURE', 'Host cleanup failed.', 'Inspect the cause; the engine cannot be reused.', { cause: new AggregateError(errors) });
    })();
    return this.#disposing;
  }
}
