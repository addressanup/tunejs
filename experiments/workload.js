// Reference workload from docs/first-release-spec.md ("Reference workload and correctness checks"), shared by
// browser, Electron and (later) native runs. Eight active voices: four looping mono sample voices through stereo
// spatial emitters and four envelope voices from one instrument through a shared filter/delay bus; listener and
// emitter motion at 60 control updates per second; meter reads at 30 Hz; a 100 ms busy period on the JS thread
// once per second. It reports engine-side accounting only — late/skipped transport events, tap drops, errors,
// voice counts and engine-clock progress. Hosts expose no underrun counter, so "no dropouts" is NOT concluded
// from this alone; listening or loopback capture is a separate step. Binaural mode is not available yet, so only
// the stereo variant runs.
import { Engine } from 'tunejs';
import { softKeys } from 'tunejs/presets';
import { wavBytes } from './workload-wav.js';

export const workloadVersion = 1;

export async function runWorkload(adapter, { seconds = 600, busyMs = 100, poseHz = 60, meterHz = 30, sampleEvery = 10, now = () => performance.now(), onSample } = {}) {
  const engine = new Engine({ adapter });
  await engine.start();
  const rate = engine.sampleRate;
  const emitters = [];
  for (let i = 0; i < 4; i++) {
    const sample = await engine.sample({ id: `loop-${i}`, bytes: wavBytes(rate, 1, 110 * (i + 2), 0.2) });
    const emitter = await engine.spatialSource({ rendering: 'stereo', position: { x: Math.cos(i * Math.PI / 2) * 3, y: 0, z: Math.sin(i * Math.PI / 2) * 3 } });
    sample.connect(emitter).connect(engine.output);
    emitters.push({ sample, emitter, voice: sample.play({ loop: true }), phase: i * Math.PI / 2 });
  }
  const keys = engine.instrument(softKeys);
  const bus = engine.capabilities.delay ? engine.delay({ time: { seconds: 0.3 }, feedback: 0.35, mix: 0.25 }) : engine.bus({ gainDb: 0 });
  keys.connect(bus).connect(engine.output);
  engine.transport.bpm.set(120);
  const part = engine.transport.schedule(engine.pattern({ length: { beats: 4 }, events: [0, 1, 2, 3].map(beat => ({ beat, notes: ['C4', 'E4', 'G4', 'B4'], duration: { beats: 1 } })) }), keys);
  const meter = await engine.meter({ source: bus, updatesPerSecond: meterHz });
  let meterReads = 0;
  const unsubscribe = meter.subscribe(() => { meterReads++; });
  engine.transport.start();

  const started = now();
  const startedFrame = engine.currentFrame;
  const samples = [];
  let poseUpdates = 0, busyPeriods = 0, maxBusyMs = 0, peakVoices = 0;
  const poseTimer = setInterval(() => {
    const t = (now() - started) / 1000;
    for (const item of emitters) item.emitter.setPosition({ x: Math.cos(t * 0.5 + item.phase) * 3, y: 0, z: Math.sin(t * 0.5 + item.phase) * 3 });
    engine.listener.setPose({ forward: { x: Math.sin(t * 0.1), y: 0, z: -Math.cos(t * 0.1) } });
    poseUpdates++;
  }, 1000 / poseHz);
  const busyTimer = setInterval(() => {
    const begin = now(); let spin = 0;
    while (now() - begin < busyMs) spin++;
    busyPeriods++; maxBusyMs = Math.max(maxBusyMs, now() - begin);
  }, 1000);
  const snapshot = () => {
    const wall = (now() - started) / 1000;
    const transport = engine.transport.diagnostics;
    const diagnostics = engine.diagnostics;
    peakVoices = Math.max(peakVoices, diagnostics.voices);
    const entry = { wallSeconds: wall, engineSeconds: (engine.currentFrame - startedFrame) / rate, voices: diagnostics.voices, nodes: diagnostics.nodes, state: diagnostics.state, transport: { lateEvents: transport.lateEvents, maxLatenessSeconds: transport.maxLatenessSeconds, skippedEvents: transport.skippedEvents, scheduledEvents: transport.scheduledEvents, interruptions: transport.interruptions, errors: transport.errors, state: transport.state }, meter: { reads: meterReads, ...meter.diagnostics }, poseUpdates, busyPeriods, maxBusyMs };
    samples.push(entry);
    onSample?.(entry);
    return entry;
  };
  const sampleTimer = setInterval(snapshot, sampleEvery * 1000);
  await new Promise(resolve => setTimeout(resolve, seconds * 1000));
  clearInterval(poseTimer); clearInterval(busyTimer); clearInterval(sampleTimer);
  const last = snapshot();
  unsubscribe();
  part.cancel();
  engine.transport.stop();
  for (const item of emitters) item.voice.stop();
  const finalVoicesBeforeDispose = engine.diagnostics.voices;
  await engine.dispose();
  const clockDrift = last.wallSeconds - last.engineSeconds;
  // Voice bound: four sample loops plus the instrument's polyphony ceiling. Released chord voices stay allocated until
  // the host's ended event arrives, which the busy JS thread delays, so the earlier "8 + 4" bound was wrong; the first
  // 600 s browser run failed only that gate (16 voices) with every timing/drop gate at zero — see docs/evidence.
  const pass = last.transport.lateEvents === 0 && last.transport.skippedEvents === 0 && last.transport.errors === 0 && last.meter.droppedFrames === 0 && last.transport.interruptions === 0 && Math.abs(clockDrift) < 0.5 && last.voices <= 4 + keys.maxVoices;
  return {
    workloadVersion, sampleRate: rate, seconds, busyMs, poseHz, meterHz, adapter: adapter.name,
    totals: { lateEvents: last.transport.lateEvents, maxLatenessSeconds: last.transport.maxLatenessSeconds, skippedEvents: last.transport.skippedEvents, scheduledEvents: last.transport.scheduledEvents, interruptions: last.transport.interruptions, errors: last.transport.errors, meterReads, meterDroppedFrames: last.meter.droppedFrames, poseUpdates, busyPeriods, maxBusyMs, peakVoices, finalVoicesBeforeDispose, clockDriftSeconds: clockDrift, disposedNodes: engine.diagnostics.nodes, disposedVoices: engine.diagnostics.voices },
    samples,
    status: pass ? 'pass' : 'fail',
    scope: 'engine-side accounting under the reference workload (stereo mode only; binaural unavailable); no underrun counter exists on these hosts, so audible dropout freedom is not concluded here',
  };
}
