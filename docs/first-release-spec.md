# TuneJS v0.1 developer preview

Status: release specification, 2026-09-05. A [first-sound development snapshot](development.md) began on 2026-09-06; no v0.1 release exists. This document selects the first-release scope from the broader architecture and requirements research; it takes precedence over aspirational examples when deciding what v0.1 must ship.

## Outcome and audience

Enable JavaScript/TypeScript developers to make, reshape, position, record, and export sound through one coherent API. The preview serves creative coders, interactive-app developers, and developers building small music tools. It must demonstrate useful combinations rather than a catalogue of disconnected audio nodes.

Three complete experiences define success:

1. **Make a loop:** hear a preset instrument, sequence a phrase, add an effect, and change the phrase while it plays.
2. **Move through sound:** place multiple sounds around a listener, move either side, and hear the result through stereo or binaural rendering; connect the listener to a Three.js camera.
3. **Record and reuse:** observe microphone levels and live PCM, capture a short recording, reuse it as a sample, save an arrangement, and render WAV.

The framework remains independent of React, Three.js, and application UI. Examples and adapters may depend on those libraries. There is no hosted service, account system, marketplace, or complete DAW application in this release.

## Release boundary

| Area | Included in v0.1 | Deferred |
| --- | --- | --- |
| Hosts | Browser adapter; React Native adapters for iOS and Android; an Electron example using the browser adapter | Standalone Node-API audio-device backend, direct native-language public APIs |
| Sources | Decoded PCM WAV assets, mono/stereo buffers, oscillator/noise synthesis, reusable samples and playback voices | Long encoded media streams, HLS, extra codec guarantees |
| Instruments | An envelope-based polyphonic synthesizer; `softKeys` and a synthesized percussion preset; explicit note or frequency input | Large sample banks, physical modeling, broad preset collection |
| Mixing | Gain, buses, stereo pan, low/high-pass filters, delay, one documented reverb implementation, parameter ramps | Full mastering suite, arbitrary feedback graphs, automatic plugin latency compensation |
| Music | Finite patterns, fractional beats, looping, start/stop, fixed meter per project, tempo changes at a bar boundary, phrase replacement/cancellation | Continuous tempo ramps, meter changes within a project, notation DSL, MIDI device integration |
| Spatial | One listener, mono point emitters, distance/directivity, position/orientation, stereo and binaural/HRTF modes, Three.js pose adapter | Tracking-device adapters, room geometry/occlusion, ambisonics, speaker arrays, Doppler, propagation delay |
| Capture and analysis | Foreground microphone capture, bounded PCM tap, short in-memory recording, levels, waveform data, playhead/seek data | Continuous PCM playback input, network transport, background capture, unlimited recording, full spectral/MIR suite |
| Editing and extensions | Sample regions, reusable configuration presets, composition of built-in nodes | Independent pitch/time stretching, granular editing, arbitrary third-party DSP loading, denoising/AI |
| Sharing/output | Versioned project plus asset manifest, local bundle example, deterministic offline rendering, PCM WAV encoding | Cloud sharing, collaborative editing, professional plugin or DAW project export |
| Host lifecycle | Explicit activation, foreground interruption/recovery, capabilities, bounded teardown | Background playback guarantee, lock-screen/Bluetooth media-session controls |

**Support is earned per host.** Browser and both React Native targets are part of the preview acceptance matrix. Missing native capability is a release gap, not permission to label a browser-only build cross-platform. Earlier browser-only artifacts can be development snapshots. Electron proves the browser adapter in a desktop shell; it does not establish a native desktop audio backend.

Test Chromium and Firefox on a desktop host, Safari on macOS, Safari on a physical iPhone, Chrome on a physical Android device, and release-mode React Native applications on physical iOS/Android devices. Record exact versions and hardware with results. Check the Electron example on macOS initially; Windows/Linux desktop packaging is outside v0.1's verified matrix.

## Public contracts

Names below follow the proposed examples. TypeScript declarations must express these contracts; the backend may not leak its node classes into ordinary application code.

### Engine, assets, and ownership

