import type { Adapter, HostBinauralNode, HostContext, HostDspNode, HostParam, HostTap, HostTapChunk, HrtfTable } from '../backend.js';
import { TuneError, integerFrame } from '../errors.js';
import { BINAURAL_PROCESSOR_NAME, DSP_PROCESSOR_NAME, DSP_PROCESSOR_SOURCE } from './dsp-worklet-source.js';
import { TAP_PROCESSOR_NAME, TAP_PROCESSOR_SOURCE } from './tap-worklet.js';

// One worklet module load per context; revoked after the module registers.
const workletLoads = new WeakMap<HostContext, Promise<void>>();
function tapModule(context: HostContext): Promise<void> {
  if (typeof (context as AudioContext).audioWorklet?.addModule !== 'function') {
    throw new TuneError('UNSUPPORTED', 'AudioWorklet is unavailable on this host.', 'Use a browser with AudioWorklet support for PCM taps.');
  }
  let load = workletLoads.get(context);
  if (!load) {
    const url = URL.createObjectURL(new Blob([TAP_PROCESSOR_SOURCE], { type: 'text/javascript' }));
    load = (context as AudioContext).audioWorklet.addModule(url).finally(() => URL.revokeObjectURL(url));
    workletLoads.set(context, load);
  }
  return load;
}

async function createTap(context: HostContext, options: { chunkFrames: number; inFlightChunks: number }): Promise<HostTap> {
  const ctx = context as AudioContext;
  await tapModule(context);
  const node = new AudioWorkletNode(ctx, TAP_PROCESSOR_NAME, {
    numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1],
    processorOptions: { chunkFrames: options.chunkFrames, inFlightChunks: options.inFlightChunks },
  });
  // The processor outputs silence into a zero gain so the node stays pulled without monitoring.
  const mute = ctx.createGain();
  mute.gain.setValueAtTime(0, ctx.currentTime);
  node.connect(mute);
  mute.connect(ctx.destination);
  const tap = node as AudioWorkletNode & HostTap;
  tap.onChunk = (callback: ((chunk: HostTapChunk) => void) | null): void => {
    tap.port.onmessage = callback
      ? (event: MessageEvent) => {
          const data = event.data as { flush?: boolean; sequence: number; startFrame: number; channels?: Float32Array[]; droppedFramesBefore: number };
          callback(data.flush
            ? { sequence: data.sequence, startFrame: data.startFrame, channels: [new Float32Array(0)], droppedFramesBefore: data.droppedFramesBefore }
            : { sequence: data.sequence, startFrame: data.startFrame, channels: data.channels ?? [], droppedFramesBefore: data.droppedFramesBefore });
        }
      : null;
  };
  tap.acknowledge = (sequence: number): void => { tap.port.postMessage({ ack: sequence }); };
  tap.close = (): void => { tap.port.postMessage({ close: true }); };
  const disconnectNode = tap.disconnect.bind(tap);
  tap.disconnect = (): void => { disconnectNode(); mute.disconnect(); };
  return tap;
}

// One TuneJS DSP module load per context; create* are synchronous and require load() resolved.
const dspLoads = new WeakMap<HostContext, Promise<void>>();
const dspReady = new WeakSet<HostContext>();
function dspNode(context: HostContext, processorOptions: unknown): HostDspNode {
  if (!dspReady.has(context)) {
    throw new TuneError('HOST_FAILURE', 'TuneJS DSP processors are not loaded for this context.', 'Await engine.start() before creating effects.');
  }
  const node = new AudioWorkletNode(context as AudioContext, DSP_PROCESSOR_NAME, {
    numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2], processorOptions,
  });
  const dsp = node as AudioWorkletNode & HostDspNode;
  // `mix` is the processor's a-rate AudioParam — port messages are not delivered while an
  // OfflineAudioContext renders, so the HostParam must be the real automation target.
  Reflect.set(dsp, 'mix', node.parameters.get('mix') as HostParam);
  dsp.close = () => { node.port.postMessage({ close: true }); };
  return dsp;
}

