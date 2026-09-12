import type { InstrumentPreset } from './instrument.js';

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
