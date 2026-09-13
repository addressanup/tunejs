// Worklet callback factories for the native DSP path (react-native-audio-api WorkletProcessingNode
// on the 'AudioRuntime'). Each returned function is a 'worklet'; it captures only serializable
// values (kernel worklet, id, spec, Synchronizable, sampleRate, delivery fns). Per-node state lives
// in a registry on the audio runtime's globalThis because captured objects are cloned, not shared.
import { tunejsNativeKernel } from './native-kernel.js';

/* eslint-disable @typescript-eslint/no-explicit-any */
type SyncCell<T> = { getDirty(): T; getBlocking(): T };
type DspSync = { version: number; events: { t: number; v: number; ramp: boolean }[]; closed: boolean };
type DspSpec =
  | { kind: 'delay'; delayFrames: number; taps: number; feedback: number }
  | { kind: 'convolver'; response: ArrayLike<number>[] };

export function createDspCallback(id: string, spec: DspSpec, sync: SyncCell<DspSync>, sampleRate: number) {
  return (inputData: Float32Array[], outputData: Float32Array[], framesToProcess: number, currentTime: number): void => {
    'worklet';
    const g = globalThis as any;
    const kernel = (g.__tunejsKernel ??= tunejsNativeKernel());
    const registry = (g.__tunejsDsp ??= {});
    const p = sync.getDirty();
    if (p.closed) {
      // Check before state creation — after close() the node keeps being pulled until disconnect,
      // and we must not reconstruct the effect every quantum just to delete it again.
      for (const dst of outputData) dst?.fill(0);
      delete registry[id];
      return;
    }
    let state = registry[id];
    if (!state) {
      state = registry[id] = {
        version: -1,
        timeline: new kernel.Timeline(),
        effect: spec.kind === 'delay'
          ? new kernel.DelayEffect(2, spec.delayFrames, spec.taps, spec.feedback)
          : new kernel.ConvolverEffect(spec.response),
        ins: [new Float64Array(kernel.BLOCK), new Float64Array(kernel.BLOCK)],
        outs: [new Float64Array(kernel.BLOCK), new Float64Array(kernel.BLOCK)],
      };
    }
    if (p.version !== state.version) { state.timeline.load(p.events); state.version = p.version; }
    for (let c = 0; c < 2; c++) {
      const src = inputData[Math.min(c, inputData.length - 1)];
      const work = state.ins[c];
      if (src) for (let i = 0; i < framesToProcess; i++) work[i] = src[i];
      else work.fill(0, 0, framesToProcess);
    }
    state.effect.process(state.ins, state.outs, state.timeline, currentTime, sampleRate, framesToProcess);
    for (let c = 0; c < outputData.length; c++) {
      const dst = outputData[c]!;
      const work = state.outs[c]!;
      for (let i = 0; i < framesToProcess; i++) dst[i] = work[i];
    }
  };
}

type TapSync = { acked: number; closing: boolean };
type TapMessage =
  | { flush?: false; sequence: number; startFrame: number; channels: Float32Array[]; droppedFramesBefore: number }
  | { flush: true; sequence: number; startFrame: number; droppedFramesBefore: number };

// Chunks are always 2 channels on this host — the keep-alive stereo silence forces channelCount=2.
export function createTapCallback(
  id: string,
  chunkFrames: number,
  inFlightChunks: number,
  sync: SyncCell<TapSync>,
  post: (fn: (message: TapMessage) => void, message: TapMessage) => void,
  deliver: (message: TapMessage) => void,
  sampleRate: number,
) {
  return (inputData: Float32Array[], outputData: Float32Array[], framesToProcess: number, currentTime: number): void => {
    'worklet';
    const g = globalThis as any;
    const registry = (g.__tunejsTaps ??= {});
    // The tap's output is silence — the engine mutes it downstream anyway.
    for (const dst of outputData) dst?.fill(0);
    const p = sync.getDirty();
    let state = registry[id];
    if (p.closing) {
      // Exactly one flush, and only if this node ever produced state — checked before creation so
      // a tap closed before its first callback posts nothing and allocates nothing.
      if (state) {
        post(deliver, { flush: true, sequence: state.sequence, startFrame: state.startFrame, droppedFramesBefore: state.dropped });
        delete registry[id];
      }
      return;
    }
    if (!state) {
      // Producer-side engine-frame origin: the first callback's currentTime, in frames.
      state = registry[id] = {
        bufs: [new Float32Array(chunkFrames), new Float32Array(chunkFrames)],
        fill: 0, startFrame: Math.round(currentTime * sampleRate), sequence: 0, dropped: 0,
      };
    }
    let offset = 0;
    while (offset < framesToProcess) {
      const n = Math.min(chunkFrames - state.fill, framesToProcess - offset);
      for (let c = 0; c < 2; c++) {
        const src = inputData[Math.min(c, inputData.length - 1)];
        const dst = state.bufs[c];
        for (let i = 0; i < n; i++) dst[state.fill + i] = src ? src[offset + i] : 0;
      }
      state.fill += n;
      offset += n;
      if (state.fill === chunkFrames) {
        // Drop parity with the browser tap: a dropped chunk consumes no sequence number, so
        // delivered sequences stay contiguous and sequence - acked measures true in-flight count.
        if (state.sequence - p.acked >= inFlightChunks) {
          state.dropped += state.fill;
        } else {
          post(deliver, {
            sequence: state.sequence, startFrame: state.startFrame,
            channels: [state.bufs[0].slice(), state.bufs[1].slice()],
            droppedFramesBefore: state.dropped,
          });
          state.dropped = 0;
          state.sequence++;
        }
        state.startFrame += state.fill;
        state.fill = 0;
      }
    }
  };
}
