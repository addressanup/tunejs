import { decodeWav, fnv1a64Float32 } from './assets.js';
import type { DecodedWav } from './assets.js';
import type { Engine } from './engine.js';
import { TuneError, finite } from './errors.js';
import { Gain, Filter, GraphNode, Oscillator } from './graph.js';
import { Instrument } from './instrument.js';
import type { Envelope, InstrumentPreset } from './instrument.js';
import { Kit } from './kit.js';
import type { KitPreset } from './kit.js';
import { Bus, Delay, Pan, Reverb } from './mixing.js';
import { Input } from './capture.js';
import { Sample } from './sample.js';
import { SpatialSource } from './spatial.js';
import type { Cone, DistanceModel, Vec3 } from './spatial.js';
import type { Pattern, Part } from './transport.js';
import type { Beats, PatternEvent } from './transport.js';

type Wave = 'sine' | 'triangle' | 'square' | 'sawtooth';
export type ProjectNode = { id: string } & (
  | { type: 'oscillator'; frequencyHz: number; wave: Wave }
  | { type: 'gain'; params: { gain: number } }
  | { type: 'filter'; filterType: 'lowpass' | 'highpass'; params: { frequencyHz: number } }
  | { type: 'instrument'; preset: InstrumentPreset; maxVoices: number; envelope: Envelope; params: { level: number; filterHz: number } }
  | { type: 'kit'; preset: KitPreset; maxVoices: number; params: { level: number } }
  | { type: 'sample'; assetId: string }
  | { type: 'bus'; params: { gainDb: number } }
  | { type: 'pan'; params: { pan: number } }
  | { type: 'delay'; timeSeconds: number; feedback: number; taps: number; params: { mix: number } }
  | { type: 'reverb'; renderer: 'synthetic-convolution-v1'; decaySeconds: number; params: { mix: number } }
  | { type: 'spatial'; renderer: 'tunejs-stereo-v1'; rendering: 'stereo'; position: Vec3; direction: Vec3 | null; distance: DistanceModel; cone: Cone; smoothingSeconds: number }
);
export interface ProjectV1 {
  format: 'tunejs-project'; version: 1;
  transport: { bpm: number; beatsPerBar: number };
  listener: { position: Vec3; forward: Vec3; up: Vec3 };
  nodes: ProjectNode[];
  connections: { from: string; to: string }[];
  patterns: { id: string; length: Beats; events: PatternEvent[] }[];
  parts: { patternId: string; targetId: string; startBeat: number; loop: boolean }[];
  assets: { id: string; sampleRate: number; channels: number; frames: number; integrity: string }[];
}

const nodeSort = (a: ProjectNode, b: ProjectNode): number => Number(a.id.slice(1)) - Number(b.id.slice(1));

function serializeNode(node: GraphNode): ProjectNode {
  const id = node.nodeId;
  if (node instanceof Oscillator) return { id, type: 'oscillator', frequencyHz: node.frequencyHz, wave: node.wave };
  if (node instanceof Instrument) return { id, type: 'instrument', preset: node.preset, maxVoices: node.maxVoices, envelope: node.envelope, params: { level: node.level.value, filterHz: node.filterHz.value } };
  if (node instanceof Kit) return { id, type: 'kit', preset: node.preset, maxVoices: node.maxVoices, params: { level: node.level.value } };
  if (node instanceof Sample) return { id, type: 'sample', assetId: node.entry.id };
  if (node instanceof Bus) return { id, type: 'bus', params: { gainDb: node.gainDb.value } };
  if (node instanceof Pan) return { id, type: 'pan', params: { pan: node.pan.value } };
  if (node instanceof Delay) return { id, type: 'delay', timeSeconds: node.timeSeconds, feedback: node.feedback, taps: node.taps, params: { mix: node.mix.value } };
  if (node instanceof Reverb) return { id, type: 'reverb', renderer: 'synthetic-convolution-v1', decaySeconds: node.decaySeconds, params: { mix: node.mix.value } };
  if (node instanceof SpatialSource) {
    return { id, type: 'spatial', renderer: 'tunejs-stereo-v1', rendering: node.rendering as 'stereo', position: node.position, direction: node.direction, distance: node.distanceModel, cone: node.cone, smoothingSeconds: node.smoothingSeconds };
  }
  if (node instanceof Filter) return { id, type: 'filter', filterType: node.type, params: { frequencyHz: node.frequencyHz.value } };
  if (node instanceof Gain) return { id, type: 'gain', params: { gain: node.gain.value } };
  throw new TuneError('PROJECT_INVALID', `Node ${id} of kind '${node.kind}' cannot be serialized.`, 'Disconnect or dispose it before exporting.');
}

