// Live AudioContext graph probes, measured through an AnalyserNode with the audible output muted.
// They answer one question the offline fixtures cannot: does the live host graph sum simultaneous inputs
// and apply DelayNode delays? Simulator/emulator only; not a device-output or latency measurement.
// Version 2 adds fan-out probes (from a source and from a GainNode) and a fan-out-free delay probe, after version 1
// showed live fan-in summing correctly while the diamond-shaped delay probe lost its dry path.
export const liveProbeVersion = 2;
export const liveConstantOffset = 0.25, liveDelaySeconds = 0.01, liveTrainPeriodFrames = 4096;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function setParam(param, value, time) { param.setValueAtTime(value, time); }

// Two ConstantSourceNodes (0.25 each) → one GainNode → analyser. A summing host reads 0.5; a host that
// keeps one input reads 0.25; a host that double-counts the chosen input reads 0.75.
async function faninLive(context, mute, settleMs) {
  if(typeof context.createConstantSource !== 'function' || typeof context.createAnalyser !== 'function') return { probe:'fanin-live', status:'unavailable', reason:'ConstantSourceNode or AnalyserNode absent' };
  const now = context.currentTime;
  const analyser = context.createAnalyser(); analyser.fftSize = 2048; analyser.smoothingTimeConstant = 0;
  const sum = context.createGain(); setParam(sum.gain, 1, now);
  const a = context.createConstantSource(); setParam(a.offset, liveConstantOffset, now);
  const b = context.createConstantSource(); setParam(b.offset, liveConstantOffset, now);
  a.connect(sum); b.connect(sum); sum.connect(analyser); analyser.connect(mute);
  a.start(now); b.start(now);
  try {
    await sleep(settleMs);
    const data = new Float32Array(2048); analyser.getFloatTimeDomainData(data);
    const sorted = [...data].sort((x, y) => x - y);
    const median = sorted[1024], min = sorted[0], max = sorted[2047];
    const expected = 2 * liveConstantOffset;
    return { probe:'fanin-live', expected, median, min, max, status: Number.isFinite(median) && Math.abs(median - expected) <= 1e-3 ? 'pass' : 'fail' };
  } finally {
    a.stop(); b.stop();
    for(const node of [a, b, sum, analyser]) node.disconnect();
  }
}

// One constant source (0.25) fanned out to gain 1 and gain 0.5, both into one summing GainNode → analyser.
// Expected 0.375; a host that keeps one outgoing edge reads 0.25 or 0.125. `viaGain` inserts a unity GainNode
// between the source and the fan-out so the branching node is a GainNode instead of a source.
async function fanoutLive(context, mute, settleMs, viaGain) {
  const probe = viaGain ? 'fanout-gain-live' : 'fanout-live';
  if(typeof context.createConstantSource !== 'function' || typeof context.createAnalyser !== 'function') return { probe, status:'unavailable', reason:'ConstantSourceNode or AnalyserNode absent' };
  const now = context.currentTime;
  const analyser = context.createAnalyser(); analyser.fftSize = 2048; analyser.smoothingTimeConstant = 0;
  const source = context.createConstantSource(); setParam(source.offset, liveConstantOffset, now);
  const branch = viaGain ? context.createGain() : source; if(viaGain) { setParam(branch.gain, 1, now); source.connect(branch); }
  const a = context.createGain(); setParam(a.gain, 1, now);
  const b = context.createGain(); setParam(b.gain, 0.5, now);
  const sum = context.createGain(); setParam(sum.gain, 1, now);
  branch.connect(a); branch.connect(b); a.connect(sum); b.connect(sum); sum.connect(analyser); analyser.connect(mute);
  source.start(now);
  try {
    await sleep(settleMs);
    const data = new Float32Array(2048); analyser.getFloatTimeDomainData(data);
    const sorted = [...data].sort((x, y) => x - y);
    const median = sorted[1024], expected = liveConstantOffset * 1.5;
    return { probe, expected, median, min:sorted[0], max:sorted[2047], status: Number.isFinite(median) && Math.abs(median - expected) <= 1e-3 ? 'pass' : 'fail' };
  } finally {
    source.stop();
    for(const node of new Set([source, branch, a, b, sum, analyser])) node.disconnect();
  }
}

