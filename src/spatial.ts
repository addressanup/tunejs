import type { HostBinauralNode, HostContext, HostGain, HostPanner } from './backend.js';
import type { Engine } from './engine.js';
import { TuneError, finite } from './errors.js';
import { GraphNode, Param } from './graph.js';
import { hrtfTableFor } from './hrtf.js';
import type { HrtfAsset } from './hrtf.js';

export type Vec3 = { x: number; y: number; z: number };
export interface Pose { position: Vec3; forward: Vec3; up: Vec3 }
export interface DistanceModel { reference: number; max: number; rolloff: number }
export interface Cone { innerDegrees: number; outerDegrees: number; outerGain: number }
export interface SpatialSourceOptions {
  rendering: 'stereo' | 'binaural';
  /** Required for `rendering: 'binaural'` — an HrtfAsset from engine.loadHrtf. */
  hrtf?: HrtfAsset;
  position?: Vec3;
  direction?: Vec3 | null;
  distance?: { reference?: number; max?: number; rolloff?: number };
  cone?: { innerDegrees?: number; outerDegrees?: number; outerGain?: number };
  smoothingSeconds?: number;
}
export interface StereoRenderResult { pan: number; gain: number; distance: number; azimuthDegrees: number; bearingDegrees: number; elevationDegrees: number }

const frozen3 = (v: Vec3): Vec3 => Object.freeze({ x: v.x, y: v.y, z: v.z });
const dot = (a: Vec3, b: Vec3): number => a.x * b.x + a.y * b.y + a.z * b.z;
const cross = (a: Vec3, b: Vec3): Vec3 => ({ x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x });
const length = (v: Vec3): number => Math.hypot(v.x, v.y, v.z);
const normalize = (v: Vec3): Vec3 => { const l = length(v); return { x: v.x / l, y: v.y / l, z: v.z / l }; };
const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

/** @internal */ export function validateVec3(value: Vec3 | null | undefined, name: string, allowNull = false): Vec3 | null {
  if (value === null || value === undefined) {
    if (allowNull) return null;
    throw new TuneError('INVALID_VALUE', `${name} must be a vector.`, 'Provide { x, y, z }.');
  }
  const v = { x: value.x, y: value.y, z: value.z };
  if (!Number.isFinite(v.x) || !Number.isFinite(v.y) || !Number.isFinite(v.z)) {
    throw new TuneError('INVALID_VALUE', `${name} must have finite components.`, 'Provide numbers for x, y and z.');
  }
  return v;
}

/** tunejs-stereo-v1: pure stereo rendering math shared by tests and the spatial source. */
export function stereoRender(listener: { position: Vec3; forward: Vec3; up: Vec3 }, source: { position: Vec3; direction: Vec3 | null; distanceModel: DistanceModel; cone: Cone }): StereoRenderResult {
  const r = { x: source.position.x - listener.position.x, y: source.position.y - listener.position.y, z: source.position.z - listener.position.z };
  const distance = length(r);
  let pan = 0;
  let azimuthDegrees = 0;
  let bearingDegrees = 0;
  let elevationDegrees = 0;
  if (distance >= 1e-9) {
    const right = normalize(cross(listener.forward, listener.up));
    const x = dot(r, right);
    const z = dot(r, listener.forward);
    elevationDegrees = Math.asin(clamp(dot(r, listener.up) / distance, -1, 1)) * 180 / Math.PI;
    if (x * x + z * z >= 1e-18) {
      const bearing = Math.atan2(x, z) * 180 / Math.PI;
      bearingDegrees = ((bearing % 360) + 360) % 360;
      let azimuth = bearing;
      if (azimuth > 90) azimuth = 180 - azimuth;
      else if (azimuth < -90) azimuth = -180 - azimuth;
      azimuthDegrees = azimuth;
      pan = clamp(azimuth / 90, -1, 1);
    }
  }
  const { reference, max, rolloff } = source.distanceModel;
  const d = clamp(distance, reference, max);
  const distanceGain = reference / (reference + rolloff * (d - reference));
  let coneGain = 1;
  if (source.direction && source.cone.outerDegrees < 360 && distance >= 1e-9) {
    const dir = normalize(source.direction);
    const toListener = normalize({ x: -r.x, y: -r.y, z: -r.z });
    const a = Math.acos(clamp(dot(dir, toListener), -1, 1)) * 180 / Math.PI;
    const ai = source.cone.innerDegrees / 2;
    const ao = source.cone.outerDegrees / 2;
    if (a <= ai) coneGain = 1;
    else if (a >= ao) coneGain = source.cone.outerGain;
    else coneGain = 1 - (a - ai) / (ao - ai) * (1 - source.cone.outerGain);
  }
  const gain = clamp(distanceGain * coneGain, 0, 1);
  return { pan, gain: Number.isFinite(gain) ? gain : 0, distance, azimuthDegrees, bearingDegrees, elevationDegrees };
}

