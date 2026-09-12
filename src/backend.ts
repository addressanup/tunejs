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
export interface HostOscillator extends HostNode {
  type: string; frequency: HostParam; start(seconds?: number): void; stop(seconds?: number): void;
}
export interface HostContext {
  readonly currentTime: number;
  readonly sampleRate: number;
  readonly state: string;
  readonly destination: HostNode;
  createGain(): HostGain;
  createBiquadFilter(): HostFilter;
  createOscillator(): HostOscillator;
  resume(): Promise<void>;
  suspend(): Promise<void>;
  close(): Promise<void>;
}
export interface Adapter {
  readonly name: string;
  createContext(): HostContext;
  setEnded(node: HostOscillator, callback: (() => void) | null): void;
}
