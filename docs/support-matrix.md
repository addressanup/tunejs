# Support matrix — `0.0.1-dev.0`

Generated-style summary of recorded evidence only. A cell says **Verified** when a run on
that host passed, **Simulator-only** when the pass is from an iOS simulator or Android
emulator (never a physical device), **Unsupported** when the capability rejects
`UNSUPPORTED` by design, and **Unknown** when no run was recorded. Nothing on this page is
a physical-device, latency, or listening claim; see the footnotes for evidence links.

| Host | Engine | Instruments | Samples | Transport | Stereo spatial | Binaural | Effects (delay/reverb) | Taps | Capture (mic) | Offline render |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Chromium / macOS (Chrome 152) | Verified¹ | Verified¹ | Verified¹ | Verified¹ | Verified¹ | Verified² | Verified² | Verified² | Verified³ | Verified⁴ |
| Firefox / macOS (156.0, headless) | Unknown⁵ | Unknown⁵ | Unknown⁵ | Unknown⁵ | Unknown⁵ | Verified⁶ | Verified⁶ | Verified⁷ | Unknown⁵ | Unknown⁸ |
| Safari / macOS (26.6.2) | Unknown⁵ | Unknown⁵ | Unknown⁵ | Unknown⁵ | Unknown⁵ | Verified⁹ | Verified⁹ | Unknown⁵ | Unknown⁵ | Unknown⁸ |
| Android Chrome emulator (124, API 35) | Simulator-only⁵ | Simulator-only⁵ | Simulator-only⁵ | Simulator-only⁵ | Simulator-only⁵ | Simulator-only⁶ | Simulator-only⁶ | Simulator-only⁷ | Unknown⁵ | Unknown⁸ |
| iOS simulator (iPhone 17 Pro, iOS 26.5) | Simulator-only¹⁰ | Simulator-only¹⁰ | Simulator-only¹⁰ | Simulator-only¹⁰ | Simulator-only¹⁰ | Simulator-only¹¹ | Simulator-only¹¹ | Simulator-only¹¹ | Unsupported¹² | Unknown⁸ |
| Android emulator (API 35 arm64) | Simulator-only¹⁰ | Simulator-only¹⁰ | Simulator-only¹⁰ | Simulator-only¹⁰ | Simulator-only¹⁰ | Simulator-only¹¹ | Simulator-only¹¹ | Simulator-only¹¹ | Unsupported¹² | Unknown⁸ |
| Electron 44.2 / macOS | Verified¹³ | Verified¹³ | Verified¹³ | Verified¹³ | Verified¹³ | Unknown¹³ | Verified¹³ | Verified¹³ | Unknown¹³ | Unknown¹³ |

## Footnotes

1. Browser smokes through the full `Engine` API on headless Chrome (instruments, kit,
   samples, mixing, living loop, spatial, capture, project round-trip, render) plus the
   ten-minute stereo reference workload: zero late/skipped/dropped events. Evidence:
   `docs/evidence/2026-09-12/` (`browser-*-smoke.json`, `wave5a/`, `wave5b/`, `wave6/`,
   `wave7/`, `wave8/`).
2. Fixture v8 `dsp-binaural-*` (6 kinds × 2 rates) and `dsp-delay`/`dsp-convolver` pass;
   `dsp-live-probes` v2 (5/5 incl. `dsp-binaural-live`); 600 s binaural workload, zero
   late/skipped/dropped. `docs/evidence/2026-09-13/binaural/`, `2026-09-13/dsp-path/`.
3. `browser-capture-smoke` passed (mic input, bounded recorder, meters, tap clock) in
   headless Chrome; a headless run cannot separate physical microphone or route behavior.
   `docs/evidence/2026-09-12/wave6/`.
4. `browser-render-smoke`: deterministic render, byte-identical repeat, WAV frame count
   matches range + tail. `Engine.render` is pure JS and host-independent.
   `docs/evidence/2026-09-12/wave7/`.
5. No Engine-level run recorded on this host — only the fixture/probe rows cited. Treat
   unlisted cells as unmeasured, not failing.
6. Every `dsp-*` fixture row at 44.1/48 kHz and all five `dsp-live-probes` v2 pass. The
   TuneJS DSP path (delay, convolver, binaural kernel) is engine-independent for these
   workloads. `docs/evidence/2026-09-15/host-matrix/`.
7. The live probes observe through the adapter's own PCM tap with 0 dropped frames and no
   startFrame discontinuities — the tap mechanism is verified; the `Engine.tap` wrapper
   was not exercised on this host. `docs/evidence/2026-09-15/host-matrix/`,
   `2026-09-13/dsp-path/`.
8. `Engine.render` is host-independent pure JS verified in Node and headless Chromium;
   its shared kernel also passed this host's `dsp-*` offline rows, but no `Engine.render`
   run was recorded here — marked Unknown rather than extrapolated.
9. Offline fixtures only: every `dsp-*` row passes at both rates. The sole failure is the
   raw-host `delayonly@48000` reference row (arithmeticError 1.0728836e-05, onset one
   frame early — a WebKit DelayNode rounding behavior, not a TuneJS defect; `dsp-delay`
   itself passed with error 0). Live probes are blocked pending one manual click
   (autoplay), so taps are unmeasured. `docs/evidence/2026-09-15/host-matrix/`.
10. Adapter-scheduled fixtures pass at both rates (the quarter-frame hostTime conversion
    lands on the requested frame); live probes show fan-in summing correctly, so
    polyphony/buses/transport are sound. Fan-out stays limited — user-level fan-out and
    host-node wet/dry reject `UNSUPPORTED`. `docs/evidence/2026-09-12/live-probes/`,
    `topology*/`, `docs/roadmap.md` wave notes. Example-app sections (first sound, living
    loop, spatial playground) run on these simulators; no workload, lifecycle-cycle, or
    audible-output measurement was made.
11. `dsp-live-probes` pass through the native worklet path when the app passes
    `react-native-worklets`: `dsp-delay-live`, `dsp-tail-live`, `dsp-convolver-live`,
    `dsp-mix-live`, `dsp-binaural-live` all pass with valueError 0; native PCM taps show
    0 dropped frames. Without `worklets`, effects/taps/recorder/meters/binaural reject
    `UNSUPPORTED`. `docs/evidence/2026-09-13/dsp-path/`, `2026-09-13/binaural/`.
12. Microphone capture is `UNSUPPORTED` by design: the host's recorder input pool can drop
    frames without reporting them, so drop accounting could not be guaranteed.
    `docs/backend-decision.md`, `docs/evidence/2026-09-13/dsp-path/`.
13. Two-minute reference-workload run (stereo mode), zero late/skipped/dropped events,
    through the browser adapter in an Electron shell — proves the browser adapter in a
    desktop shell, not a native desktop backend. Binaural, capture and offline render
    were not exercised in the run. `docs/evidence/2026-09-12/wave8/`.

## Explicitly not established anywhere

Physical iPhone or Android devices (one Nothing A059P Android run confirmed the host graph
limits are real hardware behavior — `docs/evidence/2026-09-12/physical-android/` — but made
no listening, latency, route, interruption, or workload measurement); input-to-output
latency; audible-dropout freedom (no host exposes an underrun counter); the headphone
listening review; and the usability evaluation (`docs/usability-script.md`).
