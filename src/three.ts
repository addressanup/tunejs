import { TuneError, finite } from './errors.js';
import type { Vec3 } from './spatial.js';
export type { Pose } from './spatial.js';
import type { Pose } from './spatial.js';

const readAxis = (elements: ArrayLike<number>, offset: number, name: string): Vec3 => {
  const v = { x: elements[offset]!, y: elements[offset + 1]!, z: elements[offset + 2]! };
  if (!Number.isFinite(v.x) || !Number.isFinite(v.y) || !Number.isFinite(v.z)) {
    throw new TuneError('INVALID_VALUE', `${name} matrix column must have finite components.`, 'Pass a column-major 4x4 world matrix.');
  }
  if (Math.hypot(v.x, v.y, v.z) < 1e-9) throw new TuneError('INVALID_VALUE', `${name} matrix column is zero-length.`, 'Pass a nondegenerate world matrix.');
  const l = Math.hypot(v.x, v.y, v.z);
  return { x: v.x / l, y: v.y / l, z: v.z / l };
};

/**
 * Read a listener pose from a column-major 4x4 world matrix (e.g. Three.js `matrixWorld.elements`).
 * Three cameras/objects look down local −Z, so forward is the negated third column.
 */
export function poseFromMatrix(elements: ArrayLike<number>, options: { metersPerUnit?: number } = {}): Pose {
  const metersPerUnit = finite(options.metersPerUnit ?? 1, 0, 1e6, 'meters per unit');
  if (metersPerUnit <= 0) throw new TuneError('INVALID_VALUE', 'metersPerUnit must exceed zero.', 'Choose a positive scale.');
  const zAxis = readAxis(elements, 8, 'basis Z');
  const forward = { x: -zAxis.x, y: -zAxis.y, z: -zAxis.z };
  const up = readAxis(elements, 4, 'basis Y');
  const position = { x: elements[12]! * metersPerUnit, y: elements[13]! * metersPerUnit, z: elements[14]! * metersPerUnit };
  if (!Number.isFinite(position.x) || !Number.isFinite(position.y) || !Number.isFinite(position.z)) {
    throw new TuneError('INVALID_VALUE', 'Matrix translation must have finite components.', 'Pass a column-major 4x4 world matrix.');
  }
  return { position, forward, up };
}

interface ThreeLike {
  matrixWorld: { elements: ArrayLike<number> };
  updateWorldMatrix?: (updateParents: boolean, updateChildren: boolean) => void;
}

/**
 * Read a pose from any object exposing `matrixWorld.elements` (Three.js Object3D shape — no three.js import).
 * With `update: true` (default) calls `object.updateWorldMatrix(true, false)` first, which refreshes the
 * world matrix including ancestors; it never writes position/rotation/scale.
 */
export function poseFromObject(object: ThreeLike, options: { metersPerUnit?: number; update?: boolean } = {}): Pose {
  if (!object || typeof object !== 'object' || !object.matrixWorld) throw new TuneError('INVALID_VALUE', 'Expected an object with matrixWorld.elements.', 'Pass a Three.js Object3D or a compatible shape.');
  if ((options.update ?? true) && typeof object.updateWorldMatrix === 'function') object.updateWorldMatrix(true, false);
  return poseFromMatrix(object.matrixWorld.elements, options);
}

/** World position only — for spatial emitters. */
export function positionFromObject(object: ThreeLike, options: { metersPerUnit?: number; update?: boolean } = {}): Vec3 {
  return poseFromObject(object, options).position;
}
