import { BLOCK, ConvolverEffect, DelayEffect } from '../dsp.js';
import type { MixSource } from '../dsp.js';

declare class AudioWorkletProcessor {
  constructor(options?: { processorOptions?: unknown });
  readonly port: { postMessage(message: unknown): void; onmessage: ((event: { data: unknown }) => void) | null };
}
declare function registerProcessor(name: string, ctor: new (options?: { processorOptions?: unknown }) => AudioWorkletProcessor): void;
declare const currentTime: number;
declare const sampleRate: number;

type ProcessorOptions =
  | { kind: 'delay'; delayFrames: number; taps: number; feedback: number; mix: number }
  | { kind: 'convolver'; response: ArrayLike<number>[]; mix: number };

// `mix` is a real a-rate AudioParam, not a port message: port messages are queued as tasks and
// are NOT delivered while an OfflineAudioContext renders, which would freeze the mix value.
class TuneJsDspProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors(): { name: string; defaultValue: number; minValue: number; maxValue: number; automationRate: string }[] {
    return [{ name: 'mix', defaultValue: 1, minValue: 0, maxValue: 1, automationRate: 'a-rate' }];
  }
  readonly #effect: DelayEffect | ConvolverEffect;
  readonly #ins = [new Float64Array(BLOCK), new Float64Array(BLOCK)];
  readonly #outs = [new Float64Array(BLOCK), new Float64Array(BLOCK)];
  readonly #mix: MixSource = { valueAt: (t: number): number => this.#mixAt(t) };
  #mixParam: ArrayLike<number> = [1];
  #t0 = 0;
  #closed = false;
  constructor(options?: { processorOptions?: unknown }) {
    super(options);
    const spec = options?.processorOptions as ProcessorOptions;
    this.#effect = spec.kind === 'delay'
      ? new DelayEffect(2, spec.delayFrames, spec.taps, spec.feedback)
      : new ConvolverEffect(spec.response);
    this.port.onmessage = event => {
      if ((event.data as { close?: boolean }).close) this.#closed = true;
    };
  }
  #mixAt(t: number): number {
    const p = this.#mixParam;
    const i = Math.min(BLOCK - 1, Math.max(0, Math.round((t - this.#t0) * sampleRate)));
    return p[Math.min(i, p.length - 1)]!;
  }
  process(inputs: Float32Array[][], outputs: Float32Array[][], parameters: Record<string, ArrayLike<number>>): boolean {
    if (this.#closed) return false;
    this.#t0 = currentTime;
    this.#mixParam = parameters['mix'] ?? [1];
    const input = inputs[0];
    for (let c = 0; c < 2; c++) {
      const src = input && input.length ? input[Math.min(c, input.length - 1)] : undefined;
      const work = this.#ins[c]!;
      if (src) for (let i = 0; i < BLOCK; i++) work[i] = src[i]!;
      else work.fill(0);
    }
    this.#effect.process(this.#ins, this.#outs, this.#mix, currentTime, sampleRate);
    for (let c = 0; c < 2; c++) {
      const dst = outputs[0]![c]!;
      const work = this.#outs[c]!;
      for (let i = 0; i < BLOCK; i++) dst[i] = work[i]!;
    }
    return true;
  }
}
registerProcessor('tunejs-dsp', TuneJsDspProcessor);
