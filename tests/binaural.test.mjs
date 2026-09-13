// Kernel acceptance: BinauralEffect must equal the fixtures' direct-convolution reference to 1e-9
// for every program at both rates, driven with the same automation() MixSources.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { BinauralEffect, BLOCK } from '../dist/dsp.js';
import { decodeHrtfAsset, hrtfTableFor } from '../dist/hrtf.js';
import { binauralKinds, binauralProgram, binauralFixtureExpected, binauralReference, binauralSmoothingFrames, syntheticHrtfTable, automation, maxError } from '../experiments/fixtures.js';

const run = (effect, input, controls, rate) => {
  const N = input.length;
  const out = [new Float64Array(N), new Float64Array(N)];
  for (let f0 = 0; f0 < N; f0 += BLOCK) {
    const frames = Math.min(BLOCK, N - f0);
    const ins = [new Float64Array(BLOCK)];
    for (let i = 0; i < frames; i++) ins[0][i] = input[f0 + i];
    const outs = [new Float64Array(BLOCK), new Float64Array(BLOCK)];
    effect.process(ins, outs, controls.gain, controls.azimuth, controls.elevation, f0 / rate, rate, frames);
    // The worklet writes Float32 output buffers; the reference stores Float32 — quantize the same way.
    for (let i = 0; i < frames; i++) { out[0][f0 + i] = Math.fround(outs[0][i]); out[1][f0 + i] = Math.fround(outs[1][i]); }
  }
  return out;
};

const controls = (program, azimuthOverride) => ({
  gain: { valueAt: automation(program.gain) },
  azimuth: { valueAt: automation(azimuthOverride ?? program.azimuth) },
  elevation: { valueAt: automation(program.elevation) },
});

for (const rate of [44100, 48000]) {
  test(`binaural kernel matches the reference at ${rate} (all programs)`, () => {
    const table = syntheticHrtfTable(rate);
    for (const kind of binauralKinds) {
      const program = binauralProgram(kind, rate);
      const effect = new BinauralEffect(table, binauralSmoothingFrames);
      const out = run(effect, program.input, controls(program), rate);
      const expected = binauralFixtureExpected(kind, rate);
      const error = Math.max(maxError(out[0], expected[0]), maxError(out[1], expected[1]));
      assert.ok(error <= 1e-9, `${kind} at ${rate}: error ${error}`);
      if (kind === 'dsp-binaural-mirror') {
        const mirrored = new BinauralEffect(table, binauralSmoothingFrames);
        const mout = run(mirrored, program.input, controls(program, program.mirrorAzimuth), rate);
        const mexpected = binauralFixtureExpected(kind, rate, program.mirrorAzimuth);
        const merror = Math.max(maxError(mout[0], mexpected[0]), maxError(mout[1], mexpected[1]));
        assert.ok(merror <= 1e-9, `mirror override error ${merror}`);
        assert.ok(Math.max(maxError(out[0], mout[1]), maxError(out[1], mout[0])) <= 1e-9, 'ear swap');
      }
    }
  });
}

test('binaural kernel on the SADIE table: finite, right ear dominant at azimuth 90', () => {
  const bytes = readFileSync('assets/hrtf/sadie2-d1-ku100-v1.tjhrtf');
  const table = hrtfTableFor(decodeHrtfAsset(bytes), 48000);
  const effect = new BinauralEffect(table, 256);
  const input = new Float64Array(48000); input[0] = 1;
  const out = run(effect, input, controls({ gain: [{ t: 0, v: 1, ramp: false }], azimuth: [{ t: 0, v: 90, ramp: false }], elevation: [{ t: 0, v: 0, ramp: false }] }), 48000);
  for (const ch of out) for (const v of ch) assert.ok(Number.isFinite(v), 'nonfinite output');
  const e = out.map(c => c.reduce((s, v) => s + v * v, 0));
  assert.ok(e[1] > 10 * e[0], `right ear should dominate at azimuth 90 (${e[0]} vs ${e[1]})`);
});
