#!/usr/bin/env node
// Builds (or --check verifies) assets/hrtf/sadie2-d1-ku100-v1.tjhrtf from the SADIE II v2-2
// subject D1 archive. Source resolution order: artifacts/hrtf-source/D1/ (extracted cache),
// /tmp/sadie/D1/ (pre-seeded cache), else download D1.zip from Zenodo into artifacts/hrtf-source/,
// verify the documented MD5, and extract it there. Requires `dist/` (npm run build).
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodeWav } from '../dist/assets.js';
import { decodeHrtfAsset, encodeHrtfAsset, fnv1a64Bytes } from '../dist/hrtf.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const CACHE = join(root, 'artifacts/hrtf-source');
const TMP = '/tmp/sadie';
const ASSET = join(root, 'assets/hrtf/sadie2-d1-ku100-v1.tjhrtf');
const INTEGRITY = join(root, 'assets/hrtf/sadie2-d1-ku100-v1.integrity.json');
const URL = 'https://zenodo.org/records/10886409/files/D1.zip';
const MD5 = '468f0fce29c2f5880627c571b73e64c3';
const ELEVATIONS = [-90, -75, -60, -45, -30, -15, 0, 15, 30, 45, 60, 75, 90];
const STEP = 5, TAPS = 256;
const RATES = [{ rate: 44100, dir: '44K_16bit' }, { rate: 48000, dir: '48K_24bit' }];

function findSource() {
  for (const base of [join(CACHE, 'D1'), join(TMP, 'D1')]) {
    if (existsSync(join(base, 'D1_HRIR_WAV/48K_24bit')) && existsSync(join(base, 'D1_HRIR_WAV/44K_16bit'))) return base;
  }
  return null;
}

async function ensureSource() {
  const cached = findSource();
  if (cached) return cached;
  mkdirSync(CACHE, { recursive: true });
  const zip = join(CACHE, 'D1.zip');
  if (!existsSync(zip)) {
    process.stdout.write(`Downloading ${URL} …\n`);
    const response = await fetch(URL);
    if (!response.ok) throw new Error(`Zenodo returned HTTP ${response.status}`);
    writeFileSync(zip, Buffer.from(await response.arrayBuffer()));
  }
  const digest = createHash('md5').update(readFileSync(zip)).digest('hex');
  if (digest !== MD5) throw new Error(`D1.zip MD5 ${digest} !== ${MD5}`);
  execFileSync('unzip', ['-oq', zip, '-d', CACHE]);
  const base = join(CACHE, 'D1');
  if (!existsSync(join(base, 'D1_HRIR_WAV/48K_24bit'))) throw new Error('archive did not contain D1/D1_HRIR_WAV');
  return base;
}

const fmt = n => Number.isInteger(n) ? `${n},0` : String(n).replace('.', ',');
const sadieFile = (dir, sadieAz, el) => `azi_${fmt(sadieAz)}_ele_${fmt(el)}.wav`;

function buildTables(base) {
  let peak = 0;
  const tables = new Map();
  for (const { rate, dir } of RATES) {
    const rows = ELEVATIONS.map(el => {
      const count = Math.abs(el) === 90 ? 1 : 360 / STEP;
      const row = new Float32Array(count * 2 * TAPS);
      for (let p = 0; p < count; p++) {
        const sadieAz = count === 1 ? 0 : (360 - p * STEP) % 360;
        const wav = decodeWav(readFileSync(join(base, 'D1_HRIR_WAV', dir, sadieFile(dir, sadieAz, el))));
        if (wav.channels.length !== 2 || wav.frames < TAPS) throw new Error(`${sadieFile(dir, sadieAz, el)}: ${wav.channels.length}ch ${wav.frames} frames`);
        for (let ear = 0; ear < 2; ear++) for (let i = 0; i < TAPS; i++) {
          const v = wav.channels[ear][i];
          row[p * 2 * TAPS + ear * TAPS + i] = v;
          peak = Math.max(peak, Math.abs(v));
        }
      }
      return row;
    });
    tables.set(rate, { id: 'sadie2-d1-ku100-v1', sampleRate: rate, taps: TAPS, elevations: ELEVATIONS.slice(), azimuthStepDegrees: STEP, rows });
  }
  return { tables, peak };
}

