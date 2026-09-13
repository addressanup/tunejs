/** Internal host boundary. No host nodes appear in the creative API. */
export interface HostParam {
  value: number;
  setValueAtTime(value: number, seconds: number): unknown;
  linearRampToValueAtTime(value: number, seconds: number): unknown;
  cancelScheduledValues(seconds: number): unknown;
}
export interface HostNode {
  connect(target: HostNode): unknown;
  disconnect(): unknown;
}
/** One delivered PCM block from a host tap. `channels` are consumer-owned copies. */
export interface HostTapChunk { sequence: number; startFrame: number; channels: Float32Array[]; droppedFramesBefore: number }
/**
 * Host tap: emits chunks whose `startFrame` is the engine frame of the first sample. At most
 * `inFlightChunks` unacknowledged chunks may be in flight — beyond that the host drops the chunk and
 * adds its frames to the NEXT delivered chunk's `droppedFramesBefore`. `close()` flushes any pending
 * drop count as a final zero-length chunk before ending.
 */
export interface HostTap extends HostNode {
  onChunk(callback: ((chunk: HostTapChunk) => void) | null): void;
  acknowledge(sequence: number): void;
  close(): void;
}
/** A live capture device; `node` is the host source node, `stop()` releases the device. */
export interface HostCapture { readonly node: HostNode; stop(): void }
export interface HostGain extends HostNode { gain: HostParam }
export interface HostFilter extends HostNode { type: string; frequency: HostParam; Q: HostParam }
export interface HostBuffer {
  readonly sampleRate: number; readonly length: number; readonly numberOfChannels: number;
  copyToChannel(source: Float32Array, channel: number): unknown;
}
export interface HostScheduledSource extends HostNode {
  start(when?: number, offset?: number, duration?: number): void; stop(when?: number): void;
}
export interface HostOscillator extends HostScheduledSource {
  type: string; frequency: HostParam;
}
export interface HostBufferSource extends HostScheduledSource {
  buffer: HostBuffer | null; loop: boolean; loopStart: number; loopEnd: number; playbackRate: HostParam;
}
export interface HostPanner extends HostNode { pan: HostParam }
export interface HostDelay extends HostNode { delayTime: HostParam }
export interface HostConvolver extends HostNode { buffer: HostBuffer | null; normalize: boolean }
export interface HostContext {
  readonly currentTime: number;
  readonly sampleRate: number;
  readonly state: string;
  readonly destination: HostNode;
  createGain(): HostGain;
  createBiquadFilter(): HostFilter;
  createOscillator(): HostOscillator;
  createBuffer(channels: number, frames: number, sampleRate: number): HostBuffer;
  createBufferSource(): HostBufferSource;
  createStereoPanner(): HostPanner;
  createDelay(maxDelaySeconds: number): HostDelay;
  createConvolver(): HostConvolver;
  resume(): Promise<void>;
  suspend(): Promise<void>;
  close(): Promise<void>;
}
/**
 * A TuneJS-owned processor running on the host's audio thread (browser AudioWorklet, native worklet
 * node). One input, one output, dry path at unity plus `mix` × wet inside the node, so it never
 * needs host fan-out. `close()` releases processor state; the node is disconnected separately.
 */
export interface HostDspNode extends HostNode { readonly mix: HostParam; close(): void }
/**
 * TuneJS DSP path. `load()` installs the processor code into a context once; `Engine.start()` awaits
 * it before materializing DSP-backed nodes, so `create*` are synchronous and throw if `load()` has
 * not resolved for that context. Both processors use the same kernel as the offline renderer
 * (src/dsp.ts) so live and offline output agree sample-for-sample up to float rounding.
 */
/**
 * Decoded HRTF table handed to the binaural processor (see docs/hrtf-asset.md). Azimuth is degrees
 * clockwise from the front (90 = right); `rows[r]` holds every position of elevation row r as
 * `positions × 2 × taps` float32 (left ear then right ear per position), azimuths ascending from 0 in
 * `azimuthStepDegrees` steps; a pole row (|elevation| = 90) holds one position.
 */
export interface HrtfTable { id: string; sampleRate: number; taps: number; elevations: number[]; azimuthStepDegrees: number; rows: Float32Array[] }
/**
 * tunejs-binaural-v1 processor: mono in (stereo input is averaged), `gain` a-rate on the input,
 * `azimuth`/`elevation` read at each block start and mapped to the nearest table position; an HRIR
 * change crossfades linearly over `smoothingFrames` (weights (i+1)/N), during which further
 * changes wait; then stereo out. Same kernel offline and live.
 */
export interface HostBinauralNode extends HostNode { readonly gain: HostParam; readonly azimuth: HostParam; readonly elevation: HostParam; close(): void }
export interface HostDsp {
  load(context: HostContext): Promise<void>;
  createBinaural(context: HostContext, spec: { hrtf: HrtfTable; smoothingFrames: number }): HostBinauralNode;
  /** Feedforward echo: wet = Σ_{k=1..taps} feedback^k · x[n − k·delayFrames]; output is stereo, mono input feeds both channels. */
  createDelay(context: HostContext, spec: { delayFrames: number; taps: number; feedback: number }): HostDspNode;
  /** Convolution with `response` (1 or 2 channels at the context rate); mono input feeds both ears; output is stereo. */
  createConvolver(context: HostContext, spec: { response: Float32Array[] }): HostDspNode;
}
export interface Adapter {
  readonly name: string;
  /** `fanOut: false` means the host delivers only one outgoing connection per node (measured live on React Native Audio API 0.13.3, see docs/evidence/2026-09-12/live-probes). */
  readonly hostLimits: { fanOut: boolean };
  /** Present when the host can run TuneJS-owned processors; Delay/Reverb use it in preference to host nodes. */
  dsp?: HostDsp;
  tapping?: { createTap(context: HostContext, options: { chunkFrames: number; inFlightChunks: number }): Promise<HostTap> };
  capture?(context: HostContext, options: { kind: 'microphone'; signal?: AbortSignal }): Promise<HostCapture>;
  createContext(): HostContext;
  setEnded(node: HostScheduledSource, callback: (() => void) | null): void;
  /** Seconds value at which this host's own time→frame conversion lands exactly on `frame`. */
  hostTime(frame: number, sampleRate: number): number;
}