async function capture(context: HostContext, options: { kind: 'microphone'; signal?: AbortSignal }): Promise<{ node: globalThis.AudioNode; stop(): void }> {
  const devices = globalThis.navigator?.mediaDevices;
  if (!devices?.getUserMedia) throw new TuneError('UNSUPPORTED', 'Microphone capture is unavailable on this host.', 'Use a browser with mediaDevices.getUserMedia support.');
  if (options.signal?.aborted) { const error = new Error('aborted'); error.name = 'AbortError'; throw error; }
  const stream = await new Promise<MediaStream>((resolve, reject) => {
    const onAbort = () => { const error = new Error('aborted'); error.name = 'AbortError'; reject(error); };
    options.signal?.addEventListener('abort', onAbort, { once: true });
    devices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false }, video: false })
      .then(resolve, reject)
      .finally(() => options.signal?.removeEventListener('abort', onAbort));
  });
  if (options.signal?.aborted) {
    for (const track of stream.getTracks()) track.stop();
    const error = new Error('aborted'); error.name = 'AbortError'; throw error;
  }
  return { node: (context as AudioContext).createMediaStreamSource(stream), stop() { for (const track of stream.getTracks()) track.stop(); } };
}

/** Does not construct an AudioContext until Engine.start() is called. */
export function browserAdapter(): Adapter {
  return {
    name: 'web-audio',
    hostLimits: { fanOut: true },
    createContext() {
      if (typeof globalThis.AudioContext !== 'function') {
        throw new TuneError('UNSUPPORTED', 'Web Audio is unavailable.', 'Use a browser with AudioContext support.');
      }
      return new AudioContext({ latencyHint: 'interactive' });
    },
    setEnded(node, callback) { Reflect.set(node, 'onended', callback); },
    hostTime(frame, sampleRate) { return integerFrame(frame, 'frame') / sampleRate; },
    tapping: { createTap },
    capture,
    dsp: {
      load(context: HostContext): Promise<void> {
        const worklet = (context as AudioContext).audioWorklet;
        if (typeof worklet?.addModule !== 'function') {
          return Promise.reject(new TuneError('UNSUPPORTED', 'AudioWorklet is unavailable on this host.', 'Use a browser with AudioWorklet support for TuneJS DSP effects.'));
        }
        let load = dspLoads.get(context);
        if (!load) {
          const url = URL.createObjectURL(new Blob([DSP_PROCESSOR_SOURCE], { type: 'text/javascript' }));
          load = worklet.addModule(url).then(() => { dspReady.add(context); }).finally(() => URL.revokeObjectURL(url));
          dspLoads.set(context, load);
        }
        return load;
      },
      createDelay(context: HostContext, spec: { delayFrames: number; taps: number; feedback: number }) {
        return dspNode(context, { kind: 'delay', delayFrames: spec.delayFrames, taps: spec.taps, feedback: spec.feedback, mix: 0 });
      },
      createConvolver(context: HostContext, spec: { response: Float32Array[] }) {
        return dspNode(context, { kind: 'convolver', response: spec.response, mix: 0 });
      },
      createBinaural(context: HostContext, spec: { hrtf: HrtfTable; smoothingFrames: number }): HostBinauralNode {
        if (!dspReady.has(context)) {
          throw new TuneError('HOST_FAILURE', 'TuneJS DSP processors are not loaded for this context.', 'Await engine.start() before creating effects.');
        }
        const node = new AudioWorkletNode(context as AudioContext, BINAURAL_PROCESSOR_NAME, {
          numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2],
          processorOptions: { hrtf: spec.hrtf, smoothingFrames: spec.smoothingFrames },
        });
        const binaural = node as AudioWorkletNode & HostBinauralNode;
        // Real AudioParams — port messages are not delivered while an OfflineAudioContext renders.
        Reflect.set(binaural, 'gain', node.parameters.get('gain') as HostParam);
        Reflect.set(binaural, 'azimuth', node.parameters.get('azimuth') as HostParam);
        Reflect.set(binaural, 'elevation', node.parameters.get('elevation') as HostParam);
        binaural.close = () => { node.port.postMessage({ close: true }); };
        return binaural;
      },
    },
  };
}