function header(peak) {
  return {
    format: 'tunejs-hrtf', version: 1, id: 'sadie2-d1-ku100-v1',
    azimuthConvention: 'clockwise-from-front-degrees',
    elevations: ELEVATIONS, azimuthStepDegrees: STEP, poles: 'single',
    taps: TAPS, sampleFormat: 'int16', rates: RATES.map(r => r.rate),
    positions: ELEVATIONS.reduce((n, el) => n + (Math.abs(el) === 90 ? 1 : 360 / STEP), 0),
    layout: 'rate-major: for each rate, for each elevation row, for each azimuth ascending from 0: left[taps] then right[taps]',
    peak,
    source: {
      dataset: 'SADIE II Database', release: 'v2-2', subject: 'D1', head: 'Neumann KU100',
      licence: 'Apache License 2.0',
      url: 'https://www.york.ac.uk/sadie-project/database.html',
      archive: URL, md5: MD5,
      files: 'D1/D1_HRIR_WAV/{44K_16bit,48K_24bit}/azi_<A,0>_ele_<E,0>.wav',
      citation: 'Armstrong, Thresh, Kearney, A Perceptual Evaluation of Individual and Non-Individual HRTFs: A Case Study of the SADIE II Database, Applied Sciences 8(11):2029, 2018, doi:10.3390/app8112029',
    },
    conversion: 'asset azimuth = (360 - SADIE azimuth) mod 360; samples clamped and rounded to int16 via Math.round(v * 32768) (24-bit at 48 kHz, 16-bit at 44.1 kHz); no gain normalization',
  };
}

async function main() {
  const check = process.argv.includes('--check');
  if (check) {
    const committed = readFileSync(ASSET);
    const meta = JSON.parse(readFileSync(INTEGRITY, 'utf8'));
    const integrity = fnv1a64Bytes(committed);
    if (integrity !== meta.integrity) throw new Error(`integrity mismatch: ${integrity} !== ${meta.integrity}`);
    if (committed.length !== meta.bytes) throw new Error(`size mismatch: ${committed.length} !== ${meta.bytes}`);
    const decoded = decodeHrtfAsset(committed);
    if (decoded.header.positions !== meta.positions || decoded.header.taps !== meta.taps) throw new Error('committed asset does not match the integrity record');
    const base = findSource();
    try {
      if (!base) throw new Error('no archive cache present');
      const { tables, peak } = buildTables(base);
      const rebuilt = encodeHrtfAsset(header(peak), tables);
      if (Buffer.compare(Buffer.from(rebuilt), committed) !== 0) throw new Error('rebuilt asset differs from the committed file');
      process.stdout.write('HRTF asset verified against the archive (byte-for-byte)\n');
    } catch (error) {
      if (String(error).includes('differ')) throw error;
      process.stdout.write(`HRTF asset verified against integrity record (archive unavailable: ${String(error).slice(0, 120)})\n`);
    }
    return;
  }
  const base = await ensureSource();
  const { tables, peak } = buildTables(base);
  const bytes = encodeHrtfAsset(header(peak), tables);
  mkdirSync(dirname(ASSET), { recursive: true });
  writeFileSync(ASSET, bytes);
  writeFileSync(INTEGRITY, JSON.stringify({
    integrity: fnv1a64Bytes(bytes), bytes: bytes.length,
    positions: header(peak).positions, taps: TAPS, rates: RATES.map(r => r.rate),
  }, null, 2) + '\n');
  process.stdout.write(`wrote ${ASSET} (${bytes.length} bytes, peak ${peak})\n`);
}
main().catch(error => { console.error(error); process.exit(1); });
