import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { decodeHrtfAsset, encodeHrtfAsset, fnv1a64Bytes, hrtfTableFor } from '../dist/hrtf.js';
import { TuneError, Engine } from '../dist/index.js';
import { nativeAdapter } from '../dist/adapters/native.js';

const code = expected => error => error instanceof TuneError && error.code === expected;

// A small synthetic header + tables written with the same writer the prepare script uses.
function syntheticAsset() {
  const header = {
    format: 'tunejs-hrtf', version: 1, id: 'test-hrtf',
    azimuthConvention: 'clockwise-from-front-degrees',
    elevations: [-90, 0, 90], azimuthStepDegrees: 180, poles: 'single',
    taps: 4, sampleFormat: 'int16', rates: [44100],
    positions: 1 + 2 + 1, // poles 1 each, middle row 2 positions
    layout: 'test', peak: 0.5, source: { dataset: 'test' }, conversion: 'test',
  };
  const tables = new Map();
  tables.set(44100, {
    id: 'test-hrtf', sampleRate: 44100, taps: 4, elevations: [-90, 0, 90], azimuthStepDegrees: 180,
    rows: [
      Float32Array.from([0.5, -0.5, 0.25, -0.25, 0.1, 0.2, 0.3, 0.4]),            // 1 pos × 2 × 4
      Float32Array.from([1, 0, 0, 0, 0, 0, 0, 0, 0, 0.5, 0, 0, 0, 0, 0, 0.25]), // 2 pos × 2 × 4
      Float32Array.from({length:8}, () => 0.125),
    ],
  });
  return { header, tables, bytes: encodeHrtfAsset(header, tables) };
}

test('hrtf asset encode/decode round-trips', () => {
  const { header, bytes } = syntheticAsset();
  const asset = decodeHrtfAsset(bytes);
  assert.equal(asset.id, 'test-hrtf');
  assert.equal(asset.integrity, fnv1a64Bytes(bytes));
  assert.equal(asset.header.taps, 4);
  const table = asset.tables.get(44100);
  assert.equal(table.rows.length, 3);
  assert.equal(table.rows[1].length, 2 * 2 * 4);
  assert.ok(Math.abs(table.rows[0][0] - 0.5) < 1e-4, `int16 round-trip ${table.rows[0][0]}`);
  assert.ok(Math.abs(table.rows[1][9] - 0.5) < 1e-4);
});

test('hrtf decode rejects corrupt inputs', () => {
  const { header, bytes } = syntheticAsset();
  // Hand-assembled bytes so deliberately-invalid headers reach the decoder (the encoder refuses them).
  const raw = (h) => {
    const json = new TextEncoder().encode(JSON.stringify(h));
    let positions = 0;
    try { positions = (h.elevations ?? []).reduce((n, el) => n + (Math.abs(el) === 90 ? 1 : 360 / (h.azimuthStepDegrees || 1)), 0); } catch { positions = 0; }
    const body = Math.max(0, Math.round(positions)) * 2 * (h.taps | 0) * ((h.rates ?? []).length | 0);
    const b = new Uint8Array(12 + json.length + body * 2);
    for (let i = 0; i < 8; i++) b[i] = 'TJHRTF01'.charCodeAt(i);
    new DataView(b.buffer).setUint32(8, json.length, true);
    b.set(json, 12);
    return b;
  };
  const corrupt = (mutate) => { const b = bytes.slice(); mutate(b); return b; };
  assert.throws(() => decodeHrtfAsset(new Uint8Array(8)), code('ASSET_FAILED'));
  assert.throws(() => decodeHrtfAsset(corrupt(b => { b[0] = 0x58; })), code('ASSET_FAILED')); // magic
  assert.throws(() => decodeHrtfAsset(corrupt(b => { new DataView(b.buffer).setUint32(8, 1 << 30, true); })), code('ASSET_FAILED')); // header length
  for (const [field, value] of [
    ['format', 'other'], ['version', 2], ['id', ''], ['azimuthStepDegrees', 7],
    ['poles', 'dual'], ['taps', 0], ['sampleFormat', 'float32'], ['rates', []],
  ]) {
    assert.throws(() => decodeHrtfAsset(raw({ ...header, [field]: value })), code('ASSET_FAILED'), field);
  }
  for (const field of Object.keys(header)) {
    const bad = { ...header }; delete bad[field];
    assert.throws(() => decodeHrtfAsset(raw(bad)), code('ASSET_FAILED'), `missing ${field}`);
  }
  assert.throws(() => decodeHrtfAsset(raw({ ...header, elevations: [90, 0, -90] })), code('ASSET_FAILED'), 'non-monotonic elevations');
  assert.throws(() => decodeHrtfAsset(raw({ ...header, positions: 99 })), code('ASSET_FAILED'), 'layout mismatch');
  assert.throws(() => decodeHrtfAsset(bytes.slice(0, bytes.length - 2)), code('ASSET_FAILED'), 'truncated body');
});

