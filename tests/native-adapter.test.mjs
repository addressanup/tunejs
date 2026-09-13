// Node simulation of the react-native-audio-api worklet path: the 'worklet' directive is inert
// here, so the callback passed to createWorkletProcessingNode is invoked directly, block by block,
// with a manually advancing currentTime — mirroring what the host's audio thread would do.
import test from 'node:test';
import assert from 'node:assert/strict';
import { nativeAdapter } from '../dist/adapters/native.js';
import { Engine } from '../dist/index.js';
import { delayFixtureExpected, dspConvolverFixtureExpected, convolverSeeds, convolverSeconds, syntheticImpulseResponse, maxError } from '../experiments/fixtures.js';

const BLOCK = 128;

function fakeWorklets() {
  const queued = [];
  return {
    queued,
    createSynchronizable(initial) {
      let value = initial;
      return { getDirty: () => value, getBlocking: () => value, setBlocking(v) { value = v; } };
    },
    scheduleOnRN(fn, ...args) { queued.push(() => fn(...args)); },
    drain() { while (queued.length) queued.shift()(); },
  };
}

function fakeContext(rate = 48000) {
  const nodes = [];
  const context = {
    sampleRate: rate,
    currentTime: 0,
    state: 'running',
    destination: { connect() {}, disconnect() {} },
    resume: () => Promise.resolve(),
    suspend: () => Promise.resolve(),
    close: () => Promise.resolve(),
    createBuffer(channels, frames) {
      return { sampleRate: rate, length: frames, numberOfChannels: channels, getChannelData: c => new Float32Array(frames) };
    },
    createBufferSource() {
      const node = { buffer: null, loop: false, loopStart: 0, loopEnd: 0, started: false, start() { this.started = true; }, stop() {}, connect(n) { this.out = n; }, disconnect() {} };
      nodes.push(node); return node;
    },
    createGain() {
      return { gain: { value: 1, setValueAtTime() {}, linearRampToValueAtTime() {}, cancelScheduledValues() {} }, connect(n) { this.out = n; }, disconnect() {} };
    },
    createWorkletProcessingNode(cb) {
      const node = { cb, connected: [], connect(n) { this.connected.push(n); }, disconnect() { this.disconnected = (this.disconnected ?? 0) + 1; } };
      nodes.push(node);
      return node;
    },
  };
  context.nodes = nodes;
  return context;
}

function makeAdapter(rate = 48000) {
  const context = fakeContext(rate);
  const worklets = fakeWorklets();
  const adapter = nativeAdapter(() => context, { worklets });
  return { context, worklets, adapter };
}

// Drive a worklet node: impulse (or train) through it, capturing both output channels.
function drive(node, context, rate, seconds, { impulse = true } = {}) {
  const total = Math.round(seconds * rate);
  const L = new Float32Array(total), R = new Float32Array(total);
  let t = 0;
  for (let frame = 0; frame < total; frame += BLOCK) {
    const ins = [new Float32Array(BLOCK)];
    if (impulse && frame === 0) ins[0][0] = 1;
    const outs = [new Float32Array(BLOCK), new Float32Array(BLOCK)];
    node.cb(ins, outs, Math.min(BLOCK, total - frame), t);
    L.set(outs[0].subarray(0, Math.min(BLOCK, total - frame)), frame);
    R.set(outs[1].subarray(0, Math.min(BLOCK, total - frame)), frame);
    t += BLOCK / rate;
  }
  return [L, R];
}

test('native dsp delay renders the fixture expectation at 48000 and 44100', async () => {
  for (const rate of [48000, 44100]) {
    const { context, adapter } = makeAdapter(rate);
    await adapter.dsp.load(context);
    const node = adapter.dsp.createDelay(context, { delayFrames: Math.round(0.01 * rate), taps: 3, feedback: 0.5 });
    node.mix.setValueAtTime(1, 0);
    const [L, R] = drive(node, context, rate, 1);
    const expected = delayFixtureExpected(rate);
    assert.ok(maxError(L, expected) <= 1e-5, `L error ${maxError(L, expected)} at ${rate}`);
    assert.ok(maxError(R, expected) <= 1e-5, `R error at ${rate}`);
  }
});