/** @internal — called by Engine.exportProject. */
export function exportProject(engine: Engine): { project: ProjectV1; warnings: string[] } {
  engine.assertAlive();
  const problems: string[] = [];
  for (const node of engine.nodes) {
    if (node === engine.output) continue;
    if (node instanceof Input) problems.push(`node ${node.nodeId} is a live capture input`);
  }
  for (const tap of engine.taps) problems.push(`a live tap is attached to node ${tap.source.nodeId}`);
  if (problems.length) {
    throw new TuneError('PROJECT_INVALID', `The project cannot be exported: ${problems.join('; ')}.`, 'Dispose capture inputs and cancel taps, meters or recorders first.');
  }
  const warnings: string[] = [];
  const transport = engine.transport;
  if (transport.state === 'running') warnings.push('The transport is running; its position is not exported.');
  if (transport.pendingTempo) warnings.push('A pending tempo change was not applied; the active tempo is exported.');
  const nodes = [...engine.nodes].filter(node => node !== engine.output).map(serializeNode).sort(nodeSort);
  const connections: { from: string; to: string }[] = [];
  const byId = new Map<string, GraphNode>();
  for (const node of engine.nodes) if (node !== engine.output) byId.set(node.nodeId, node);
  for (const def of nodes) {
    const node = byId.get(def.id)!;
    for (const target of node.targets) connections.push({ from: def.id, to: target === engine.output ? 'output' : target.nodeId });
  }
  const patternIds = new Map<Pattern, string>();
  const patterns: ProjectV1['patterns'] = [];
  const parts: ProjectV1['parts'] = [];
  for (const part of transport.parts) {
    if (part.state === 'cancelled') continue;
    if (part.pendingReplace) warnings.push(`A pending part replacement on ${part.target.nodeId} was not applied; the active pattern is exported.`);
    const pattern = part.pattern;
    let patternId = patternIds.get(pattern);
    if (!patternId) {
      patternId = `p${patterns.length + 1}`;
      patternIds.set(pattern, patternId);
      patterns.push({ id: patternId, length: { ...pattern.length }, events: pattern.events.map(event => ({ ...event, notes: Array.isArray(event.notes) ? [...event.notes] : event.notes, ...(event.region ? { region: { ...event.region } } : {}) })) });
    }
    parts.push({ patternId, targetId: part.target.nodeId, startBeat: part.startBeat, loop: part.loop });
  }
  const assets: ProjectV1['assets'] = [];
  for (const node of engine.nodes) {
    if (node instanceof Sample) {
      const decoded = node.entry.decoded;
      assets.push({ id: node.entry.id, sampleRate: decoded.sampleRate, channels: decoded.channels.length, frames: decoded.frames, integrity: fnv1a64Float32(decoded.channels) });
    }
  }
  const listener = engine.listener;
  return {
    warnings,
    project: {
      format: 'tunejs-project', version: 1,
      transport: { bpm: transport.bpm.value, beatsPerBar: transport.meter.beatsPerBar },
      listener: { position: listener.position, forward: listener.forward, up: listener.up },
      nodes, connections, patterns, parts, assets,
    },
  };
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;
const KNOWN_TYPES = new Set(['oscillator', 'gain', 'filter', 'instrument', 'kit', 'sample', 'bus', 'pan', 'delay', 'reverb', 'spatial']);

/** @internal — called by Engine.importProject. */
export async function importProject(engine: Engine, project: unknown, options: { resolveAsset?: (id: string) => Promise<ArrayBuffer | ArrayBufferView> } = {}): Promise<{ nodes: Map<string, GraphNode>; parts: Part[] }> {
  engine.assertAlive();
  // Phase 1: collect every structural problem before creating anything.
  const problems: string[] = [];
  const p = project as ProjectV1;
  if (!isObject(p) || p.format !== 'tunejs-project') problems.push('format must be "tunejs-project"');
  if (!isObject(p) || p.version !== 1) problems.push('version must be 1');
  if (engine.transport.state !== 'stopped') problems.push('the transport must be stopped');
  const defs: ProjectNode[] = isObject(p) && Array.isArray(p.nodes) ? p.nodes : [];
  const ids = new Set<string>();
  for (const def of defs) {
    if (!isObject(def) || typeof def.id !== 'string' || !def.id) { problems.push('a node is missing an id'); continue; }
    if (ids.has(def.id)) problems.push(`duplicate node id '${def.id}'`);
    ids.add(def.id);
    if (!KNOWN_TYPES.has(def.type as string)) problems.push(`node '${def.id}' has unknown type '${String(def.type)}'`);
  }
  const connections: ProjectV1['connections'] = isObject(p) && Array.isArray(p.connections) ? p.connections : [];
  const knownEndpoint = (id: unknown) => typeof id === 'string' && (id === 'output' || ids.has(id));
  for (const edge of connections) {
    if (!isObject(edge) || !knownEndpoint(edge.from) || !knownEndpoint(edge.to)) problems.push(`connection '${JSON.stringify(edge)}' references an unknown node`);
  }
  // Cycle detection on the declared edges.
  const adjacency = new Map<string, string[]>();
  for (const edge of connections) {
    if (isObject(edge) && knownEndpoint(edge.from) && knownEndpoint(edge.to)) {
      const from = edge.from as string;
      if (!adjacency.has(from)) adjacency.set(from, []);
      adjacency.get(from)!.push(edge.to as string);
    }
  }
  const visiting = new Set<string>(); const done = new Set<string>();
  const cyclic = (id: string): boolean => {
    if (done.has(id)) return false;
    if (visiting.has(id)) return true;
    visiting.add(id);
    for (const next of adjacency.get(id) ?? []) if (cyclic(next)) return true;
    visiting.delete(id); done.add(id);
    return false;
  };
  for (const id of ids) if (cyclic(id)) { problems.push(`connections form a cycle involving '${id}'`); break; }
  const patternDefs: ProjectV1['patterns'] = isObject(p) && Array.isArray(p.patterns) ? p.patterns : [];
  const patternIds = new Set<string>();
  for (const def of patternDefs) {
    if (!isObject(def) || typeof def.id !== 'string' || !def.id) { problems.push('a pattern is missing an id'); continue; }
    if (patternIds.has(def.id)) problems.push(`duplicate pattern id '${def.id}'`);
    patternIds.add(def.id);
  }
  const partDefs: ProjectV1['parts'] = isObject(p) && Array.isArray(p.parts) ? p.parts : [];
  for (const part of partDefs) {
    if (!isObject(part)) { problems.push('a part is not an object'); continue; }
    if (!patternIds.has(part.patternId as string)) problems.push(`part references unknown pattern '${String(part.patternId)}'`);
    const target = defs.find(def => isObject(def) && def.id === part.targetId);
    if (!target) problems.push(`part references unknown target '${String(part.targetId)}'`);
    else if (!['instrument', 'kit', 'sample'].includes(target.type as string)) problems.push(`part target '${String(part.targetId)}' cannot be scheduled`);
  }
  const assetManifest = isObject(p) && Array.isArray(p.assets) ? p.assets : [];
  const manifest = new Map<string, { sampleRate: number; channels: number; frames: number; integrity: string }>();
  for (const asset of assetManifest) if (isObject(asset) && typeof asset.id === 'string') manifest.set(asset.id, asset as { sampleRate: number; channels: number; frames: number; integrity: string });
  for (const def of defs) {
    if (isObject(def) && def.type === 'sample') {
      if (!manifest.has(def.assetId as string)) problems.push(`sample node '${def.id}' references asset '${String(def.assetId)}' missing from the manifest`);
    }
  }
  if (problems.length) {
    throw new TuneError('PROJECT_INVALID', `The project is invalid: ${problems.join('; ')}.`, 'Fix the project data and retry.');
  }
  // Phase 2: resolve and verify assets before building anything.
  const sampleDefs = defs.filter(def => isObject(def) && def.type === 'sample');
  const decodedAssets = new Map<string, { bytes: ArrayBuffer | ArrayBufferView; decoded: DecodedWav }>();
  if (sampleDefs.length && !options.resolveAsset) {
    throw new TuneError('PROJECT_INVALID', 'The project contains sample nodes but no resolveAsset callback was provided.', 'Pass { resolveAsset } returning the asset bytes by id.');
  }
  for (const def of sampleDefs) {
    const assetId = def.assetId as string;
    if (decodedAssets.has(assetId)) continue;
    const expected = manifest.get(assetId)!;
    let bytes: ArrayBuffer | ArrayBufferView;
    try { bytes = await options.resolveAsset!(assetId); }
    catch (cause) { throw new TuneError('ASSET_FAILED', `Resolving asset '${assetId}' failed.`, 'Check the asset source and retry.', { cause }); }
    let decoded: DecodedWav;
    try { decoded = decodeWav(bytes); }
    catch (cause) {
      if (cause instanceof TuneError) throw cause;
      throw new TuneError('ASSET_FAILED', `Decoding asset '${assetId}' failed.`, 'Provide an intact PCM WAV file.', { cause });
    }
    const integrity = fnv1a64Float32(decoded.channels);
    if (decoded.sampleRate !== expected.sampleRate || decoded.channels.length !== expected.channels || decoded.frames !== expected.frames || integrity !== expected.integrity) {
      throw new TuneError('ASSET_FAILED', `Asset '${assetId}' does not match the project manifest (expected ${expected.sampleRate} Hz/${expected.channels}ch/${expected.frames} frames, got ${decoded.sampleRate} Hz/${decoded.channels.length}ch/${decoded.frames} frames).`, 'Resolve the bytes recorded for this asset id.');
    }
    decodedAssets.set(assetId, { bytes, decoded });
  }
  // Phase 3: build, atomically — on failure dispose everything created and rethrow.
  const created: GraphNode[] = [];
  const createdParts: Part[] = [];
  const nodes = new Map<string, GraphNode>();
  try {
    const sorted = [...defs].sort(nodeSort);
    for (const def of sorted) {
      let node: GraphNode;
      switch (def.type) {
        case 'oscillator': node = engine.oscillator({ frequencyHz: def.frequencyHz, wave: def.wave }); break;
        case 'gain': { const gain = engine.gain(); gain.gain.set(def.params.gain); node = gain; break; }
        case 'filter': node = engine.filter({ type: def.filterType, frequencyHz: def.params.frequencyHz }); break;
        case 'instrument': {
          const instrument = engine.instrument(def.preset, { maxVoices: def.maxVoices });
          instrument.setEnvelope(def.envelope);
          instrument.level.set(def.params.level); instrument.filterHz.set(def.params.filterHz);
          node = instrument; break;
        }
        case 'kit': {
          const kit = engine.kit(def.preset, { maxVoices: def.maxVoices });
          kit.level.set(def.params.level);
          node = kit; break;
        }
        case 'sample': node = await engine.sample({ id: def.assetId, bytes: decodedAssets.get(def.assetId)!.bytes }); break;
        case 'bus': node = engine.bus({ gainDb: def.params.gainDb }); break;
        case 'pan': node = engine.pan({ pan: def.params.pan }); break;
        case 'delay': node = engine.delay({ time: { seconds: def.timeSeconds }, feedback: def.feedback, taps: def.taps, mix: def.params.mix }); break;
        case 'reverb': node = engine.reverb({ decay: { seconds: def.decaySeconds }, mix: def.params.mix }); break;
        case 'spatial': node = await engine.spatialSource({ rendering: 'stereo', position: def.position, direction: def.direction, distance: def.distance, cone: def.cone, smoothingSeconds: def.smoothingSeconds }); break;
        default: throw new TuneError('PROJECT_INVALID', `Node '${(def as { id?: string }).id}' has unknown type.`, 'Fix the project data and retry.');
      }
      node.nodeId = def.id;
      created.push(node);
      nodes.set(def.id, node);
    }
    for (const edge of connections) {
      const target = edge.to === 'output' ? engine.output : nodes.get(edge.to as string);
      nodes.get(edge.from as string)!.connect(target!);
    }
    engine.transport.setMeter({ beatsPerBar: finite((p.transport as { beatsPerBar: number })?.beatsPerBar, 1, 16, 'beats per bar') });
    engine.transport.bpm.set(finite((p.transport as { bpm: number })?.bpm, 20, 400, 'bpm'));
    engine.listener.setPose({ position: p.listener?.position, forward: p.listener?.forward, up: p.listener?.up }, { seconds: 0 });
    const builtPatterns = new Map<string, Pattern>();
    for (const def of patternDefs) builtPatterns.set(def.id, engine.pattern({ length: def.length, events: def.events }));
    for (const def of partDefs) {
      createdParts.push(engine.transport.schedule(builtPatterns.get(def.patternId)!, nodes.get(def.targetId) as Instrument | Kit | Sample, { at: { beats: def.startBeat }, loop: def.loop }));
    }
    let maxId = 0;
    for (const def of defs) { const n = Number(def.id.slice(1)); if (def.id.startsWith('n') && Number.isInteger(n) && n > maxId) maxId = n; }
    engine.continueNodeCounter(maxId);
    return { nodes, parts: createdParts };
  } catch (cause) {
    for (const part of createdParts) { try { part.cancel(); } catch { /* best effort */ } }
    for (const node of [...created].reverse()) { try { node.dispose(); } catch { /* best effort */ } }
    throw cause;
  }
}
