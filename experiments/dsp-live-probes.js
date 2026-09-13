// Live-context probes for the TuneJS DSP path, observed through the adapter's own PCM tap with the
// audible output muted. They exist because the native OfflineAudioContext neither sums simultaneous
// inputs nor keeps a node alive once its only source has finished (docs/evidence/2026-09-12), so the
// fixture-version-7 dsp-* offline rows cannot judge that host. Expected values come from the same
// generators as the offline fixtures. Simulator/emulator/headless results are host-graph behavior
// only — not device output, latency or listening evidence.
import { convolverFit, convolverSeconds, convolverSeeds, delayTapCount, delayTapSeconds, dspConvolverFixtureExpected, maxError, q16, syntheticHrtfTable, syntheticImpulseResponse } from './fixtures.js';

// Version 2 adds dsp-binaural-live: the synthetic HRTF table rendered live at azimuth 90° (right).
export const dspLiveProbeVersion = 2;
export const dspTrainPeriodFrames = 8192;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// Continuous capture through a HostTap: chunks are acknowledged immediately; continuity of
// startFrame is checked so a gap in the engine-frame clock cannot pass unnoticed.
async function captureThrough(adapter, context, source, mute, seconds) {
  const tap = await adapter.tapping.createTap(context, { chunkFrames: 1024, inFlightChunks: 8 });
  const chunks = [];
  let dropped = 0, discontinuities = 0, previous = null;
  tap.onChunk(chunk => {
    dropped += chunk.droppedFramesBefore;
    if(previous && chunk.startFrame !== previous.startFrame + previous.frames + chunk.droppedFramesBefore) discontinuities += 1;
    const frames = chunk.channels[0] ? chunk.channels[0].length : 0;
    if(frames) chunks.push({ startFrame: chunk.startFrame, frames, channels: chunk.channels });
    previous = { startFrame: chunk.startFrame, frames };
    try { tap.acknowledge(chunk.sequence); } catch { /* host teardown */ }
  });
  const createdAtFrame = Math.round(context.currentTime * context.sampleRate);
  source.connect(tap); tap.connect(mute);
  try {
    await sleep(seconds * 1000);
  } finally {
    tap.onChunk(null);
    try { tap.close(); } catch { /* best effort */ }
    try { tap.disconnect(); } catch { /* best effort */ }
  }
  const total = chunks.reduce((sum, chunk) => sum + chunk.frames, 0);
  const channelCount = chunks.length ? Math.min(2, chunks[0].channels.length) : 0;
  const pcm = Array.from({ length: channelCount }, () => new Float32Array(total));
  let offset = 0;
  for(const chunk of chunks) { for(let c = 0; c < channelCount; c++) pcm[c].set(chunk.channels[Math.min(c, chunk.channels.length - 1)].subarray(0, chunk.frames), offset); offset += chunk.frames; }
  return { pcm, firstStartFrame: chunks.length ? chunks[0].startFrame : null, createdAtFrame, chunkCount: chunks.length, totalFrames: total, droppedFrames: dropped, discontinuities };
}

function peaks(data, threshold = 1e-3, limit = 64) {
  const found = [];
  for(let i = 0; i < data.length && found.length < limit; i++) if(Math.abs(data[i]) > threshold) found.push({ frame: i, value: data[i] });
  return found;
}
function channelMismatch(pcm) { return pcm.length < 2 ? null : maxError(pcm[0], pcm[1]); }

