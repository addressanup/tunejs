import { encodeWav, resample } from './assets.js';
import { BlockConvolver, Biquad, Timeline, biquadCoeffs, noiseBufferData, oscillatorValue } from './dsp.js';
import type { BiquadCoeffs } from './dsp.js';
import { TuneError, finite } from './errors.js';
import { adsValueAt, envelopeEvents, noteToFrequency } from './instrument.js';
import type { Envelope, InstrumentLayer } from './instrument.js';
import { syntheticReverbResponse } from './mixing.js';
import { checkProject, resolveProjectAssets } from './project.js';
import type { ProjectNode, ProjectV1 } from './project.js';
import { stereoRender } from './spatial.js';
import { TempoMap } from './transport.js';

export interface RenderResult {
  readonly channels: [Float32Array, Float32Array];
  readonly sampleRate: number;
  readonly frames: number;
  readonly range: { fromFrame: number; toFrame: number };
  encode(options: { format: 'wav' }): { bytes: ArrayBuffer; clippedSamples: number };
}

const BLOCK = 128;
const STEAL_SECONDS = 0.02;

interface VoiceLayer {
  kind: 'osc' | 'noise';
  wave: 'sine' | 'triangle' | 'square' | 'sawtooth';
  freq?: Timeline;
  filter?: { type: 'lowpass' | 'highpass'; frequencyHz: number };
  level: number;
  phase: number;
  noiseIndex: number;
  biquad?: Biquad;
}
interface Voice {
  start: number;
  end: number;
  env: Timeline;
  layers: VoiceLayer[];
  stopping: boolean;
  sample?: { data: Float64Array[]; startIndex: number; endIndex: number; rate: number };
}

interface Runtime {
  def: ProjectNode;
  inputs: Runtime[];
  channels: number;
  out: Float64Array[];
  voices: Voice[];
  timeline: Timeline; // the node's primary a-rate param (gain/mix/pan/level)
  filterTimeline?: Timeline;
  filterType?: 'lowpass' | 'highpass';
  biquads: Biquad[];
  delayLine?: Float64Array[]; delayWrite?: number; delayD?: number;
  convolvers?: BlockConvolver[];
  wet?: Float64Array[];
  spatial?: { pan: number; gain: number };
  oscPhase?: number;
  maxVoices: number;
  live: Voice[];
}

function makeVoice(envelope: Envelope, durationSec: number | undefined, peak: number, startFrame: number, rate: number, layers: InstrumentLayer[], frequencyHz: number | null): Voice {
  const env = new Timeline();
  for (const event of envelopeEvents(envelope, durationSec, peak)) env[event.ramp ? 'ramp' : 'set'](event.value, event.seconds);
  const { attack, decay, sustain, release } = envelope;
  let endOffset: number;
  if (durationSec !== undefined) endOffset = durationSec + release;
  else if (sustain === 0) endOffset = attack + decay + release;
  else endOffset = Infinity;
  const end = endOffset === Infinity ? Infinity : startFrame + Math.round(endOffset * rate) + 1;
  const voiceLayers: VoiceLayer[] = layers.map(layer => {
    const out: VoiceLayer = { kind: layer.source === 'noise' ? 'noise' : 'osc', wave: layer.wave ?? 'sine', level: layer.level ?? 1, phase: 0, noiseIndex: 0, filter: layer.filter };
    if (out.kind === 'osc' && frequencyHz !== null) {
      const f = frequencyHz * (layer.ratio ?? 1) * 2 ** ((layer.detuneCents ?? 0) / 1200);
      const freq = new Timeline();
      if (layer.pitch) {
        freq.set(f * layer.pitch.startRatio, 0);
        freq.ramp(f, layer.pitch.seconds);
      } else freq.set(f, 0);
      out.freq = freq;
    }
    return out;
  });
  return { start: startFrame, end, env, layers: voiceLayers, stopping: false };
}

function stealVoice(voice: Voice, atFrame: number, rate: number): void {
  const t = (atFrame - voice.start) / rate;
  const current = voice.env.valueAt(t);
  voice.env.cancel(t);
  voice.env.set(current, t);
  voice.env.ramp(0, t + STEAL_SECONDS);
  voice.end = atFrame + Math.round(STEAL_SECONDS * rate) + 1;
  voice.stopping = true;
}

