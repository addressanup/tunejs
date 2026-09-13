import type { HrtfTable } from './backend.js';
import { TuneError } from './errors.js';

/**
 * tunejs-hrtf-v1 asset codec — see docs/hrtf-asset.md.
 * Binary: magic 'TJHRTF01', u32 little-endian header length, UTF-8 JSON header, then int16
 * samples rate-major (each rate: elevation rows in order, azimuths ascending, left[taps] then
 * right[taps] per position). Decoded rows are float32 = int16 / 32768.
 */
export const HRTF_MAGIC = 'TJHRTF01';

export interface HrtfHeader {
  format: 'tunejs-hrtf';
  version: 1;
  id: string;
  azimuthConvention: string;
  elevations: number[];
  azimuthStepDegrees: number;
  poles: string;
  taps: number;
  sampleFormat: 'int16';
  rates: number[];
  positions: number;
  layout: string;
  peak: number;
  source: Record<string, unknown>;
  conversion: string;
}

export interface HrtfAsset {
  id: string;
  integrity: string;
  header: HrtfHeader;
  tables: Map<number, HrtfTable>;
}

const failed = (reason: string): TuneError => new TuneError('ASSET_FAILED', `HRTF asset: ${reason}.`, 'Rebuild the asset with scripts/prepare-hrtf.mjs or check the file.');

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;
const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v);

/** Positions of one elevation row under the 'single'-pole rule. */
export function hrtfRowPositions(elevation: number, azimuthStepDegrees: number): number {
  return Math.abs(elevation) === 90 ? 1 : 360 / azimuthStepDegrees;
}

/** Serialize a header + tables map into the tunejs-hrtf-v1 binary. `header` is written verbatim. */
export function encodeHrtfAsset(header: HrtfHeader, tables: Map<number, HrtfTable>): Uint8Array {
  const json = new TextEncoder().encode(JSON.stringify(header));
  const positionsPerRate = header.elevations.reduce((n, el) => n + hrtfRowPositions(el, header.azimuthStepDegrees), 0);
  const body = positionsPerRate * 2 * header.taps * header.rates.length;
  const bytes = new Uint8Array(8 + 4 + json.length + body * 2);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < 8; i++) bytes[i] = HRTF_MAGIC.charCodeAt(i);
  view.setUint32(8, json.length, true);
  bytes.set(json, 12);
  let p = 12 + json.length;
  for (const rate of header.rates) {
    const table = tables.get(rate);
    if (!table) throw new TuneError('INVALID_VALUE', `encodeHrtfAsset: no table for rate ${rate}.`, 'Provide a table for every header.rates entry.');
    for (let r = 0; r < header.elevations.length; r++) {
      const count = hrtfRowPositions(header.elevations[r]!, header.azimuthStepDegrees);
      const row = table.rows[r]!;
      if (row.length !== count * 2 * header.taps) throw new TuneError('INVALID_VALUE', `encodeHrtfAsset: row ${r} at ${rate} Hz has ${row.length} samples, expected ${count * 2 * header.taps}.`, 'Match the declared layout.');
      for (let i = 0; i < row.length; i++) { view.setInt16(p, Math.max(-32768, Math.min(32767, Math.round(row[i]! * 32768))), true); p += 2; }
    }
  }
  return bytes;
}