test('native dsp convolver matches dspConvolverFixtureExpected', async () => {
  for (const rate of [48000, 44100]) {
    const { context, adapter } = makeAdapter(rate);
    await adapter.dsp.load(context);
    const frames = Math.round(convolverSeconds * rate);
    const node = adapter.dsp.createConvolver(context, { response: convolverSeeds.map(seed => syntheticImpulseResponse(frames, seed)) });
    node.mix.setValueAtTime(1, 0);
    const [L, R] = drive(node, context, rate, 1);
    const expected = dspConvolverFixtureExpected(rate);
    assert.ok(maxError(L, expected[0]) <= 1e-5, `L error ${maxError(L, expected[0])} at ${rate}`);
    assert.ok(maxError(R, expected[1]) <= 1e-5, `R error at ${rate}`);
  }
});

test('native dsp registry state persists across callbacks and close() deletes it', async () => {
  const { context, adapter, worklets } = makeAdapter(48000);
  await adapter.dsp.load(context);
  const node = adapter.dsp.createDelay(context, { delayFrames: 48, taps: 1, feedback: 0.5 });
  node.mix.setValueAtTime(1, 0);
  const baseline = Object.keys(globalThis.__tunejsDsp ?? {}).length;
  drive(node, context, 48000, 0.5);
  assert.ok(Object.keys(globalThis.__tunejsDsp).length > baseline);
  node.close();
  const ins = [new Float32Array(BLOCK)], outs = [new Float32Array(BLOCK), new Float32Array(BLOCK)];
  context.nodes.find(n => n.cb).cb(ins, outs, BLOCK, 1);
  assert.ok(outs[0].every(v => v === 0));
  assert.equal(Object.keys(globalThis.__tunejsDsp).length, baseline);
  void worklets;
});

test('native dsp mix ops reach the worklet timeline', async () => {
  const { context, adapter } = makeAdapter(48000);
  await adapter.dsp.load(context);
  const node = adapter.dsp.createDelay(context, { delayFrames: 48, taps: 1, feedback: 0.5 });
  node.mix.setValueAtTime(0, 0);
  node.mix.linearRampToValueAtTime(1, 0.01);
  node.mix.cancelScheduledValues(0.005);
  node.mix.setValueAtTime(0.5, 0.02);
  // impulses at frame 0 (mix 0 → no echo) and frame 960 (mix 0.5 → echo at 1008)
  const total = 2560, L = new Float32Array(total);
  let t = 0;
  for (let frame = 0; frame < total; frame += BLOCK) {
    const ins = [new Float32Array(BLOCK)];
    if (frame === 0) ins[0][0] = 1;
    if (frame === 896) ins[0][960 - 896] = 1;
    const outs = [new Float32Array(BLOCK), new Float32Array(BLOCK)];
    context.nodes.find(n => n.cb).cb(ins, outs, BLOCK, t);
    L.set(outs[0], frame);
    t += BLOCK / 48000;
  }
  assert.equal(L[0], 1, 'dry impulse passes at mix 0');
  assert.ok(Math.abs(L[48]) < 1e-6, 'no echo while mix is 0');
  assert.ok(Math.abs(L[960] - 1) < 1e-6, 'dry at 960');
  assert.ok(Math.abs(L[1008] - 0.25) < 1e-5, `echo at 1008 got ${L[1008]}`); // feedback 0.5 × mix 0.5
});