export class Listener {
  #position: Vec3 = { x: 0, y: 0, z: 0 };
  #forward: Vec3 = { x: 0, y: 0, z: -1 };
  #up: Vec3 = { x: 0, y: 1, z: 0 };
  /** @internal */ constructor(readonly engine: Engine) {}
  get position(): Vec3 { return frozen3(this.#position); }
  get forward(): Vec3 { return frozen3(this.#forward); }
  get up(): Vec3 { return frozen3(this.#up); }
  setPose(pose: { position?: Vec3; forward?: Vec3; up?: Vec3 }, options: { seconds?: number } = {}): void {
    const seconds = finite(options.seconds ?? 0.02, 0, 10, 'smoothing seconds');
    const position = pose.position === undefined ? this.#position : validateVec3(pose.position, 'listener position')!;
    let forward = this.#forward;
    let up = this.#up;
    if (pose.forward !== undefined || pose.up !== undefined) {
      const f = validateVec3(pose.forward ?? this.#forward, 'listener forward')!;
      const u = validateVec3(pose.up ?? this.#up, 'listener up')!;
      if (length(f) < 1e-9 || length(u) < 1e-9) throw new TuneError('INVALID_VALUE', 'Listener forward and up must be nonzero.', 'Provide vectors with length.');
      const fn = normalize(f);
      const axis = cross(fn, normalize(u));
      if (length(axis) <= 1e-6) throw new TuneError('INVALID_VALUE', 'Listener forward and up must not be parallel.', 'Choose an up vector outside the forward axis.');
      forward = fn;
      up = normalize(cross(axis, fn)); // (f×u)×f — re-orthogonalized unit up
    }
    this.#position = position; this.#forward = forward; this.#up = up;
    for (const source of this.engine.spatial) source.evaluate(seconds);
  }
}

export class SpatialSource extends GraphNode {
  readonly rendering: 'stereo' | 'binaural';
  readonly hrtf?: HrtfAsset;
  #position: Vec3;
  #direction: Vec3 | null;
  readonly #distanceModel: DistanceModel;
  readonly #cone: Cone;
  readonly #smoothing: number;
  readonly #gain: Param;
  readonly #pan: Param;
  readonly #azimuth: Param;
  readonly #elevation: Param;
  /** @internal */ distanceGain?: HostGain;
  /** @internal */ panner?: HostPanner;
  /** @internal */ binaural?: HostBinauralNode;
  /** @internal */ constructor(engine: Engine, options: SpatialSourceOptions) {
    super(engine, 'spatial');
    if (!options || typeof options !== 'object') throw new TuneError('INVALID_VALUE', 'spatialSource needs options.', 'Pass { rendering: "stereo" }.');
    if (options.rendering !== 'stereo' && options.rendering !== 'binaural') throw new TuneError('INVALID_VALUE', 'Unknown spatial rendering mode.', "Use 'stereo' or 'binaural'.");
    if (options.rendering === 'binaural') {
      if (!engine.adapter.dsp) throw new TuneError('UNSUPPORTED', 'Binaural rendering needs the TuneJS DSP path on this host.', 'Use rendering: "stereo" or an adapter with a DSP path.');
      if (!options.hrtf) throw new TuneError('INVALID_VALUE', 'Binaural rendering needs an HRTF asset.', 'Pass { hrtf } from engine.loadHrtf().');
    }
    this.rendering = options.rendering;
    this.hrtf = options.hrtf;
    this.#position = validateVec3(options.position ?? { x: 0, y: 0, z: -1 }, 'position')!;
    this.#direction = validateVec3(options.direction ?? null, 'direction', true);
    if (this.#direction && length(this.#direction) < 1e-9) throw new TuneError('INVALID_VALUE', 'direction must be nonzero or null.', 'Use null for an omnidirectional source.');
    const reference = finite(options.distance?.reference ?? 1, 0, 1000, 'distance reference');
    if (reference <= 0) throw new TuneError('INVALID_VALUE', 'distance reference must exceed zero.', 'Choose a positive reference distance.');
    const max = finite(options.distance?.max ?? 50, 0, 10000, 'distance max');
    if (max < reference) throw new TuneError('INVALID_VALUE', 'distance max must be at least the reference distance.', 'Raise max or lower reference.');
    const rolloff = finite(options.distance?.rolloff ?? 1, 0, 10, 'distance rolloff');
    const innerDegrees = finite(options.cone?.innerDegrees ?? 360, 0, 360, 'cone innerDegrees');
    const outerDegrees = finite(options.cone?.outerDegrees ?? 360, 0, 360, 'cone outerDegrees');
    if (outerDegrees < innerDegrees) throw new TuneError('INVALID_VALUE', 'cone outerDegrees must be at least innerDegrees.', 'Widen the outer cone or narrow the inner.');
    const outerGain = finite(options.cone?.outerGain ?? 0, 0, 1, 'cone outerGain');
    this.#distanceModel = Object.freeze({ reference, max, rolloff });
    this.#cone = Object.freeze({ innerDegrees, outerDegrees, outerGain });
    this.#smoothing = finite(options.smoothingSeconds ?? 0.02, 0, 10, 'smoothing seconds');
    this.#gain = new Param(this, 1, 'spatial gain', 0, 1);
    this.#pan = new Param(this, 0, 'spatial pan', -1, 1);
    this.#azimuth = new Param(this, 0, 'spatial azimuth', 0, 360);
    this.#elevation = new Param(this, 0, 'spatial elevation', -90, 90);
    if (this.hrtf) engine.retainHrtf(this.hrtf, this);
  }
  get position(): Vec3 { return frozen3(this.#position); }
  get direction(): Vec3 | null { return this.#direction ? frozen3(this.#direction) : null; }
  get distanceModel(): DistanceModel { return Object.freeze({ ...this.#distanceModel }); }
  get cone(): Cone { return Object.freeze({ ...this.#cone }); }
  get smoothingSeconds(): number { return this.#smoothing; }
  /** @internal */ override get input() { return this.rendering === 'binaural' ? this.binaural : this.distanceGain; }
  setPosition(position: Vec3, options: { seconds?: number } = {}): void {
    this.assertAlive();
    this.#position = validateVec3(position, 'position')!;
    this.evaluate(finite(options.seconds ?? this.#smoothing, 0, 10, 'smoothing seconds'));
  }
  setDirection(direction: Vec3 | null, options: { seconds?: number } = {}): void {
    this.assertAlive();
    this.#direction = validateVec3(direction, 'direction', true);
    if (this.#direction && length(this.#direction) < 1e-9) throw new TuneError('INVALID_VALUE', 'direction must be nonzero or null.', 'Use null for an omnidirectional source.');
    this.evaluate(finite(options.seconds ?? this.#smoothing, 0, 10, 'smoothing seconds'));
  }
  /** @internal */ evaluate(seconds: number): void {
    const listener = this.engine.listener;
    const result = stereoRender(
      { position: listener.position, forward: listener.forward, up: listener.up },
      { position: this.#position, direction: this.#direction, distanceModel: this.#distanceModel, cone: this.#cone },
    );
    this.#gain.rampTo(result.gain, { seconds });
    if (this.rendering === 'binaural') {
      // Azimuth/elevation are set-only: the kernel crossfades between HRIR positions itself.
      this.#azimuth.set(result.bearingDegrees);
      this.#elevation.set(result.elevationDegrees);
    } else {
      this.#pan.rampTo(result.pan, { seconds });
    }
  }
  /** @internal */ override prepare(context: HostContext): void {
    if (this.rendering === 'binaural') {
      const node = this.engine.adapter.dsp!.createBinaural(context, {
        hrtf: hrtfTableFor(this.hrtf!, context.sampleRate),
        smoothingFrames: Math.max(1, Math.round(this.#smoothing * context.sampleRate)),
      });
      this.#gain.bind(node.gain);
      this.#azimuth.bind(node.azimuth);
      this.#elevation.bind(node.elevation);
      this.binaural = node; this.host = node;
      return;
    }
    let distanceGain: HostGain | undefined; let panner: HostPanner | undefined;
    try {
      distanceGain = context.createGain();
      this.#gain.bind(distanceGain.gain);
      panner = context.createStereoPanner();
      this.#pan.bind(panner.pan);
      distanceGain.connect(panner);
      this.distanceGain = distanceGain; this.panner = panner; this.host = panner;
    } catch (cause) {
      const errors: unknown[] = [cause];
      this.#gain.bind(); this.#pan.bind();
      try { distanceGain?.disconnect(); } catch (error) { errors.push(error); }
      try { panner?.disconnect(); } catch (error) { errors.push(error); }
      if (errors.length === 1) throw cause;
      throw new AggregateError(errors, 'Host graph preparation and cleanup failed.');
    }
  }
  override dispose(): void {
    this.engine.spatial.delete(this);
    if (this.hrtf) this.engine.releaseHrtf(this.hrtf, this);
    const errors: unknown[] = [];
    try { super.dispose(); } catch (error) { errors.push(error); }
    this.#gain.bind(); this.#pan.bind(); this.#azimuth.bind(); this.#elevation.bind();
    try { this.distanceGain?.disconnect(); } catch (error) { errors.push(error); }
    try { this.panner?.disconnect(); } catch (error) { errors.push(error); }
    try { this.binaural?.close(); } catch (error) { errors.push(error); }
    try { this.binaural?.disconnect(); } catch (error) { errors.push(error); }
    this.distanceGain = undefined; this.panner = undefined; this.binaural = undefined;
    if (errors.length) throw new TuneError('HOST_FAILURE', 'Host spatial source cleanup failed.', 'Dispose the engine to release remaining host resources.', { cause: new AggregateError(errors) });
  }
}