export function decodeHrtfAsset(input: ArrayBuffer | ArrayBufferView): HrtfAsset {
  const bytes = input instanceof ArrayBuffer ? new Uint8Array(input) : new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  if (bytes.length < 12) throw failed('file is shorter than the 12-byte preamble');
  for (let i = 0; i < 8; i++) if (bytes[i] !== HRTF_MAGIC.charCodeAt(i)) throw failed('bad magic — not a tunejs-hrtf file');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const headerLength = view.getUint32(8, true);
  if (headerLength <= 0 || 12 + headerLength > bytes.length) throw failed('header length is out of range');
  let header: HrtfHeader;
  try { header = JSON.parse(new TextDecoder().decode(bytes.subarray(12, 12 + headerLength))); }
  catch { throw failed('header is not UTF-8 JSON'); }
  const h = header as unknown as Record<string, unknown>;
  for (const field of ['format', 'version', 'id', 'azimuthConvention', 'elevations', 'azimuthStepDegrees', 'poles', 'taps', 'sampleFormat', 'rates', 'positions', 'layout', 'peak', 'source', 'conversion']) {
    if (h[field] === undefined) throw failed(`header is missing '${field}'`);
  }
  if (header.format !== 'tunejs-hrtf' || header.version !== 1) throw failed(`unsupported format '${String(header.format)}' version ${String(header.version)}`);
  if (!header.id) throw failed('header id is empty');
  if (!Array.isArray(header.elevations) || !header.elevations.length || !header.elevations.every(v => typeof v === 'number' && Math.abs(v) <= 90)) throw failed('elevations must be numbers within ±90°');
  for (let i = 1; i < header.elevations.length; i++) if (header.elevations[i]! <= header.elevations[i - 1]!) throw failed('elevations must be strictly increasing');
  if (!isInt(header.azimuthStepDegrees) || header.azimuthStepDegrees <= 0 || 360 % header.azimuthStepDegrees !== 0) throw failed('azimuthStepDegrees must divide 360');
  if (header.poles !== 'single') throw failed(`unsupported poles layout '${String(header.poles)}'`);
  if (!isInt(header.taps) || header.taps <= 0) throw failed('taps must be a positive integer');
  if (header.sampleFormat !== 'int16') throw failed(`unsupported sampleFormat '${String(header.sampleFormat)}'`);
  if (!Array.isArray(header.rates) || !header.rates.length || !header.rates.every(isInt)) throw failed('rates must be a nonempty integer list');
  const expectedPositions = header.elevations.reduce((n, el) => n + hrtfRowPositions(el, header.azimuthStepDegrees), 0);
  if (header.positions !== expectedPositions) throw failed(`positions ${header.positions} does not match the layout (${expectedPositions})`);
  const bodySamples = expectedPositions * 2 * header.taps * header.rates.length;
  if (bytes.length !== 12 + headerLength + bodySamples * 2) throw failed(`body is ${bytes.length - 12 - headerLength} bytes, expected ${bodySamples * 2}`);
  const tables = new Map<number, HrtfTable>();
  let p = 12 + headerLength;
  for (const rate of header.rates) {
    const rows = header.elevations.map(el => {
      const length = hrtfRowPositions(el, header.azimuthStepDegrees) * 2 * header.taps;
      const row = new Float32Array(length);
      for (let i = 0; i < length; i++) { row[i] = view.getInt16(p, true) / 32768; p += 2; }
      return row;
    });
    tables.set(rate, { id: header.id, sampleRate: rate, taps: header.taps, elevations: header.elevations.slice(), azimuthStepDegrees: header.azimuthStepDegrees, rows });
  }
  return { id: header.id, integrity: fnv1a64Bytes(bytes), header, tables };
}

/** The table for `sampleRate`, or an UNSUPPORTED error listing the rates the asset has. */
export function hrtfTableFor(asset: HrtfAsset, sampleRate: number): HrtfTable {
  const table = asset.tables.get(sampleRate);
  if (!table) throw new TuneError('UNSUPPORTED', `HRTF asset has no ${sampleRate} Hz table.`, `Use a context at one of ${[...asset.tables.keys()].join(', ')} or an asset prepared for it.`);
  return table;
}

/** FNV-1a 64 over raw bytes, as 'fnv1a64:' + 16 hex digits. */
export function fnv1a64Bytes(bytes: ArrayBuffer | ArrayBufferView): string {
  const view = bytes instanceof ArrayBuffer ? new Uint8Array(bytes) : new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let hash = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  const mask = 0xffffffffffffffffn;
  for (let i = 0; i < view.length; i++) hash = ((hash ^ BigInt(view[i]!)) * prime) & mask;
  return `fnv1a64:${hash.toString(16).padStart(16, '0')}`;
}