test('native tap assembles chunks, tracks drops, flushes on close', async () => {
  const { context, worklets, adapter } = makeAdapter(48000);
  const tap = await adapter.tapping.createTap(context, { chunkFrames: 1024, inFlightChunks: 2 });
  const chunks = [];
  tap.onChunk(c => { chunks.push(c); tap.acknowledge(c.sequence); });
  const node = context.nodes.find(n => n.cb);
  let t = 0;
  for (let i = 0; i < 24; i++) { // 3072 frames → 3 chunks
    const ins = [new Float32Array(BLOCK).fill(0.25), new Float32Array(BLOCK).fill(-0.25)];
    node.cb(ins, [new Float32Array(BLOCK), new Float32Array(BLOCK)], BLOCK, t);
    t += BLOCK / 48000;
    worklets.drain();
  }
  assert.equal(chunks.length, 3);
  assert.equal(chunks[0].startFrame, 0);
  assert.equal(chunks[1].startFrame, 1024);
  assert.equal(chunks[2].startFrame, 2048);
  assert.equal(chunks[0].channels[0][0], 0.25);
  assert.equal(chunks[0].channels[1][0], -0.25);

  // withhold acks beyond inFlightChunks → drops counted on the next delivered chunk
  tap.onChunk(c => { chunks.push(c); });
  for (let i = 0; i < 40; i++) { // 5 chunks; with inFlight 2 → some dropped
    node.cb([new Float32Array(BLOCK), new Float32Array(BLOCK)], [new Float32Array(BLOCK), new Float32Array(BLOCK)], BLOCK, t);
    t += BLOCK / 48000;
  }
  worklets.drain();
  const later = chunks.slice(3);
  const delivered = later.filter(c => c.channels.length);
  assert.ok(later.some(c => c.droppedFramesBefore > 0) || delivered.length < 5, 'expected drops or deficit');
  // flush on close → zero-length chunk carrying the pending drop count
  tap.close();
  node.cb([new Float32Array(BLOCK), new Float32Array(BLOCK)], [new Float32Array(BLOCK), new Float32Array(BLOCK)], BLOCK, t);
  worklets.drain();
  const flush = chunks[chunks.length - 1];
  assert.equal(flush.channels.length, 0);
  assert.ok(flush.droppedFramesBefore >= 0);
  tap.onChunk(null);
});

test('native adapter engine integration: capabilities, materialize, dispose', async () => {
  const { context, worklets, adapter } = makeAdapter(48000);
  const engine = new Engine({ adapter });
  assert.equal(engine.capabilities.delay, true);
  assert.equal(engine.capabilities.reverb, true);
  assert.equal(engine.capabilities.taps, true);
  assert.equal(engine.capabilities.capture, false);
  const delay = engine.delay({ seconds: 0.01, taps: 2, feedback: 0.5 });
  await engine.start();
  const workletNodes = context.nodes.filter(n => n.cb);
  assert.equal(workletNodes.length, 1);
  const keepAlives = context.nodes.filter(n => n.started && n.loop);
  assert.ok(keepAlives.length >= 1, 'keep-alive source connected');
  await engine.dispose();
  assert.ok(workletNodes[0].disconnected >= 1);
  void worklets; void delay;
});

test('native adapter without worklets: no dsp, no tapping, delay() throws', () => {
  const adapter = nativeAdapter(() => fakeContext());
  const engine = new Engine({ adapter });
  assert.equal(engine.capabilities.delay, false);
  assert.equal(engine.capabilities.taps, false);
  assert.throws(() => engine.delay({ seconds: 0.1 }), e => e.code === 'UNSUPPORTED');
});

test('native dsp.load rejects UNSUPPORTED on offline contexts', async () => {
  const { adapter } = makeAdapter();
  const offline = { startRendering: () => Promise.resolve({}), createWorkletProcessingNode() {} };
  await assert.rejects(adapter.dsp.load(offline), e => e.code === 'UNSUPPORTED');
});

test('native dsp callback checks closed before creating state', async () => {
  const { context, adapter } = makeAdapter(48000);
  await adapter.dsp.load(context);
  const node = adapter.dsp.createDelay(context, { delayFrames: 48, taps: 1, feedback: 0.5 });
  const workletNode = context.nodes.find(n => n.cb);
  node.mix.setValueAtTime(1, 0);
  const ins = [new Float32Array(BLOCK)], outs = [new Float32Array(BLOCK), new Float32Array(BLOCK)];
  workletNode.cb(ins, outs, BLOCK, 0); // one real callback → state exists
  const id = Object.keys(globalThis.__tunejsDsp).at(-1);
  assert.ok(globalThis.__tunejsDsp[id]);
  // spy on effect construction inside the worklet via the cached kernel
  const realKernel = globalThis.__tunejsKernel;
  let constructions = 0;
  globalThis.__tunejsKernel = new Proxy(realKernel, {
    get(target, key) {
      const v = target[key];
      if (key === 'DelayEffect' || key === 'ConvolverEffect') {
        return class extends v { constructor(...a) { super(...a); constructions++; } };
      }
      return v;
    },
  });
  try {
    node.close();
    for (let i = 0; i < 10; i++) workletNode.cb(ins, outs, BLOCK, (i + 1) * BLOCK / 48000);
    assert.equal(Object.keys(globalThis.__tunejsDsp).includes(id), false);
    assert.equal(constructions, 0, `effect reconstructed ${constructions}× after close`);
    assert.ok(outs[0].every(v => v === 0));
  } finally { globalThis.__tunejsKernel = realKernel; }
});