// Two identical looping impulse trains (period 4096 frames) started at the same time: one → dry gain 1 → mix,
// the other → DelayNode(10 ms) → gain 0.5 → mix; mix → analyser (8192-frame window). No node fans out, so this
// isolates the DelayNode: a correct host shows pairs 1 then 0.5 exactly D frames later; a zero-delay host shows 1.5.
async function delayLive(context, mute, settleMs) {
  if(typeof context.createDelay !== 'function' || typeof context.createAnalyser !== 'function') return { probe:'delay-live', status:'unavailable', reason:'DelayNode or AnalyserNode absent' };
  const rate = context.sampleRate, D = Math.round(liveDelaySeconds * rate), now = context.currentTime;
  const train = context.createBuffer(1, liveTrainPeriodFrames, rate); train.getChannelData(0)[0] = 1;
  const dryTrain = context.createBufferSource(); dryTrain.buffer = train; dryTrain.loop = true;
  const wetTrain = context.createBufferSource(); wetTrain.buffer = train; wetTrain.loop = true;
  const dry = context.createGain(); setParam(dry.gain, 1, now);
  const delay = context.createDelay(0.05); setParam(delay.delayTime, D / rate, now);
  const wet = context.createGain(); setParam(wet.gain, 0.5, now);
  const mix = context.createGain(); setParam(mix.gain, 1, now);
  const analyser = context.createAnalyser(); analyser.fftSize = 8192; analyser.smoothingTimeConstant = 0;
  dryTrain.connect(dry); dry.connect(mix); wetTrain.connect(delay); delay.connect(wet); wet.connect(mix); mix.connect(analyser); analyser.connect(mute);
  const startAt = now + 0.05;
  dryTrain.start(startAt); wetTrain.start(startAt);
  try {
    await sleep(settleMs);
    const data = new Float32Array(8192); analyser.getFloatTimeDomainData(data);
    const peaks = [];
    for(let i = 0; i < data.length; i++) if(Math.abs(data[i]) > 1e-3) peaks.push({ index:i, value:data[i] });
    const gaps = peaks.slice(1).map((peak, i) => peak.index - peaks[i].index);
    const values = [...new Set(peaks.map(peak => Number(peak.value.toFixed(3))))];
    const pairSpacing = gaps.filter(gap => gap === D).length;
    const status = !peaks.length ? 'inconclusive' : pairSpacing >= 1 && values.includes(1) && values.includes(0.5) ? 'pass' : 'fail';
    return { probe:'delay-live', expectedGapFrames:D, peakCount:peaks.length, gaps:gaps.slice(0, 8), values:values.slice(0, 6), pairSpacing, status };
  } finally {
    dryTrain.stop(); wetTrain.stop();
    for(const node of [dryTrain, wetTrain, dry, delay, wet, mix, analyser]) node.disconnect();
  }
}

export async function runLiveProbes(createContext, { settleMs = 400 } = {}) {
  if(typeof createContext !== 'function') throw new TypeError('runLiveProbes needs a createContext function.');
  const context = createContext();
  if(typeof context.resume === 'function') await context.resume();
  const results = [];
  const mute = context.createGain(); setParam(mute.gain, 0, context.currentTime); mute.connect(context.destination);
  const probes = [
    ['fanin-live', () => faninLive(context, mute, settleMs)],
    ['fanout-live', () => fanoutLive(context, mute, settleMs, false)],
    ['fanout-gain-live', () => fanoutLive(context, mute, settleMs, true)],
    ['delay-live', () => delayLive(context, mute, settleMs)],
  ];
  for(const [name, probe] of probes) {
    try { results.push(await probe()); }
    catch(error) { results.push({ probe:name, status:'error', error:String(error) }); }
  }
  mute.disconnect();
  const state = context.state;
  if(typeof context.close === 'function') await context.close();
  return { liveProbeVersion, sampleRate:context.sampleRate, stateBeforeClose:state, results, scope:'live AudioContext through an AnalyserNode with muted output; simulator/emulator graph behavior only, not device output or latency' };
}