// A looping impulse train through a 3-tap TuneJS delay (mix 1): each period must show 1, 0.5, 0.25, 0.125
// spaced exactly D frames apart on both output channels.
async function delayLive(adapter, context, mute, settleSeconds) {
  const rate = context.sampleRate, D = Math.round(delayTapSeconds * rate);
  const train = context.createBuffer(1, dspTrainPeriodFrames, rate); train.getChannelData(0)[0] = 1;
  const source = context.createBufferSource(); source.buffer = train; source.loop = true;
  const node = adapter.dsp.createDelay(context, { delayFrames: D, taps: delayTapCount, feedback: 0.5 });
  node.mix.setValueAtTime(1, context.currentTime);
  source.connect(node);
  source.start(context.currentTime + 0.05);
  try {
    const capture = await captureThrough(adapter, context, node, mute, settleSeconds);
    if(!capture.pcm.length) return { probe: 'dsp-delay-live', status: 'inconclusive', reason: 'no tap chunks', capture: { ...capture, pcm: undefined } };
    const found = peaks(capture.pcm[0]);
    const groups = [];
    for(let i = 0; i + 3 < found.length; i++) {
      const gaps = [1, 2, 3].map(k => found[i + k].frame - found[i + k - 1].frame);
      const values = [0, 1, 2, 3].map(k => found[i + k].value);
      if(gaps.every(gap => gap === D)) groups.push({ frame: found[i].frame, values, valueError: Math.max(...values.map((v, k) => Math.abs(v - 0.5 ** k))) });
    }
    const valueError = groups.length ? Math.max(...groups.map(group => group.valueError)) : null;
    const mismatch = channelMismatch(capture.pcm);
    const status = groups.length >= 1 && valueError <= 1e-5 && (mismatch === null || mismatch <= 1e-6) ? 'pass' : 'fail';
    return { probe: 'dsp-delay-live', expectedGapFrames: D, expectedValues: [1, 0.5, 0.25, 0.125], peakCount: found.length, firstPeaks: found.slice(0, 8), groups: groups.slice(0, 4), groupCount: groups.length, valueError, channelMismatch: mismatch, tap: { ...capture, pcm: undefined }, status };
  } finally { try { source.stop(); } catch { /* not started */ } source.disconnect(); node.close(); node.disconnect(); }
}

// A single impulse (the source finishes after one render quantum) through the same delay: the three echoes
// arrive only if the DSP node keeps processing after its source has ended.
async function tailLive(adapter, context, mute, settleSeconds) {
  const rate = context.sampleRate, D = Math.round(delayTapSeconds * rate);
  const impulse = context.createBuffer(1, 1, rate); impulse.getChannelData(0)[0] = 1;
  const source = context.createBufferSource(); source.buffer = impulse;
  const node = adapter.dsp.createDelay(context, { delayFrames: D, taps: delayTapCount, feedback: 0.5 });
  node.mix.setValueAtTime(1, context.currentTime);
  source.connect(node);
  source.start(context.currentTime + 0.05);
  try {
    const capture = await captureThrough(adapter, context, node, mute, settleSeconds);
    if(!capture.pcm.length) return { probe: 'dsp-tail-live', status: 'inconclusive', reason: 'no tap chunks', capture: { ...capture, pcm: undefined } };
    const found = peaks(capture.pcm[0]);
    const gaps = found.slice(1).map((peak, i) => peak.frame - found[i].frame);
    const values = found.map(peak => peak.value);
    const valueError = found.length === 4 ? Math.max(...values.map((v, k) => Math.abs(v - 0.5 ** k))) : null;
    const status = found.length === 4 && gaps.every(gap => gap === D) && valueError <= 1e-5 ? 'pass' : 'fail';
    return { probe: 'dsp-tail-live', expectedGapFrames: D, peakCount: found.length, peaks: found.slice(0, 8), gaps: gaps.slice(0, 8), valueError, channelMismatch: channelMismatch(capture.pcm), tap: { ...capture, pcm: undefined }, status };
  } finally { try { source.stop(); } catch { /* finished */ } source.disconnect(); node.close(); node.disconnect(); }
}

