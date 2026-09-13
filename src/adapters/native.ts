import type { Adapter, HostBinauralNode, HostContext, HostDspNode, HostNode, HostParam, HostTap, HostTapChunk, HrtfTable } from '../backend.js';
import { TuneError, integerFrame } from '../errors.js';
import { Timeline } from '../dsp.js';
import { createDspCallback, createTapCallback } from '../worklet/native.js';

/** The slice of react-native-worklets the native DSP path uses (passed in by the host app). */
export interface NativeWorklets {
  createSynchronizable<T>(initial: T): { getDirty(): T; getBlocking(): T; setBlocking(value: T): void };
  scheduleOnRN<A extends unknown[]>(fn: (...args: A) => void, ...args: A): void;
}

type WorkletNodeFactory = (callback: (inputData: Float32Array[], outputData: Float32Array[], framesToProcess: number, currentTime: number) => void, runtime?: string) => HostNode;

// A finished scheduled source disables itself and cascades the disable downstream — without a
// permanent input the worklet node stops after its source ends and tails would be cut. A looping
// stereo silence source keeps the node enabled forever and forces channelCount = 2 (RNAA derives
// it from the input buffer: min(2, input channels)).
function keepAlive(context: HostContext, node: HostNode): { stop(): void; disconnect(): void } {
  const buffer = context.createBuffer(2, 128, context.sampleRate);
  const keep = context.createBufferSource();
  keep.buffer = buffer; keep.loop = true;
  keep.connect(node);
  keep.start(context.currentTime);
  return keep;
}

/** Experimental React Native Audio API 0.13.3 boundary. Import that package only in the host app. */
// Ids key the audio-runtime globalThis registry, which outlives any adapter — module scope keeps them unique.
let nodeSeq = 0;