test('hrtfTableFor selects by rate and rejects others', () => {
  const { bytes } = syntheticAsset();
  const asset = decodeHrtfAsset(bytes);
  assert.equal(hrtfTableFor(asset, 44100).sampleRate, 44100);
  assert.throws(() => hrtfTableFor(asset, 48000), code('UNSUPPORTED'));
});

test('committed SADIE asset: structure, integrity, direction sanity', () => {
  const bytes = readFileSync('assets/hrtf/sadie2-d1-ku100-v1.tjhrtf');
  const meta = JSON.parse(readFileSync('assets/hrtf/sadie2-d1-ku100-v1.integrity.json', 'utf8'));
  assert.equal(fnv1a64Bytes(bytes), meta.integrity);
  assert.equal(bytes.length, meta.bytes);
  const asset = decodeHrtfAsset(bytes);
  assert.equal(asset.header.positions, 794);
  assert.equal(asset.header.taps, 256);
  assert.deepEqual(asset.header.rates, [44100, 48000]);
  assert.ok(asset.header.peak > 0.9 && asset.header.peak <= 1, `peak ${asset.header.peak}`);
  const t = hrtfTableFor(asset, 48000);
  const taps = t.taps, rowIndex = t.elevations.indexOf(0);
  const hrir = (azIndex) => t.rows[rowIndex].subarray(azIndex * 2 * taps, azIndex * 2 * taps + 2 * taps);
  const energy = (h) => h.reduce((s, v) => s + v * v, 0);
  // azimuth 270 = left → left ear dominant; 90 = right; 0 = front ≈ symmetric
  const idx = az => Math.round(az / t.azimuthStepDegrees) % (360 / t.azimuthStepDegrees);
  assert.ok(energy(hrir(idx(270)).subarray(0, taps)) > 10 * energy(hrir(idx(270)).subarray(taps)), 'az270 left dominant');
  assert.ok(energy(hrir(idx(90)).subarray(taps)) > 10 * energy(hrir(idx(90)).subarray(0, taps)), 'az90 right dominant');
  // Level terms (sqrt of energy): D1's front measurement is genuinely asymmetric in energy.
  const rmsL = Math.sqrt(energy(hrir(0).subarray(0, taps))), rmsR = Math.sqrt(energy(hrir(0).subarray(taps)));
  assert.ok(Math.abs(rmsL - rmsR) / Math.max(rmsL, rmsR) < 0.2, `az0 ears within 20% (rms ${rmsL.toFixed(3)} vs ${rmsR.toFixed(3)})`);
  // ITD: left-ear peak leads the right at azimuth 270
  const argmax = h => { let m = 0; for (let i = 1; i < h.length; i++) if (Math.abs(h[i]) > Math.abs(h[m])) m = i; return m; };
  const left270 = hrir(idx(270)).subarray(0, taps), right270 = hrir(idx(270)).subarray(taps);
  assert.ok(argmax(right270) - argmax(left270) >= 30, `ITD lead ${argmax(right270) - argmax(left270)} frames`);
});

function dspAdapter() {
  const worklets = {
    createSynchronizable(v) { let s = v; return { getDirty: () => s, getBlocking: () => s, setBlocking(n) { s = n; } }; },
    scheduleOnRN() {},
  };
  const ctx = { sampleRate: 48000, currentTime: 0, state: 'running', destination: {}, createWorkletProcessingNode: (cb) => ({ cb, connect() {}, disconnect() {} }), createBuffer: () => ({}), createBufferSource: () => ({ connect() {}, start() {}, stop() {}, disconnect() {}, set loop(v) {} }), createGain: () => ({ gain: {}, connect() {}, disconnect() {} }) };
  return { adapter: nativeAdapter(() => ctx, { worklets }), ctx };
}