// A single impulse through a TuneJS convolver loaded with the fixture impulse response (mix 1): from the
// dry impulse onward the capture must equal dspConvolverFixtureExpected sample-for-sample (1e-5).
async function convolverLive(adapter, context, mute, settleSeconds) {
  const rate = context.sampleRate, frames = Math.round(convolverSeconds * rate);
  const impulse = context.createBuffer(1, 1, rate); impulse.getChannelData(0)[0] = 1;
  const source = context.createBufferSource(); source.buffer = impulse;
  const node = adapter.dsp.createConvolver(context, { response: convolverSeeds.map(seed => syntheticImpulseResponse(frames, seed)) });
  node.mix.setValueAtTime(1, context.currentTime);
  source.connect(node);
  source.start(context.currentTime + 0.05);
  try {
    const capture = await captureThrough(adapter, context, node, mute, Math.max(settleSeconds, convolverSeconds + 0.4));
    if(!capture.pcm.length) return { probe: 'dsp-convolver-live', status: 'inconclusive', reason: 'no tap chunks', capture: { ...capture, pcm: undefined } };
    const expected = dspConvolverFixtureExpected(rate);
    // Threshold onset: FFT convolution can leave ~1e-16 roundoff ahead of the impulse on some kernels,
    // and the dry impulse itself is ≥ 1 − |IR[0]|, so 1e-9 separates the two unambiguously.
    const onset = capture.pcm[0].findIndex(value => Math.abs(value) > 1e-9);
    if(onset < 0 || onset + frames > capture.pcm[0].length) return { probe: 'dsp-convolver-live', status: 'inconclusive', reason: onset < 0 ? 'no onset captured' : 'capture shorter than the response', onset, tap: { ...capture, pcm: undefined } };
    const perChannel = capture.pcm.map((data, c) => {
      const segment = data.subarray(onset, onset + frames);
      return { arithmeticError: maxError(segment, expected[c].subarray(0, frames)), fit: convolverFit(segment, expected[c].subarray(0, frames)) };
    });
    const arithmeticError = Math.max(...perChannel.map(result => result.arithmeticError));
    return { probe: 'dsp-convolver-live', onsetFrame: onset, responseFrames: frames, arithmeticError, perChannel, tap: { ...capture, pcm: undefined }, status: arithmeticError <= 1e-5 ? 'pass' : 'fail' };
  } finally { try { source.stop(); } catch { /* finished */ } source.disconnect(); node.close(); node.disconnect(); }
}

// The looping train through a delay whose mix starts at 0 and is set to 1 mid-run: echoes must be absent
// before the change and present after it; the frame distance from the request to the first echo is the
// observed parameter latency of this host's TuneJS DSP path.
async function mixLive(adapter, context, mute, settleSeconds) {
  const rate = context.sampleRate, D = Math.round(delayTapSeconds * rate);
  const train = context.createBuffer(1, dspTrainPeriodFrames, rate); train.getChannelData(0)[0] = 1;
  const source = context.createBufferSource(); source.buffer = train; source.loop = true;
  const node = adapter.dsp.createDelay(context, { delayFrames: D, taps: delayTapCount, feedback: 0.5 });
  node.mix.setValueAtTime(0, context.currentTime);
  source.connect(node);
  source.start(context.currentTime + 0.05);
  let changeFrame = null;
  const change = sleep(Math.max(200, settleSeconds * 400)).then(() => { changeFrame = Math.round(context.currentTime * rate); node.mix.setValueAtTime(1, context.currentTime); });
  try {
    const capture = await captureThrough(adapter, context, node, mute, settleSeconds);
    await change;
    if(!capture.pcm.length || capture.firstStartFrame === null) return { probe: 'dsp-mix-live', status: 'inconclusive', reason: 'no tap chunks', tap: { ...capture, pcm: undefined } };
    const found = peaks(capture.pcm[0], 1e-3, 4096);
    const echoes = found.filter(peak => Math.abs(peak.value) < 0.9);
    const dryBeforeChange = found.filter(peak => capture.firstStartFrame + peak.frame < changeFrame && Math.abs(peak.value - 1) <= 1e-5).length;
    const echoesBeforeChange = echoes.filter(peak => capture.firstStartFrame + peak.frame < changeFrame).length;
    const firstEchoFrame = echoes.length ? capture.firstStartFrame + echoes[0].frame : null;
    const latencyFrames = firstEchoFrame === null ? null : firstEchoFrame - changeFrame;
    const status = dryBeforeChange >= 1 && echoesBeforeChange === 0 && echoes.length >= 3 ? 'pass' : 'fail';
    return { probe: 'dsp-mix-live', changeFrame, dryBeforeChange, echoesBeforeChange, echoesAfterChange: echoes.length, firstEchoFrame, latencyFrames, tap: { ...capture, pcm: undefined }, status, scope: 'latencyFrames is request→first observed echo on this host; it includes the train period alignment (≤ 8192 frames) and is an upper bound, not a scheduling measurement' };
  } finally { try { source.stop(); } catch { /* finished */ } source.disconnect(); node.close(); node.disconnect(); }
}