- `Engine` construction performs no audio activation, permission prompts, or network fetching. `start()` is asynchronous and idempotent; applications handle rejection. Browser activation occurs directly inside a user gesture.
- Every engine owns its graph, assets, clock, and voices. Factories return owned objects, `connect()` returns its target, and connections are validated before application. Cross-engine connections fail explicitly. Nothing automatically routes microphone input to speakers.
- `sample()` accepts an application-resolved asset containing bytes or a host-readable URL and a stable project asset ID. Baseline decoding supports PCM WAV; other available codecs are reported, not assumed. Loading accepts cancellation and identifies failed assets.
- Assets and voices are distinct. `play()` returns a handle supporting stop, playback position, and asynchronous seek for decoded samples. Seek resolves with the position actually applied, while positions outside the selected sample region are rejected. Changing sample playback rate changes pitch as well; pitch-preserving time-stretch is not implied.
- `dispose()` is idempotent, cancels pending work, stops owned capture, and releases resources. Resource diagnostics distinguish cached assets from active graph/voice resources. The application owns its event listeners and UI subscriptions.

### Timing and musical expression

- Use explicit seconds, beats, or engine frame positions. Transport defaults to 120 BPM and 4/4; an explicit fixed meter and tempo may be chosen before start. Note strings default to A4 = 440 Hz with 12-tone equal temperament; explicit frequency input bypasses that tuning convention.
- Patterns are finite event data, not application callbacks executing on the audio deadline. Repeating patterns and phrase replacements return cancellable handles. Fractional beats, including thirds, are accepted; calculate event positions from absolute musical time rather than accumulating rounded intervals.
- `transport.bpm.set(value)` applies immediately while stopped and at the next bar while running. Running changes return an acknowledgement containing the effective beat; this rule is documented and shared by all hosts. BPM ramps in the broad examples are deferred.
- `part.replace(pattern, { boundary: 'next-bar' })` atomically changes future pattern events. Existing notes finish their current duration and envelope; replacement does not retrigger an old event. Cancellation prevents future note starts and releases the handle's active voices.
- Late scheduled events report their lateness; missed recurring events are never replayed in a burst after interruption. UI progress is observational and cannot drive the authoritative audio clock.
- Voice allocation defaults to 16 voices per instrument, with a documented oldest-voice stealing policy and a short release transition. Applications can lower the limit. Stress acceptance uses the smaller reference workload below, not a guarantee that every host runs every graph at the configured ceiling.

### Spatial audio

- `await engine.spatialSource({ rendering, position })` prepares either explicit `stereo` or `binaural` rendering. Unsupported modes and missing renderer assets reject; no silent substitution. Ship a documented first-party binaural integration even if its DSP is reused.
- Emitters accept mono point-source input and produce stereo output. Stereo assets require explicit downmix or separate emitters. Listener/source coordinates use meters, +Y up, -Z forward, and a right-handed system.
- Position and direction changes are smoothed on the audio timeline. Validate finite poses and nondegenerate listener orientation; source/listener coincidence must not create nonfinite samples. Distance and cone defaults and ranges must be documented alongside the selected renderer.
- The optional Three.js adapter reads world transforms, including transformed parents, and accepts an explicit world-units-to-meters scale. It never mutates scene objects. Core position/orientation control works without Three.js.
- Project data includes renderer configuration, HRTF asset identity, and scheduled trajectories. Offline rendering uses those same assets and movement. Live camera movement is reproducible only after the application records it as pose automation.

### Continuous capture and UI data

`engine.tap({ source, chunkFrames, maxBufferedFrames })` creates an asynchronous PCM iterator. Its minimum chunk shape is:

```ts
interface PCMChunk {
  sequence: number;
  startFrame: number;       // engine frame clock; not wall time
  sampleRate: number;
  channels: Float32Array[]; // planar; equal lengths; consumer-owned
  droppedFramesBefore: number;
}
```

- Default chunks contain 1024 frames; default queued capacity is one second at the engine sample rate, rounded up to a whole chunk. This batching is a delivery default, not the audio render-block size or a latency promise. Callbacks/iterator consumers run outside the audio render callback.
- A tap may observe a microphone or graph bus. Capture does not stop for a slow consumer: discard the oldest queued chunks when capacity is exceeded, report overflow, and mark the next delivered chunk's gap. Iterator cancellation releases the tap, not its shared source. Source/engine disposal terminates iteration with an explicit reason.
- The recorder uses bounded buffering too, but cannot silently discard audio: overflow fails the recording with a diagnostic. In-memory recordings default to a 60-second maximum and finalize with a duration-limit reason. Longer disk/network sinks are deferred. A stopped successful recording returns a reusable buffer plus WAV encoding.
- Level/waveform/playhead snapshots carry engine frame timestamps. UI subscriptions default to at most 30 updates per second and coalesce when the UI is busy. Consumers may poll instead. No per-sample React state updates or guarantee of sample-accurate UI notifications.
- Publish errors and cancellation behavior for permission denial, missing devices, capture interruption, slow consumers, invalid seek, and disposal. Physical microphone data is not deterministic; synthetic PCM sources provide exact test fixtures.

