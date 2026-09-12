import type { Adapter, HostContext, HostTap, HostTapChunk } from '../backend.js';
import { TuneError, integerFrame } from '../errors.js';
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
  };
}
