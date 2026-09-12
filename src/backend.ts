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
  resume(): Promise<void>;
  suspend(): Promise<void>;
  close(): Promise<void>;
}
export interface Adapter {
  readonly name: string;
  createContext(): HostContext;
  setEnded(node: HostScheduledSource, callback: (() => void) | null): void;
  /** Seconds value at which this host's own time→frame conversion lands exactly on `frame`. */
  hostTime(frame: number, sampleRate: number): number;
}
