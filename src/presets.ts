import type { InstrumentPreset } from './instrument.js';
import type { KitPreset } from './kit.js';

export const softKeys: InstrumentPreset = Object.freeze({
  name: 'softKeys',
  layers: Object.freeze([
    Object.freeze({ wave: 'triangle', ratio: 1, level: 1 }),
    Object.freeze({ wave: 'sine', ratio: 2, level: 0.35 }),
    Object.freeze({ wave: 'sine', ratio: 1, detuneCents: 6, level: 0.4 }),
  ]),
  envelope: Object.freeze({ attack: 0.012, decay: 0.35, sustain: 0.55, release: 0.4 }),
  filter: Object.freeze({ type: 'lowpass', frequencyHz: 2400 }),
  level: 0.18,
  maxVoices: 16,
});
export const pluck: InstrumentPreset = Object.freeze({
  name: 'pluck',
  layers: Object.freeze([
    Object.freeze({ wave: 'triangle', ratio: 1, level: 1 }),
    Object.freeze({ wave: 'square', ratio: 2, level: 0.12 }),
  ]),
  envelope: Object.freeze({ attack: 0.002, decay: 0.25, sustain: 0, release: 0.08 }),
  filter: Object.freeze({ type: 'lowpass', frequencyHz: 3200 }),
  level: 0.16,
  maxVoices: 16,
});
export const softDrums: KitPreset = Object.freeze({
  name: 'softDrums',
  level: 0.5,
  maxVoices: 16,
  hits: Object.freeze({
    kick: Object.freeze({ frequencyHz: 55, layers: Object.freeze([Object.freeze({ wave: 'sine' as const, pitch: Object.freeze({ startRatio: 3, seconds: 0.05 }), level: 1 })]), envelope: Object.freeze({ attack: 0.001, decay: 0.28, sustain: 0, release: 0.05 }) }),
    snare: Object.freeze({ frequencyHz: 180, layers: Object.freeze([Object.freeze({ source: 'noise' as const, filter: Object.freeze({ type: 'highpass' as const, frequencyHz: 1800 }), level: 0.7 }), Object.freeze({ wave: 'triangle' as const, pitch: Object.freeze({ startRatio: 1.6, seconds: 0.03 }), level: 0.5 })]), envelope: Object.freeze({ attack: 0.001, decay: 0.18, sustain: 0, release: 0.05 }) }),
    hat: Object.freeze({ frequencyHz: 440, layers: Object.freeze([Object.freeze({ source: 'noise' as const, filter: Object.freeze({ type: 'highpass' as const, frequencyHz: 6000 }), level: 0.6 })]), envelope: Object.freeze({ attack: 0.001, decay: 0.06, sustain: 0, release: 0.03 }) }),
  }),
});