test('engine.loadHrtf: bytes, cache, refcount, dispose', async () => {
  const { bytes } = syntheticAsset();
  const { adapter } = dspAdapter();
  const engine = new Engine({ adapter });
  const a = await engine.loadHrtf({ bytes });
  assert.equal(a.id, 'test-hrtf');
  const before = engine.diagnostics.cachedAssetBytes;
  assert.ok(before > 0);
  assert.equal(await engine.loadHrtf({ bytes }), a, 'cached by id');
  assert.equal(engine.diagnostics.cachedAssetBytes, before, 'no double count');
  // refcounted while a spatial source references it
  const src = await engine.spatialSource({ rendering: 'binaural', hrtf: a });
  engine.clearAssets();
  assert.equal(engine.diagnostics.cachedAssetBytes, before, 'referenced asset survives clearAssets');
  src.dispose();
  const released = engine.clearAssets();
  assert.equal(released, before, 'released once unreferenced');
  assert.equal(engine.diagnostics.cachedAssetBytes, 0);
  await engine.loadHrtf({ bytes });
  await engine.dispose();
  assert.equal(engine.diagnostics.cachedAssetBytes, 0);
});

test('engine.loadHrtf: validation, url fetch, cancellation', async () => {
  const { adapter } = dspAdapter();
  const engine = new Engine({ adapter });
  const { bytes } = syntheticAsset();
  await assert.rejects(engine.loadHrtf({}), code('INVALID_VALUE'));
  await assert.rejects(engine.loadHrtf({ bytes, url: 'x' }), code('INVALID_VALUE'));
  await assert.rejects(engine.loadHrtf({ bytes: new Uint8Array(4) }), code('ASSET_FAILED'));
  const ac = new AbortController(); ac.abort();
  await assert.rejects(engine.loadHrtf({ bytes, signal: ac.signal }), code('CANCELLED'));
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) });
  try {
    const a = await engine.loadHrtf({ url: 'https://example.test/h.tjhrtf' });
    assert.equal(a.id, 'test-hrtf');
  } finally { globalThis.fetch = realFetch; }
  await engine.dispose();
});

test('project export/import round trip with a binaural source', async () => {
  const { bytes } = syntheticAsset();
  const { adapter } = dspAdapter();
  const engine = new Engine({ adapter });
  const hrtf = await engine.loadHrtf({ bytes });
  const osc = engine.oscillator();
  const src = await engine.spatialSource({ rendering: 'binaural', hrtf, position: { x: 1, y: 0, z: 0 } });
  osc.connect(src).connect(engine.output);
  const { project } = engine.exportProject();
  const def = project.nodes.find(n => n.type === 'spatial');
  assert.equal(def.renderer, 'tunejs-binaural-v1');
  assert.equal(def.rendering, 'binaural');
  assert.equal(def.hrtf.id, 'test-hrtf');
  const manifest = project.assets.find(a2 => a2.kind === 'hrtf');
  assert.equal(manifest.id, 'test-hrtf');
  assert.equal(manifest.integrity, fnv1a64Bytes(bytes));
  assert.deepEqual(manifest.rates, [44100]);
  const e2 = new Engine({ adapter });
  const { nodes } = await e2.importProject(project, { resolveAsset: async () => bytes });
  assert.equal(nodes.get(def.id).rendering, 'binaural');
  // missing manifest entry → checkProject problem
  const broken = JSON.parse(JSON.stringify(project));
  broken.assets = broken.assets.filter(a2 => a2.kind !== 'hrtf');
  await assert.rejects(e2.importProject(broken, { resolveAsset: async () => bytes }), code('PROJECT_INVALID'));
  // integrity mismatch → ASSET_FAILED
  const corrupt = bytes.slice(); corrupt[corrupt.length - 1] ^= 0xff;
  await assert.rejects(e2.importProject(project, { resolveAsset: async () => corrupt }), code('ASSET_FAILED'));
  // older document without kind still imports
  const older = JSON.parse(JSON.stringify(project));
  for (const a3 of older.assets) delete a3.kind;
  const e3 = new Engine({ adapter });
  await e3.importProject(older, { resolveAsset: async () => bytes });
  await e3.dispose();
  await e2.dispose();
  await engine.dispose();
});