### Projects, rendering, and recovery

- Export graph configuration and scheduled arrangement, not runtime handles or permissions. Project version 1 and its typed asset manifest must round-trip every included built-in feature. Asset IDs resolve to bytes supplied by the application. The local sharing example writes project JSON and referenced assets together with relative paths; loading validates all references before replacing a working project.
- Live inputs/taps cannot silently disappear from an exported project. The record/reuse example finalizes and removes live capture resources, then explicitly places the resulting sample in an arrangement before saving it.
- Offline render declares sample rate, a half-open range, and effect tail. Support 44.1 kHz and 48 kHz output. PCM WAV export is 16-bit, clips only at the explicit encoder boundary, and reports clipping; internal render data stays float. Export contains rendered stereo audio, not spatial object metadata.
- Foreground apps pause transport on interruption. Explicit resume restores musical position without a burst of missed notes. Show actionable state when activation/recovery fails; a running clock alone must not be presented as proof that the user can hear sound. Include a user-triggered audio-test button and diagnostics.
- v0.1 advertises no background media-session capability. The adapter boundary reserves separate future support for playback services, lock-screen controls, and background recording; app backgrounding must not implicitly request those services.

## Creative examples to ship

Each example includes start/stop, visible state/errors, conservative levels, and complete teardown. Code is tested from the built package in a clean consumer project. Core examples share audio logic between browser and React Native; only host asset/permission and UI wiring differ.

| Example | Experience | Acceptance |
| --- | --- | --- |
| First sound | Press a button to hear `softKeys`; alter a filter and envelope | No downloaded preset assets; main audio setup/start/play sequence uses at most 20 nonblank statements excluding UI and error-display functions; no backend API calls |
| Living loop | Play a percussion pattern plus melodic phrase; replace the phrase and change tempo at the next bar | Both parts remain on the same beat grid; replacement occurs once at its acknowledged boundary; stop/cancel leaves no unintended held notes |
| Spatial playground | Move four mono sources around a listener; choose stereo or headphones; attach a camera in a separate Three.js variant | Same emitter API in both modes; correct world-transform conversion; moving/rotating/approaching sources has finite output and no reproducible movement-induced clicks |
| Record, reuse, share | Show mic waveform/levels and PCM delivery; capture 10 seconds, play/seek it, add a pattern, save and render | Live chunks arrive before stop; no implicit monitoring; bundle reopens in a clean environment; WAV duration and arrangement match the requested range/tail |

Usability evaluation target, separate from claims of measured performance: three developers unfamiliar with TuneJS should each obtain first sound within five minutes after the starter is installed and complete a pattern/effect/spatial modification within fifteen minutes using the docs. Record actual results when feedback is available; do not claim this target is met from automated example tests or contact participants without authorization.

## Requirement-to-acceptance matrix

Research IDs refer to [requirements research](requirements-research.md). All numbers below are engineering acceptance targets, not measured results or survey findings.