test('native tap close-before-first-callback posts nothing; closed tap flushes exactly once', async () => {
  const { context, worklets, adapter } = makeAdapter(48000);
  // close before any callback: no state, no message
  const tapA = await adapter.tapping.createTap(context, { chunkFrames: 1024, inFlightChunks: 2 });
  const nodeA = context.nodes.filter(n => n.cb).at(-1);
  const msgsA = [];
  tapA.onChunk(c => msgsA.push(c));
  tapA.close();
  for (let i = 0; i < 10; i++) nodeA.cb([new Float32Array(BLOCK)], [new Float32Array(BLOCK), new Float32Array(BLOCK)], BLOCK, i * BLOCK / 48000);
  worklets.drain();
  assert.equal(msgsA.length, 0);
  assert.equal(Object.keys(globalThis.__tunejsTaps ?? {}).length, 0);

  // running tap: exactly one flush no matter how many callbacks follow close()
  const tapB = await adapter.tapping.createTap(context, { chunkFrames: 1024, inFlightChunks: 2 });
  const nodeB = context.nodes.filter(n => n.cb).at(-1);
  const msgsB = [];
  tapB.onChunk(c => msgsB.push(c));
  for (let i = 0; i < 10; i++) nodeB.cb([new Float32Array(BLOCK)], [new Float32Array(BLOCK), new Float32Array(BLOCK)], BLOCK, i * BLOCK / 48000);
  worklets.drain();
  tapB.close();
  for (let i = 0; i < 10; i++) nodeB.cb([new Float32Array(BLOCK)], [new Float32Array(BLOCK), new Float32Array(BLOCK)], BLOCK, (10 + i) * BLOCK / 48000);
  worklets.drain();
  const flushes = msgsB.filter(m => m.channels.length === 0);
  assert.equal(flushes.length, 1, `expected 1 flush, got ${flushes.length}`);
  assert.equal(Object.keys(globalThis.__tunejsTaps ?? {}).length, 0);
});

test('native tap drops consume no sequence number; sequences stay contiguous', async () => {
  const { context, worklets, adapter } = makeAdapter(48000);
  const tap = await adapter.tapping.createTap(context, { chunkFrames: 1024, inFlightChunks: 2 });
  const node = context.nodes.filter(n => n.cb).at(-1);
  const chunks = [];
  tap.onChunk(c => chunks.push(c)); // never acknowledge
  let t = 0;
  // 5 chunks worth: 2 delivered (inFlight limit), then 3 dropped
  for (let i = 0; i < 40; i++) { node.cb([new Float32Array(BLOCK), new Float32Array(BLOCK)], [new Float32Array(BLOCK), new Float32Array(BLOCK)], BLOCK, t); t += BLOCK / 48000; }
  worklets.drain();
  assert.equal(chunks.length, 2);
  assert.deepEqual(chunks.map(c => c.sequence), [0, 1]);
  // now ack everything → next delivered chunk carries droppedFramesBefore = 3*1024 and sequence 2
  tap.acknowledge(0); tap.acknowledge(1);
  for (let i = 0; i < 8; i++) { node.cb([new Float32Array(BLOCK), new Float32Array(BLOCK)], [new Float32Array(BLOCK), new Float32Array(BLOCK)], BLOCK, t); t += BLOCK / 48000; }
  worklets.drain();
  assert.equal(chunks.length, 3);
  assert.equal(chunks[2].sequence, 2, 'delivered sequences contiguous after drops');
  assert.equal(chunks[2].droppedFramesBefore, 3072);
});