export async function renderProject(project: unknown, options: {
  range: { fromBeat: number; toBeat: number } | { fromSeconds: number; toSeconds: number };
  tail: { seconds: number };
  sampleRate: 44100 | 48000;
  resolveAsset?: (id: string) => Promise<ArrayBuffer | ArrayBufferView>;
  maxSeconds?: number;
}): Promise<RenderResult> {
  const { p, defs, connections, patternDefs, partDefs, manifest, problems } = checkProject(project);
  if (problems.length) throw new TuneError('PROJECT_INVALID', `The project is invalid: ${problems.join('; ')}.`, 'Fix the project data and retry.');
  const sampleRate = options.sampleRate;
  if (sampleRate !== 44100 && sampleRate !== 48000) throw new TuneError('INVALID_VALUE', 'Render sample rate must be 44100 or 48000.', 'Choose a supported rate.');
  const tailSeconds = finite(options.tail?.seconds ?? NaN, 0, 60, 'tail seconds');
  const map = new TempoMap(0, 0, p.transport.bpm, sampleRate);
  let fromFrame: number; let toFrame: number;
  const range = options.range as { fromBeat?: number; toBeat?: number; fromSeconds?: number; toSeconds?: number };
  if (range && range.fromBeat !== undefined) {
    fromFrame = map.frameAtBeat(finite(range.fromBeat, 0, Number.MAX_SAFE_INTEGER, 'fromBeat'));
    toFrame = map.frameAtBeat(finite(range.toBeat!, 0, Number.MAX_SAFE_INTEGER, 'toBeat'));
  } else if (range && range.fromSeconds !== undefined) {
    fromFrame = Math.round(finite(range.fromSeconds, 0, Number.MAX_SAFE_INTEGER, 'fromSeconds') * sampleRate);
    toFrame = Math.round(finite(range.toSeconds!, 0, Number.MAX_SAFE_INTEGER, 'toSeconds') * sampleRate);
  } else throw new TuneError('INVALID_VALUE', 'Render range needs beats or seconds.', 'Pass { fromBeat, toBeat } or { fromSeconds, toSeconds }.');
  if (toFrame <= fromFrame) throw new TuneError('INVALID_VALUE', 'Render range must be positive.', 'Choose a later end.');
  const maxSeconds = options.maxSeconds ?? 600;
  const frames = (toFrame - fromFrame) + Math.round(tailSeconds * sampleRate);
  if (frames / sampleRate > maxSeconds) throw new TuneError('INVALID_VALUE', `Render exceeds the ${maxSeconds} s cap.`, 'Shorten the range or raise maxSeconds.');
  const decoded = await resolveProjectAssets(defs, manifest, options.resolveAsset);
  const assets = new Map<string, { channels: Float64Array[]; frames: number }>();
  for (const [id, entry] of decoded) {
    const channels = entry.decoded.sampleRate === sampleRate
      ? entry.decoded.channels.map(c => Float64Array.from(c))
      : resample(entry.decoded.channels, entry.decoded.sampleRate, sampleRate).map(c => Float64Array.from(c));
    assets.set(id, { channels, frames: channels[0]!.length });
  }
  // Runtimes.
  const runtimes = new Map<string, Runtime>();
  for (const def of defs) {
    const timeline = new Timeline();
    const rt: Runtime = { def, inputs: [], channels: 1, out: [], voices: [], timeline, biquads: [], maxVoices: 1, live: [], oscPhase: 0 };
    switch (def.type) {
      case 'gain': timeline.set(def.params.gain, 0); break;
      case 'bus': timeline.set(10 ** (def.params.gainDb / 20), 0); break;
      case 'pan': timeline.set(def.params.pan, 0); rt.channels = 2; break;
      case 'delay': timeline.set(def.params.mix, 0); break;
      case 'reverb': timeline.set(def.params.mix, 0); rt.channels = 2; break;
      case 'instrument': timeline.set(def.params.level, 0); rt.filterTimeline = new Timeline(); rt.filterTimeline.set(def.params.filterHz, 0); rt.filterType = def.preset.filter?.type; rt.maxVoices = def.maxVoices; break;
      case 'kit': timeline.set(def.params.level, 0); rt.maxVoices = def.maxVoices; break;
      case 'spatial': {
        rt.channels = 2;
        rt.spatial = stereoRender({ position: p.listener.position, forward: p.listener.forward, up: p.listener.up }, { position: def.position, direction: def.direction, distanceModel: def.distance, cone: def.cone });
        break;
      }
      default: break;
    }
    runtimes.set(def.id, rt);
  }
  for (const edge of connections) {
    if (edge.to === 'output') continue;
    runtimes.get(edge.to)!.inputs.push(runtimes.get(edge.from)!);
  }
  // Channel counts for pass-through nodes = max input count.
  for (const rt of runtimes.values()) {
    if (rt.def.type !== 'pan' && rt.def.type !== 'spatial' && rt.def.type !== 'reverb') {
      if (rt.def.type === 'sample') rt.channels = Math.min(2, assets.get(rt.def.assetId)!.channels.length);
      else if (rt.inputs.length) rt.channels = Math.max(...rt.inputs.map(input => input.channels));
    }
    rt.out = Array.from({ length: rt.channels }, () => new Float64Array(BLOCK));
  }
  // Topological order (declared graph is acyclic by validation).
  const order: Runtime[] = [];
  const dependents = new Map<Runtime, Runtime[]>();
  const pending = new Map<Runtime, number>();
  for (const rt of runtimes.values()) { pending.set(rt, rt.inputs.length); for (const input of rt.inputs) (dependents.get(input) ?? dependents.set(input, []).get(input)!).push(rt); }
  const queue = [...runtimes.values()].filter(rt => rt.inputs.length === 0);
  while (queue.length) {
    const rt = queue.shift()!;
    order.push(rt);
    for (const next of dependents.get(rt) ?? []) { pending.set(next, pending.get(next)! - 1); if (pending.get(next) === 0) queue.push(next); }
  }
  // Per-node persistent state.
  for (const rt of runtimes.values()) {
    if (rt.def.type === 'filter') { const d = rt.def; rt.filterTimeline = new Timeline(); rt.filterTimeline.set(d.params.frequencyHz, 0); rt.filterType = d.filterType; }
    if (rt.def.type === 'delay') {
      const def = rt.def;
      const d = Math.max(1, Math.round(def.timeSeconds * sampleRate));
      rt.delayD = d; rt.delayWrite = 0;
      rt.delayLine = Array.from({ length: rt.channels }, () => new Float64Array(d * def.taps + BLOCK));
    }
    if (rt.def.type === 'reverb') {
      const ir = syntheticReverbResponse((rt.def as { decaySeconds: number }).decaySeconds, sampleRate);
      rt.convolvers = [new BlockConvolver(ir[0]!), new BlockConvolver(ir[1]!)];
      rt.wet = [new Float64Array(BLOCK), new Float64Array(BLOCK)];
    }
    if (rt.filterType || (rt.def.type === 'filter')) {
      const freq = rt.filterTimeline!.valueAt(0);
      rt.biquads = Array.from({ length: rt.channels }, () => new Biquad(biquadCoeffs(rt.filterType!, freq, sampleRate)));
    }
  }
  const patterns = new Map(patternDefs.map(def => [def.id, def]));
  const noise = noiseBufferData(sampleRate);
  // Enumerate occurrences into voices.
  for (const part of partDefs) {
    const target = runtimes.get(part.targetId)!;
    const pattern = patterns.get(part.patternId)!;
    const events = [...pattern.events].sort((a, b) => a.beat - b.beat);
    let k = 0;
    outer: while (true) {
      if (!part.loop && k > 0) break;
      for (const event of events) {
        const beat = part.startBeat + k * pattern.length.beats + event.beat;
        const startFrame = map.frameAtBeat(beat);
        if (startFrame >= toFrame) break outer;
        if (startFrame < fromFrame) continue;
        const endFrame = map.frameAtBeat(beat + event.duration.beats);
        const durationSec = (endFrame - startFrame) / sampleRate;
        const velocity = event.velocity ?? 0.8;
        if (target.def.type === 'instrument' || target.def.type === 'kit') {
          const names = Array.isArray(event.notes) ? event.notes : [event.notes];
          for (const name of names) {
            let envelope: Envelope; let layers: readonly InstrumentLayer[]; let frequencyHz: number | null;
            if (target.def.type === 'kit') {
              const hit = target.def.preset.hits[name];
              if (!hit) continue;
              envelope = hit.envelope; layers = hit.layers; frequencyHz = hit.frequencyHz;
            } else {
              envelope = target.def.envelope; layers = target.def.preset.layers; frequencyHz = typeof name === 'string' ? noteToFrequency(name) : null;
            }
            if (target.live.length >= target.maxVoices) {
              const victim = target.live.find(voice => !voice.stopping);
              if (victim) stealVoice(victim, startFrame - fromFrame, sampleRate);
            }
            const voice = makeVoice(envelope, durationSec, velocity, startFrame - fromFrame, sampleRate, layers as InstrumentLayer[], frequencyHz);
            target.live.push(voice); target.voices.push(voice);
          }
        } else if (target.def.type === 'sample') {
          const asset = assets.get(target.def.assetId)!;
          const regionStart = event.region?.start ?? 0;
          const regionEnd = Math.min(event.region?.end ?? asset.frames / sampleRate, asset.frames / sampleRate);
          const rate = 1;
          const startIndex = regionStart * sampleRate;
          const spanSec = (regionEnd - regionStart) / rate;
          const end = Math.min(startFrame + Math.round(spanSec * sampleRate) + 1, endFrame) - fromFrame;
          const voice: Voice = { start: startFrame - fromFrame, end, env: new Timeline(), layers: [], stopping: false,
            sample: { data: asset.channels, startIndex, endIndex: Math.min(startIndex + spanSec * sampleRate, asset.frames), rate } };
          voice.env.set(1, 0);
          target.voices.push(voice);
        }
      }
      k++;
      if (!part.loop) break;
    }
  }
  // Block render.
  const left = new Float64Array(frames); const right = new Float64Array(frames);
  const blockIn = (rt: Runtime, blockLen: number): Float64Array[] => {
    const inChannels = rt.inputs.length ? Math.max(...rt.inputs.map(input => input.channels)) : 1;
    const mix = Array.from({ length: inChannels }, () => new Float64Array(blockLen));
    for (const input of rt.inputs) {
      for (let c = 0; c < inChannels; c++) {
        const src = input.out[Math.min(c, input.channels - 1)]!;
        const dst = mix[c]!;
        for (let i = 0; i < blockLen; i++) dst[i] = dst[i]! + src[i]!;
      }
    }
    return mix;
  };
  const renderVoice = (voice: Voice, blockStart: number, blockLen: number, out: Float64Array): void => {
    const s0 = Math.max(blockStart, voice.start); const s1 = Math.min(blockStart + blockLen, voice.end);
    for (let i = s0; i < s1; i++) {
      const t = (i - voice.start) / sampleRate;
      const env = voice.env.valueAt(t);
      if (env === 0) continue;
      let v = 0;
      for (const layer of voice.layers) {
        let s: number;
        if (layer.kind === 'noise') { s = noise[layer.noiseIndex % noise.length]!; layer.noiseIndex++; }
        else { s = oscillatorValue(layer.wave, layer.phase); layer.phase = (layer.phase + layer.freq!.valueAt(t) / sampleRate) % 1; }
        s *= layer.level;
        if (layer.biquad) s = layer.biquad.step(s);
        v += s;
      }
      out[i - blockStart] = out[i - blockStart]! + v * env;
    }
  };
  const renderSample = (voice: Voice, blockStart: number, blockLen: number, outs: Float64Array[]): void => {
    const s0 = Math.max(blockStart, voice.start); const s1 = Math.min(blockStart + blockLen, voice.end);
    const sample = voice.sample!;
    for (let i = s0; i < s1; i++) {
      const index = sample.startIndex + (i - voice.start) * sample.rate;
      if (index >= sample.endIndex) break;
      const i0 = Math.floor(index); const frac = index - i0;
      for (let c = 0; c < outs.length; c++) {
        const data = sample.data[Math.min(c, sample.data.length - 1)]!;
        const a = data[i0] ?? 0; const b = data[i0 + 1] ?? 0;
        outs[c]![i - blockStart] = outs[c]![i - blockStart]! + a + (b - a) * frac;
      }
    }
  };
  const outputEdges = connections.filter(edge => edge.to === 'output');
  for (let blockStart = 0; blockStart < frames; blockStart += BLOCK) {
    const blockLen = Math.min(BLOCK, frames - blockStart);
    const t0 = blockStart / sampleRate;
    for (const rt of order) {
      for (const channel of rt.out) channel.fill(0);
      const def = rt.def;
      switch (def.type) {
        case 'instrument': case 'kit': {
          const bus = rt.out[0]!;
          for (const voice of rt.voices) renderVoice(voice, blockStart, blockLen, bus);
          if (rt.filterType) {
            const coeff = biquadCoeffs(rt.filterType, rt.filterTimeline!.valueAt(t0), sampleRate);
            for (const b of rt.biquads) b.coeffs = coeff;
            for (let i = 0; i < blockLen; i++) bus[i] = rt.biquads[0]!.step(bus[i]!);
          }
          for (let i = 0; i < blockLen; i++) bus[i] = bus[i]! * rt.timeline.valueAt(t0 + i / sampleRate);
          break;
        }
        case 'oscillator': {
          const dst = rt.out[0]!;
          let phase = rt.oscPhase!;
          for (let i = 0; i < blockLen; i++) { dst[i] = oscillatorValue(def.wave, phase); phase = (phase + def.frequencyHz / sampleRate) % 1; }
          rt.oscPhase = phase;
          break;
        }
        case 'sample': {
          for (const voice of rt.voices) renderSample(voice, blockStart, blockLen, rt.out);
          break;
        }
        case 'gain': case 'bus': case 'filter': {
          const input = blockIn(rt, blockLen);
          for (let c = 0; c < rt.channels; c++) {
            const src = input[c]!; const dst = rt.out[c]!;
            if (def.type === 'filter') {
              rt.biquads[c]!.coeffs = biquadCoeffs(def.filterType, rt.filterTimeline!.valueAt(t0), sampleRate);
              for (let i = 0; i < blockLen; i++) dst[i] = rt.biquads[c]!.step(src[i]!);
            } else {
              for (let i = 0; i < blockLen; i++) dst[i] = src[i]! * rt.timeline.valueAt(t0 + i / sampleRate);
            }
          }
          break;
        }
        case 'pan': case 'spatial': {
          const input = blockIn(rt, blockLen);
          const [L, R] = rt.out;
          for (let i = 0; i < blockLen; i++) {
            const pan = def.type === 'pan' ? Math.max(-1, Math.min(1, rt.timeline.valueAt(t0 + i / sampleRate))) : rt.spatial!.pan;
            const g = def.type === 'spatial' ? rt.spatial!.gain : 1;
            if (input.length === 1) {
              const x = (pan + 1) / 2;
              L![i] = input[0]![i]! * g * Math.cos(x * Math.PI / 2);
              R![i] = input[0]![i]! * g * Math.sin(x * Math.PI / 2);
            } else {
              const inL = input[0]![i]! * g; const inR = input[1]![i]! * g;
              if (pan <= 0) {
                const x = (pan + 1) * Math.PI / 2;
                L![i] = inL + inR * Math.cos(x); R![i] = inR * Math.sin(x);
              } else {
                const x = pan * Math.PI / 2;
                L![i] = inL * Math.cos(x); R![i] = inR + inL * Math.sin(x);
              }
            }
          }
          break;
        }
        case 'delay': {
          const input = blockIn(rt, blockLen);
          const taps = def.taps; const d = rt.delayD!; const line = rt.delayLine!;
          for (let c = 0; c < rt.channels; c++) {
            const src = input[c]!; const dst = rt.out[c]!; const ring = line[c]!;
            const size = d * taps + BLOCK;
            let write = rt.delayWrite! % size;
            for (let i = 0; i < blockLen; i++) {
              ring[write] = src[i]!;
              let wet = 0;
              for (let k = 1; k <= taps; k++) wet += ring[(write - k * d + size * 2) % size]! * def.feedback ** k;
              dst[i] = src[i]! + wet * rt.timeline.valueAt(t0 + i / sampleRate);
              write = (write + 1) % size;
            }
          }
          rt.delayWrite = (rt.delayWrite! + blockLen) % (d * taps + BLOCK);
          break;
        }
        case 'reverb': {
          const input = blockIn(rt, blockLen);
          const mix = rt.timeline;
          for (let c = 0; c < 2; c++) {
            const src = input[Math.min(c, input.length - 1)]!;
            rt.convolvers![c]!.process(padBlock(src, blockLen), rt.wet![c]!);
            const dst = rt.out[c]!;
            for (let i = 0; i < blockLen; i++) dst[i] = src[i]! + rt.wet![c]![i]! * mix.valueAt(t0 + i / sampleRate);
          }
          break;
        }
        default: break;
      }
    }
    for (const edge of outputEdges) {
      const src = runtimes.get(edge.from)!;
      for (let i = 0; i < blockLen; i++) {
        left[blockStart + i] = left[blockStart + i]! + src.out[0]![i]!;
        right[blockStart + i] = right[blockStart + i]! + src.out[Math.min(1, src.channels - 1)]![i]!;
      }
    }
  }
  const channels: [Float32Array, Float32Array] = [Float32Array.from(left), Float32Array.from(right)];
  return {
    channels, sampleRate, frames, range: { fromFrame, toFrame },
    encode({ format }) {
      if (format !== 'wav') throw new TuneError('INVALID_VALUE', 'Only wav encoding is supported.', 'Pass format: "wav".');
      return encodeWav(channels, sampleRate);
    },
  };
}

function padBlock(src: Float64Array, len: number): Float64Array {
  if (len === BLOCK) return src;
  const out = new Float64Array(BLOCK); out.set(src.subarray(0, len));
  return out;
}