// A looping impulse train through tunejs-binaural-v1 at azimuth 90° with the synthetic table: every period must show
// the right ear's near tap q16(0.9) 4 frames after the impulse and the left ear's far tap q16(0.1) 28 frames after it.
async function binauralLive(adapter, context, mute, settleSeconds) {
  if(typeof adapter.dsp.createBinaural !== 'function') return { probe: 'dsp-binaural-live', status: 'unavailable', reason: 'adapter has no binaural node' };
  const rate = context.sampleRate;
  const train = context.createBuffer(1, dspTrainPeriodFrames, rate); train.getChannelData(0)[0] = 1;
  const source = context.createBufferSource(); source.buffer = train; source.loop = true;
  const node = adapter.dsp.createBinaural(context, { hrtf: syntheticHrtfTable(rate), smoothingFrames: 256 });
  const now = context.currentTime;
  node.gain.setValueAtTime(1, now); node.azimuth.setValueAtTime(90, now); node.elevation.setValueAtTime(0, now);
  source.connect(node);
  source.start(context.currentTime + 0.05);
  try {
    const capture = await captureThrough(adapter, context, node, mute, settleSeconds);
    if(capture.pcm.length < 2) return { probe: 'dsp-binaural-live', status: 'inconclusive', reason: 'need two tap channels', tap: { ...capture, pcm: undefined } };
    const right = peaks(capture.pcm[1]), left = peaks(capture.pcm[0]);
    const pairs = [];
    for(const near of right) { const far = left.find(peak => peak.frame === near.frame + 24); if(far) pairs.push({ frame: near.frame, right: near.value, left: far.value }); }
    const valueError = pairs.length ? Math.max(...pairs.map(pair => Math.max(Math.abs(pair.right - q16(0.9)), Math.abs(pair.left - q16(0.1))))) : null;
    const status = pairs.length >= 1 && valueError <= 1e-5 && left.length === right.length ? 'pass' : 'fail';
    return { probe: 'dsp-binaural-live', expected: { rightTapOffset: 4, leftTapOffset: 28, right: q16(0.9), left: q16(0.1) }, leftPeaks: left.slice(0, 4), rightPeaks: right.slice(0, 4), pairCount: pairs.length, valueError, tap: { ...capture, pcm: undefined }, status };
  } finally { try { source.stop(); } catch { /* finished */ } source.disconnect(); node.close(); node.disconnect(); }
}

export async function runDspLiveProbes(createContext, adapter, { settleSeconds = 1 } = {}) {
  if(typeof createContext !== 'function') throw new TypeError('runDspLiveProbes needs a createContext function.');
  if(!adapter || typeof adapter !== 'object') throw new TypeError('runDspLiveProbes needs the adapter whose dsp and tapping are under test.');
  if(!Number.isFinite(settleSeconds) || settleSeconds <= 0) throw new TypeError('settleSeconds must be a positive number.');
  if(!adapter.dsp || !adapter.tapping) return { dspLiveProbeVersion, status: 'unavailable', reason: !adapter.dsp ? 'adapter has no TuneJS DSP path' : 'adapter has no PCM tap', results: [] };
  const context = createContext();
  if(typeof context.resume === 'function') await context.resume();
  const results = [];
  try { await adapter.dsp.load(context); }
  catch(error) {
    if(typeof context.close === 'function') await context.close();
    return { dspLiveProbeVersion, sampleRate: context.sampleRate, status: error && error.code === 'UNSUPPORTED' ? 'unavailable' : 'error', reason: String(error && error.message || error), results };
  }
  const mute = context.createGain(); mute.gain.setValueAtTime(0, context.currentTime); mute.connect(context.destination);
  const probes = [
    ['dsp-delay-live', () => delayLive(adapter, context, mute, settleSeconds)],
    ['dsp-tail-live', () => tailLive(adapter, context, mute, settleSeconds)],
    ['dsp-convolver-live', () => convolverLive(adapter, context, mute, settleSeconds)],
    ['dsp-mix-live', () => mixLive(adapter, context, mute, settleSeconds)],
    ['dsp-binaural-live', () => binauralLive(adapter, context, mute, settleSeconds)],
  ];
  for(const [name, probe] of probes) {
    try { results.push(await probe()); }
    catch(error) { results.push({ probe: name, status: 'error', error: String(error && error.stack || error) }); }
  }
  mute.disconnect();
  const state = context.state;
  if(typeof context.close === 'function') await context.close();
  return { dspLiveProbeVersion, sampleRate: context.sampleRate, adapter: adapter.name, stateBeforeClose: state, results, scope: 'live context through the adapter PCM tap with muted output; host-graph behavior of the TuneJS DSP path only, not device output, latency or listening evidence' };
}
