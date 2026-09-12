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
export interface Adapter {
  readonly name: string;
  /** `fanOut: false` means the host delivers only one outgoing connection per node (measured live on React Native Audio API 0.13.3, see docs/evidence/2026-09-12/live-probes). */
  readonly hostLimits: { fanOut: boolean };
  tapping?: { createTap(context: HostContext, options: { chunkFrames: number; inFlightChunks: number }): Promise<HostTap> };
  capture?(context: HostContext, options: { kind: 'microphone'; signal?: AbortSignal }): Promise<HostCapture>;
  createContext(): HostContext;
  setEnded(node: HostScheduledSource, callback: (() => void) | null): void;
  /** Seconds value at which this host's own time→frame conversion lands exactly on `frame`. */
  hostTime(frame: number, sampleRate: number): number;
}