| Requirement | v0.1 disposition | Measurable acceptance |
| --- | --- | --- |
| R01 Startup/recovery | Included | 20 start/stop cycles and 10 interruption/resume cycles on each claimed physical host; no crash, duplicate voices, replay burst, or unexplained terminal state. Investigate silent output even when engine state says running. |
| R02 Timing/responsiveness | Included | Offline scheduled onsets are within one sample of the calculated frame, including boundaries and triplets. Pass the live reference workload below; report input-to-output latency separately. |
| R03 Portability | Included | Same core example logic and conformance fixtures pass in browser and release-mode React Native iOS/Android builds. Record exact tested versions; packaging requires no application-authored native audio callback. |
| R04 Live PCM | Capture/tap included; playback ingress deferred | A 10-second synthetic source produces ordered chunks with correct frame counts and timestamps. Forced slow consumption stays within configured queued capacity and reports every discontinuity; cancellation leaves no active tap. |
| R05 Visual data/seek | Included | Two simultaneous sample voices plus a 30 Hz meter/playhead subscription; repeated scrubbing acknowledges the final seek without stale updates overwriting it. Subscriptions cease after unsubscribe/disposal. |
| R06 Spatial | Included, both modes | Four emitters, listener rotation, mirrored positions, zero distance, directional cones, transformed camera parent, and non-unit scale pass fixtures. Binaural front/back/elevation cases match the chosen renderer's reference data within a documented tolerance. |
| R07 Sample transformation/custom DSP | Regions and built-in composition included; independent stretch and custom DSP deferred | Region playback obeys exact decoded-buffer bounds and loop count; invalid regions fail before playback. A reusable composed preset can be instantiated, automated, saved, rendered, and disposed through the ordinary graph. Docs do not present rate change as independent pitch/time control. |
| R08 Sharing/export | Included | Reopen a project and assets in a clean environment; deterministic render matches within declared numerical tolerances. Missing assets/versions fail without altering an already loaded project. WAV frame count equals the requested rendered range plus tail. |
| R09 Documentation | Included | Every v0.1 example compiles and runs against built artifacts; imports/types match; each page identifies version and host coverage. Deferred examples are labeled and excluded from preview API promises. |
| R10 Background/media controls | Deferred; foreground lifecycle included | Capability output marks background/media controls unsupported. Lock/background/foreground tests follow the declared pause/recovery policy in release builds; docs show no unsupported autoplay/background workaround. |
| R11 Musical depth | Escape hatches included | Triplet events do not accumulate rounding drift across 1,000 beats; explicit 432 Hz oscillator input has an estimated fundamental within 0.1 Hz in a 10-second offline fixture. Validate note/frequency input errors. |
| R12 Denoise/AI | Deferred | No speech model, service credential, or denoising dependency is required by the core examples; documentation marks these as future extensions. No denoising quality claim is made. |

### Reference workload and correctness checks

- At 48 kHz, run eight active voices: four mono sample loops through binaural emitters and four envelope-controlled oscillator voices through a shared filter/delay bus. Apply listener/source motion at 60 control updates per second and UI level/playhead reads at 30 Hz. Run for 10 minutes; impose a 100 ms busy period on the application JS thread once per second. Repeat in stereo mode.
- On each claimed test host, target zero engine-reported queue overflows/underruns and no reproducible audible dropouts under that workload. Where a host cannot expose underruns, say so and combine available render diagnostics with listening/loopback capture; absence of a counter is not a pass by itself. A failing host/workload is investigated before inclusion in the supported preview matrix.
- Measure median/p95 input-to-output latency on a declared wired or built-in route and document the measurement method. Bluetooth is reported separately when tested. No universal hardware-latency ceiling is promised by this specification.
- For shared arithmetic fixtures, use max absolute error <= 1e-5 for graph gain/mixing and onset position <= one sample. Backend-specific filters, reverb, and binaural processing get fixed reference fixtures, tolerances, and asset versions in the backend decision before acceptance runs; never tune tolerances after observing a regression to make it pass.
- After 100 create/play/stop/dispose cycles, owned voice/node/tap counters return to zero. With caches explicitly cleared, retained engine asset bytes return to zero. Track host process memory separately rather than assuming immediate garbage collection.
- Invalid graph connections, NaN parameters, missing HRTF data, denied microphone permission, encoder clipping, recorder overflow, and mid-load cancellation each have a reproducible fixture and an actionable error/result. Listening review covers preset levels, voice stealing, ramps, loops, and effect tails.

## Implementation order and release evidence

1. **Backend decision:** run a small shared contract through browser-native Web Audio plus an existing React Native foundation, and through the proposed shared C++/WASM candidate. Compare the same timing, spatial, capture, rendering, loading, and packaging fixtures. Prefer reuse if it meets the preview contracts; choose shared DSP only when documented gaps justify its additional implementation/maintenance cost. Record exact dependencies, HRTF assets, host versions, numerical tolerances, and decision evidence before building the full API. No backend winner is claimed at specification time.
2. **Core path:** implement engine/ownership, assets/voices, gain/filter routing, activation/disposal, diagnostics, and first-sound consumer tests on browser and native hosts.
3. **Expression and space:** add the bounded pattern transport, presets, effects, stereo/binaural emitters, world-pose adapter, and living-loop/spatial examples.
4. **Capture and completion:** add PCM tap, bounded recorder, waveform/playhead/seek, project/assets, offline rendering, and record/reuse/share example.
5. **Preview validation:** run the matrix and workload against the exact release candidate, produce versioned docs and limitations, and verify clean package installation. Evidence includes test output, device/version matrix, performance measurements, and reproducible demo projects.

This is a v0.1 developer preview with a narrow compatibility promise. Pre-1.0 API changes require release notes and migration examples. Package publication, branding/package-name availability, and final license selection remain separate release-preparation tasks; this specification neither performs nor claims publication.
