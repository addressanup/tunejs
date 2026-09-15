# HRTF asset and binaural renderer contracts

Status: contract for Wave 10. Behaviour described here is a specification until the evidence under `docs/evidence/` says otherwise.

## Dataset decision

TuneJS ships one first-party head-related impulse-response set prepared from the **SADIE II database, release v2-2, subject D1 (Neumann KU100 dummy head)** — University of York, Apache License 2.0 (`https://www.york.ac.uk/sadie-project/database.html`; archive `https://zenodo.org/records/10886409/files/D1.zip`, MD5 `468f0fce29c2f5880627c571b73e64c3`). Apache 2.0 permits redistribution in modified form with attribution; the dataset must be referenced whenever used and the paper cited for academic use: Armstrong, Thresh, Kearney, *A Perceptual Evaluation of Individual and Non-Individual HRTFs: A Case Study of the SADIE II Database*, Applied Sciences 8(11):2029, 2018, doi:10.3390/app8112029. The attribution travels with the asset (`assets/hrtf/NOTICE`) and inside the file header. HUTUBS (CC BY 4.0, SOFA only) was the alternative; SADIE II was chosen because its licence composes with a code licence without a separate attribution regime and it ships measured 44.1 kHz and 48 kHz WAV files, so no resampling of measurements is needed.

Measured facts used by the preparation script (from `D1/D1_HRIR_WAV/{44K_16bit,48K_24bit}`): 9201 files per rate on a dense, slightly irregular grid — 24 elevation rows, ~400 azimuths each at sub-degree spacing (filenames use comma decimals: `azi_103,3_ele_45,0.wav`); the target elevations −90…90 step 15 all exist exactly, and every non-pole row contains every integer azimuth, so all 794 asset positions are selected with **zero angular error** (the −90 pole stores a single measurement, `azi_0,0_ele_-90,0.wav`; the +90 pole's 400 redundant files resolve to `azi_0,0`). Files are stereo (left, right) with 256 taps at 44.1/48 kHz; the largest absolute sample is 0.9607 (`azi_80,0_ele_30,0`, 48 kHz), so int16 storage needs no scaling; SADIE azimuth is anticlockwise (90 = left) — at `azi_90` the left-ear energy is 37× the right-ear energy and the left peak leads by 47 frames.

## File format `tunejs-hrtf-v1`

Little-endian binary:

1. magic `TJHRTF01` (8 bytes ASCII);
2. `uint32` header length `N`;
3. `N` bytes UTF-8 JSON header;
4. body: `int16` samples in the layout the header declares.

Header fields (all required):

| field | value for the shipped asset |
| --- | --- |
| `format`, `version` | `"tunejs-hrtf"`, `1` |
| `id` | `"sadie2-d1-ku100-v1"` |
| `azimuthConvention` | `"clockwise-from-front-degrees"` — 0 front, 90 right, 180 back, 270 left |
| `elevations` | `[-90,-75,-60,-45,-30,-15,0,15,30,45,60,75,90]` |
| `azimuthStepDegrees` | `5` |
| `poles` | `"single"` — rows with |elevation| = 90 hold one position (azimuth 0) |
| `taps` | `256` |
| `sampleFormat` | `"int16"` |
| `rates` | `[44100, 48000]` |
| `positions` | `794` (11 rows × 72 + 2 poles) |
| `layout` | `"rate-major: for each rate, for each elevation row, for each azimuth ascending from 0: left[taps] then right[taps]"` |
| `peak` | largest absolute sample across both rates |
| `source` | dataset, release, subject, head, licence, URL, archive URL and MD5, file pattern, citation |
| `conversion` | `"asset azimuth = (360 − SADIE azimuth) mod 360; samples clamped and rounded to int16 via Math.round(v * 32768) (24-bit at 48 kHz, 16-bit at 44.1 kHz); no gain normalization"` |

Position index inside a rate block: rows in `elevations` order; within a row, azimuth `0, step, 2·step, …`; each position is `2 × taps` samples. The prepared file is about 1.6 MB and lives at `assets/hrtf/sadie2-d1-ku100-v1.tjhrtf`; `scripts/prepare-hrtf.mjs` rebuilds it from the archive and `--check` verifies the committed file byte-for-byte. Project documents reference the asset by `id` and `fnv1a64:` integrity over the whole file, like sample assets.

Decoding yields one `HrtfTable` (src/backend.ts) per sample rate: `rows[r]` is a `Float32Array(positions_r × 2 × taps)` with int16 samples divided by 32768. A context whose sample rate is not in `rates` rejects with `UNSUPPORTED`; TuneJS does not resample HRIRs.

## Renderer `tunejs-binaural-v1`

One processor node per emitter (browser AudioWorklet, native worklet node, offline renderer — same kernel):

- input: mono; a stereo input is averaged before rendering;
- `gain` (a-rate `Timeline`/AudioParam) multiplies the input per sample — the spatial source writes distance × cone attenuation into it exactly as the stereo renderer does;
- `azimuth`, `elevation` in degrees are read once per 128-frame block at the block start and mapped to the nearest table position: the elevation row minimising |elevation − row| (ties → the lower index), then `round(azimuth / step) mod (360 / step)` (pole rows → position 0);
- a change of position starts a linear crossfade over `smoothingFrames` frames between the old and the new HRIR pair, both convolving the same gained input: output = `(1 − w)·old + w·new` with `w = (i + 1) / smoothingFrames` for `i = 0 … smoothingFrames − 1`. While a crossfade is running, new positions are not adopted; the next block start after it finishes adopts the current value. `smoothingFrames = max(1, round(smoothingSeconds × sampleRate))` from the spatial source's `smoothingSeconds`;
- convolution is exact FIR (partitioned FFT in the kernel; the fixtures compare against direct convolution);
- output: stereo, left then right.

The spatial source computes `azimuth = atan2(x_right, z_forward)` in the listener basis (full circle, not folded like the stereo pan) and `elevation = asin(y_up / distance)`; at distance < 1e-9 both are 0. Direction, distance and cone maths are `tunejs-stereo-v1`'s.

Not claimed: localisation accuracy for any individual listener, headphone equalisation (the DT990 filters in the dataset are not shipped), room or distance cues beyond the attenuation model, near-field effects (the measurements are at 1.2 m).

## Acceptance

Fixture version 8 (`experiments/fixtures.js`) renders a deterministic synthetic table (`syntheticHrtfTable`: 30° grid, 64 taps, closed-form ITD/ILD/elevation taps) through the host's binaural node and compares against `binauralReference`, a direct-convolution implementation of the rules above, at 1e-5: front, right, mirror (left/right swap between +60° and −60°), elevation, a mid-render azimuth change with a 256-frame crossfade, and an a-rate gain ramp. The shipped SADIE asset is checked structurally (positions, taps, peak, integrity) and by direction sanity (left-ear energy dominates at azimuth 270, right-ear at 90, ears within 20 % at 0). Headphone listening review is a separate, human gate.
