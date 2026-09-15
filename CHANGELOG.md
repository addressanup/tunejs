# Changelog

All notable changes to TuneJS are documented in this file. The project is a private,
unpublished development snapshot; entries below describe the state of the working tree and
the evidence behind each claim, not a released package.

## 0.0.1-dev.0 — developer preview snapshot (unreleased)

A private preview implementing the [v0.1 release scope](docs/first-release-spec.md): one
coherent API to make, reshape, position, record, and export sound. There is no published
package, no `v0.1` tag, and no stable-API commitment at this version.

### Capabilities

- **Engine lifecycle and ownership** — lazy `Engine` construction (no activation, prompts,
  or fetching until `start()`), idempotent `start()`/`suspend()`/`dispose()`, per-engine
  graph/voice/asset ownership, and validated connections (`CROSS_ENGINE`, `INVALID_CONNECTION`
  rejections). Covered by the automated test suite (178 tests, `npm test`).
- **Instruments and presets** — envelope-controlled polyphonic instruments with note names
  and explicit frequencies, oldest-voice stealing, layered oscillator/noise voices, the
  `softKeys` and `pluck` presets, and the synthesized `softDrums` percussion kit. No
  downloaded preset assets; browser-verified (Chromium) via the first-sound and kit smoke
  runs under `docs/evidence/2026-09-12/`.
- **Samples** — `sample()` decodes PCM WAV assets (integer 8/16/24/32-bit and float32,
  including extensible wrapping) from bytes or a URL, with an id-keyed decoded cache,
  playback regions, looping, rate change (which also changes pitch), position reporting,
  and asynchronous seek.
- **Mixing** — buses, stereo pan, a finite feedforward delay, and the
  `synthetic-convolution-v1` reverb. On the browser adapter and on the native adapter's
  TuneJS DSP path these run inside TuneJS-owned worklet processors sharing the offline
  renderer's kernel; the raw-host delay/convolver fixtures remain failing references on
  native by design.
- **Transport and patterns** — finite pattern data, fractional beats, looping parts,
  phrase replacement at the next bar, cancellation, tempo changes acknowledged at a bar
  boundary, and late/skipped-event accounting. Positions are computed from absolute beats
  through the tempo map rather than accumulated.
- **Spatial** — one listener plus mono point emitters with distance attenuation,
  directivity cones, and smoothed pose changes. `stereo` rendering runs everywhere;
  `binaural` rendering uses the versioned SADIE II D1/KU100 HRTF asset
  (`tunejs-hrtf-v1`, 794 positions at 44.1/48 kHz, integrity-checked; Apache-2.0
  attribution in `assets/hrtf/NOTICE`) through the `tunejs-binaural-v1` kernel and never
  falls back silently.
- **Capture and UI data** — bounded PCM taps (`PCMChunk` async iterator with engine-frame
  timestamps and drop accounting), foreground microphone input (browser adapter only), a
  bounded in-memory recorder that fails on overflow rather than discarding audio, 16-bit
  WAV encoding with a clipped-sample count, and coalesced level/waveform meters.
- **Projects and offline rendering** — `tunejs-project` v1 export/import with an
  integrity-checked asset manifest and atomic import rollback, plus `Engine.render`, a
  deterministic TuneJS-DSP offline renderer (44.1/48 kHz, beat or second ranges, explicit
  tail, WAV output). Live host output and offline output are not claimed sample-equal.

### Verified hosts (evidence under `docs/evidence/`)

- **Chromium** (headless Chrome 152, macOS): full fixture suite (38/38 rows), live DSP
  probes (5/5), the ten-minute stereo reference workload and the 600 s binaural workload
  with zero late/skipped/dropped events, browser smokes for instruments, kits, samples,
  mixing, loops, spatial, capture, project round-trip, and render. —
  `2026-09-12/`, `2026-09-13/binaural/`, `2026-09-13/dsp-path/`
- **Firefox** (156.0 headless, macOS): all 38 fixture rows and all 5 live probes —
  the only host where the raw-host `delayonly@48000` reference row also passes. —
  `2026-09-15/host-matrix/`
- **Safari** (26.6.2, macOS): offline fixtures only — every `dsp-*` row passes at both
  rates; the single failure is the raw-host `delayonly@48000` reference row (host
  DelayNode rounding, not a TuneJS defect). Live probes are unmeasured, not failed:
  `AudioContext.resume()` pends without a user gesture and awaits one manual click. —
  `2026-09-15/host-matrix/`
- **Android Chrome emulator** (124.0.6367.219, API 35 arm64): 37/38 fixture rows (same
  raw-host `delayonly@48000` reference failure as Safari) and 5/5 live probes. —
  `2026-09-15/host-matrix/`
- **iOS simulator** (iPhone 17 Pro, iOS 26.5, Release) and **Android emulator** (API 35
  arm64, Release): the React Native adapter passes the DSP live probes (delay, tail,
  convolver, mix, binaural) and adapter-scheduled timing at both rates when the host app
  supplies `react-native-worklets`; fan-in sums correctly while user-level fan-out and
  microphone capture remain unsupported host limits. — `2026-09-12/live-probes/`,
  `2026-09-13/dsp-path/`, `2026-09-13/binaural/`
- **Electron** (44.2.0 / Chromium 152, macOS): a two-minute reference-workload run with
  zero late/skipped/dropped events through the browser adapter. — `2026-09-12/wave8/`

### Not established by evidence

Physical-device behavior (including a physical iPhone and Android Chrome on a device),
input-to-output latency, audible-dropout freedom (hosts expose no underrun counter), the
headphone listening review, and the usability evaluation remain open release gates. One
physical Android phone (Nothing A059P) confirmed the native host graph limits are real
hardware behavior, but no listening, latency, route, interruption, or workload measurement
was made on it. Simulator and emulator results do not establish physical-device claims.

### Known limitations

- React Native Audio API 0.13.3 delivers only one outgoing connection per node:
  user-level fan-out and host-node wet/dry effects reject `UNSUPPORTED`; the TuneJS DSP
  path carries delay/reverb/binaural natively instead.
- Native microphone capture is `UNSUPPORTED`: the host input pool can drop frames without
  reporting them.
- An intermittent `react-native-worklets` launch crash (one SIGSEGV during a worklet
  runtime creation) was observed once per platform; relaunch succeeds. Recorded host
  issue, not fixed.
- `stop()` on sample voices and `seek()` swaps are immediate, with no release fade or
  crossfade — abrupt endings can click.