export function nativeAdapter(createContext: () => HostContext, options?: { worklets?: NativeWorklets }): Adapter {
  const worklets = options?.worklets;

  const loaded = new WeakSet<HostContext>();
  function dspNode(context: HostContext, spec: Parameters<typeof createDspCallback>[1]): HostDspNode {
    if (!loaded.has(context)) {
      throw new TuneError('HOST_FAILURE', 'TuneJS DSP processors are not loaded for this context.', 'Await engine.start() before creating effects.');
    }
    const timeline = new Timeline();
    let version = 0;
    let last: { version: number; events: { t: number; v: number; ramp: boolean }[]; closed: boolean } = { version, events: [], closed: false };
    const sync = worklets!.createSynchronizable(last);
    const node = (context as unknown as { createWorkletProcessingNode: WorkletNodeFactory })
      .createWorkletProcessingNode(createDspCallback(`dsp${nodeSeq++}`, spec, sync, context.sampleRate), 'AudioRuntime');
    const keep = keepAlive(context, node);
    const push = () => { last = { version: ++version, events: timeline.events(), closed: false }; sync.setBlocking(last); };
    const mix: HostParam = {
      value: 0,
      setValueAtTime(v: number, t: number) { this.value = v; timeline.set(v, t); push(); },
      linearRampToValueAtTime(v: number, t: number) { this.value = v; timeline.ramp(v, t); push(); },
      cancelScheduledValues(t: number) { timeline.cancel(t); push(); },
    };
    const dsp = node as HostNode & HostDspNode;
    Reflect.set(dsp, 'mix', mix);
    let closed = false;
    dsp.close = () => {
      if (closed) return;
      closed = true;
      sync.setBlocking({ ...last, closed: true });
    };
    const disconnect = node.disconnect.bind(node);
    dsp.disconnect = () => {
      disconnect();
      try { keep.stop(); } catch { /* already stopped */ }
      try { keep.disconnect(); } catch { /* already detached */ }
    };
    return dsp;
  }

  // Binaural: one Synchronizable carrying three automation timelines (gain a-rate, azimuth and
  // elevation k-rate); every param op bumps the shared version and pushes all three lists.
  function binauralNode(context: HostContext, spec: { hrtf: HrtfTable; smoothingFrames: number }): HostBinauralNode {
    if (!loaded.has(context)) {
      throw new TuneError('HOST_FAILURE', 'TuneJS DSP processors are not loaded for this context.', 'Await engine.start() before creating effects.');
    }
    const gain = new Timeline(); const azimuth = new Timeline(); const elevation = new Timeline();
    let version = 0;
    let last: { version: number; gain: ReturnType<Timeline['events']>; azimuth: ReturnType<Timeline['events']>; elevation: ReturnType<Timeline['events']>; closed: boolean } = { version, gain: [], azimuth: [], elevation: [], closed: false };
    const sync = worklets!.createSynchronizable(last);
    const node = (context as unknown as { createWorkletProcessingNode: WorkletNodeFactory })
      .createWorkletProcessingNode(createDspCallback(`dsp${nodeSeq++}`, { kind: 'binaural', hrtf: spec.hrtf, smoothingFrames: spec.smoothingFrames }, sync, context.sampleRate), 'AudioRuntime');
    const keep = keepAlive(context, node);
    const push = () => { last = { version: ++version, gain: gain.events(), azimuth: azimuth.events(), elevation: elevation.events(), closed: false }; sync.setBlocking(last); };
    const param = (timeline: Timeline): HostParam => ({
      value: 0,
      setValueAtTime(v: number, t: number) { this.value = v; timeline.set(v, t); push(); },
      linearRampToValueAtTime(v: number, t: number) { this.value = v; timeline.ramp(v, t); push(); },
      cancelScheduledValues(t: number) { timeline.cancel(t); push(); },
    });
    const binaural = node as HostNode & HostBinauralNode;
    Reflect.set(binaural, 'gain', param(gain));
    Reflect.set(binaural, 'azimuth', param(azimuth));
    Reflect.set(binaural, 'elevation', param(elevation));
    let closed = false;
    binaural.close = () => {
      if (closed) return;
      closed = true;
      sync.setBlocking({ ...last, closed: true });
    };
    const disconnect = node.disconnect.bind(node);
    binaural.disconnect = () => {
      disconnect();
      try { keep.stop(); } catch { /* already stopped */ }
      try { keep.disconnect(); } catch { /* already detached */ }
    };
    return binaural;
  }

  async function createTap(context: HostContext, options: { chunkFrames: number; inFlightChunks: number }): Promise<HostTap> {
    const sync = worklets!.createSynchronizable({ acked: 0, closing: false });
    let handler: ((chunk: HostTapChunk) => void) | null = null;
    const deliver = (message: { flush?: boolean; sequence: number; startFrame: number; channels?: Float32Array[]; droppedFramesBefore: number }) => {
      handler?.(message.flush
        ? { sequence: message.sequence, startFrame: message.startFrame, channels: [], droppedFramesBefore: message.droppedFramesBefore }
        : { sequence: message.sequence, startFrame: message.startFrame, channels: message.channels ?? [], droppedFramesBefore: message.droppedFramesBefore });
    };
    const node = (context as unknown as { createWorkletProcessingNode: WorkletNodeFactory })
      .createWorkletProcessingNode(
        createTapCallback(`tap${nodeSeq++}`, options.chunkFrames, options.inFlightChunks, sync, worklets!.scheduleOnRN, deliver, context.sampleRate),
        'AudioRuntime',
      );
    const keep = keepAlive(context, node);
    // Silence output pulled through a zero gain keeps the node rendering without monitoring.
    const mute = context.createGain();
    mute.gain.setValueAtTime(0, context.currentTime);
    node.connect(mute);
    mute.connect(context.destination);
    const tap = node as HostNode & HostTap;
    tap.onChunk = (callback: ((chunk: HostTapChunk) => void) | null): void => { handler = callback; };
    tap.acknowledge = (sequence: number): void => {
      const current = sync.getDirty();
      if (sequence + 1 > current.acked) sync.setBlocking({ ...current, acked: sequence + 1 });
    };
    tap.close = (): void => { sync.setBlocking({ ...sync.getDirty(), closing: true }); };
    const disconnect = node.disconnect.bind(node);
    tap.disconnect = (): void => {
      disconnect();
      try { mute.disconnect(); } catch { /* already detached */ }
      try { keep.stop(); } catch { /* already stopped */ }
      try { keep.disconnect(); } catch { /* already detached */ }
    };
    return tap;
  }

  return {
    name: 'react-native-audio-api/0.13.3-experimental',
    // Live probes measured only one outgoing connection per node reaching the graph.
    hostLimits: { fanOut: false },
    createContext,
    // RN uses onEnded; browsers use onended. Do not silently lose voice cleanup.
    setEnded(node, callback) { Reflect.set(node, 'onEnded', callback); },
    // RN Audio API `AudioUtils.hpp timeToSampleFrame` truncates `time * sampleRate`; a quarter-frame bias keeps both truncation and nearest-rounding on the target frame (e.g. 1023/44100*44100 = 1022.9999999999999 → 1022 raw).
    hostTime(frame, sampleRate) { return (integerFrame(frame, 'frame') + 0.25) / sampleRate; },
    ...(worklets ? {
      dsp: {
        load(context: HostContext): Promise<void> {
          if (typeof (context as unknown as { createWorkletProcessingNode?: unknown }).createWorkletProcessingNode !== 'function') {
            return Promise.reject(new TuneError('UNSUPPORTED', 'This host cannot run TuneJS DSP processors.', 'Use the browser adapter or Engine.render for offline output.'));
          }
          if (typeof (context as unknown as { startRendering?: unknown }).startRendering === 'function') {
            return Promise.reject(new TuneError('UNSUPPORTED', 'Native offline contexts do not sum inputs or keep processors alive; use Engine.render for offline output.', 'Use a live AudioContext or Engine.render.'));
          }
          loaded.add(context);
          return Promise.resolve();
        },
        createDelay(context: HostContext, spec: { delayFrames: number; taps: number; feedback: number }) {
          return dspNode(context, { kind: 'delay', delayFrames: spec.delayFrames, taps: spec.taps, feedback: spec.feedback });
        },
        createConvolver(context: HostContext, spec: { response: Float32Array[] }) {
          return dspNode(context, { kind: 'convolver', response: spec.response });
        },
        createBinaural(context: HostContext, spec: { hrtf: HrtfTable; smoothingFrames: number }) {
          return binauralNode(context, spec);
        },
      },
      tapping: { createTap },
    } : {}),
  };
}
