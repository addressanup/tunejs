# TuneJS architecture

Status: proposed architecture. Product direction is established; backend performance and compatibility remain unverified. The creative API examples are design targets, not a frozen public API.

The [requirements research](requirements-research.md) records public workflow evidence and proposed refinements. The [v0.1 specification](first-release-spec.md) now defines the preview contracts for continuous PCM capture, UI-facing playhead data, project completion, and explicit foreground lifecycle behavior. PCM playback ingress and host media sessions are deferred. That specification takes precedence for first-release scope; the architecture below describes the broader destination.

## Product contract

TuneJS serves JavaScript/TypeScript developers building in browsers, React Native, and JavaScript desktop hosts. Its foundations cover playback, synthesis, processing, mixing, musical time, spatial sound, capture, rendering, and analysis. Specialized integrations extend those foundations.

The public API is independent of UI frameworks and backend node types. Common creative tasks have useful defaults. Advanced work uses the same graph and timing model through documented extensions.

## Architecture layers

```text
Applications, interactive examples, optional UI adapters
                         |
Instruments / patterns / spatial scenes / recording / analysis
                         |
Engine / graph / parameters / transport / assets / projects
                         |
Typed commands, scheduled events, capabilities, diagnostics
                         |
Rendering core + host adapters
       |                    |                    |
Browser AudioWorklet   React Native JSI     Node-API desktop
```

The drawing describes responsibility, not a requirement that every module load for every application. Build outputs must permit explicit feature and preset imports.

### Shared concepts and ownership

| Concept | Responsibility |
| --- | --- |
| Engine | Own graph objects, clock, output, backend session, and asset references |
| Source / Voice | Separate reusable sound configuration from an individual playback instance |
| Processor / Bus | Transform or combine audio through typed input and output ports |
| Param | Declare units, valid values, automation, and supported modulation |
| Transport / Pattern | Express tempo, musical position, repeating content, and scheduling |
| Listener / Spatial source | Represent listening pose and positioned sound |
| Analyzer / Recorder | Observe or capture audio without requiring an audible output connection |
| Project | Store a versioned graph and arrangement with asset and extension references |

Factories register objects with their engine. An object cannot connect to another engine's graph. Objects support explicit, idempotent disposal; engine disposal tears down everything it owns. Shared assets are reference-counted inside an engine. Cross-engine sharing requires an explicit asset facility in a later version.

Connections validate port compatibility and channel layouts before being applied. Duplicate identical connections are idempotent. Ordinary routing is acyclic; feedback is supported inside dedicated delay/effect implementations initially. A later graph-feedback feature must define minimum delay and stability rules.

### Control and rendering

The application thread constructs graphs and schedules changes. The rendering side applies validated commands at audio-block boundaries and scheduled events at their sample offsets. UI callbacks are observers, not the source of musical timing accuracy.

Rendering must avoid blocking I/O, locks that can wait on the UI, and unbounded allocation. Graph resources are prepared away from the render callback. Bounded command queues coalesce replaceable live parameter updates; capacity failures are reported rather than silently dropping musical events. Release graph resources only after the rendering side has stopped referencing them.

Parameter changes use documented smoothing. Rewiring is atomic at a block boundary, but arbitrary graph swaps are not automatically click-free: seamless replacement requires a supported crossfade and its temporary CPU budget. Output levels default conservatively; clipping metering is explicit, and any protective limiter is a visible, configurable processor.

### Backend candidate and validation boundary

One candidate is a shared C++ DSP/rendering core compiled to WebAssembly for the browser and native binaries elsewhere. In that candidate, browser device I/O uses Web Audio through an AudioWorklet and native device I/O uses miniaudio; React Native integrates through JSI and a later desktop native backend through Node-API. Electron can also run the browser backend. The v0.1 decision compares this design with existing browser/native foundations and prefers reuse when it satisfies the release contracts.

This candidate aims to share DSP and scheduling semantics. It is not an established performance result. Before freezing it, test browser startup, processor loading, graph updates, mobile interruptions, native packaging, and offline/live render agreement. Compare a minimal Web Audio node implementation as an experimental control, not as a second production backend commitment.

Also evaluate an existing native foundation, such as React Native Audio API, against the same creative examples and host tests. The research supports reducing integration work; it does not establish that a bespoke C++ renderer or JSI bridge is the best route. Record reuse, extension compatibility, packaging, and maintenance tradeoffs alongside performance results.

Native bridges must not route each audio block through application JavaScript. Browser transport should work without requiring shared memory for the baseline feature set; shared-memory acceleration may be capability-gated. Extensions must declare their worklet/native artifacts and supported hosts.

### Time and automation

- Each engine owns a sample-frame clock; seconds are a conversion at the engine sample rate. Device rate conversion is the backend's responsibility.
- Musical scheduling uses beats and an explicit tempo map, initially 120 BPM and 4/4. Beat zero is the beginning of the arrangement. No ambiguous bare numbers for scheduled times or durations.
- Transport position advances only while running. Engine time and effect tails can continue when transport is stopped. Stop cancels future transport events and releases transport-owned voices with their envelopes; immediate voices have separate lifetimes.
- Tempo edits affect future beat-based events and the musical endpoints of beat-based durations; absolute second-based events retain their times. Committed render-block events cannot be changed retroactively.
- Late immediate events run at the next available render position and emit lateness diagnostics. Strict scheduled/offline validation can reject invalid past events. Recurring playback never emits a burst of missed notes after recovery.
- Live `set`/`rampTo` commands supersede pending automation on that parameter from the current render time. Explicit timeline automation uses ordered events, with last-submitted precedence at the same timestamp.
- A scheduled handle supports cancellation and replacement. UI observers may arrive late and must not be described as sample-accurate callbacks.

### Spatial audio

Spatial audio is part of the framework's shared model and early implementation path. Any compatible source or bus can feed a spatial emitter, so instruments, recordings, and procedural sounds use the same spatial controls.

- **Scene model:** one listener per engine initially, independent source poses, and automatable position, orientation, distance attenuation, and directional cones. Use meters, a right-handed coordinate system, +Y up, and -Z forward. Reject nonfinite coordinates and degenerate listener orientations. Coincident source/listener positions must remain finite and well-defined.
- **Rendering modes:** ship stereo equal-power spatial panning first, followed by first-party binaural/HRTF rendering for headphones. Applications select the mode explicitly; a request for binaural rendering fails clearly when unavailable and never silently becomes stereo panning. Generic HRTFs do not guarantee identical localization for every listener.
- **Preparation and channels:** `engine.spatialSource(options)` asynchronously prepares renderer resources before returning the processor. Initial emitters take mono point-source input and produce stereo output; stereo material needs an explicit downmix or separate emitters. HRTF data must have documented redistribution terms, versioned asset identity, sample-rate handling, and shared caching.
- **Movement:** smooth pose updates using the engine clock. Position changes alone do not imply Doppler pitch shifts or propagation delay; those require explicit later features. Listener orientation changes the listening frame without rewriting source world coordinates.
- **Composition:** normal effects and buses work before or after spatial processing, with channel validation. Listener poses, emitter settings, rendering mode, renderer asset references, and scheduled trajectories belong in saved projects and offline renders. Live tracking must be recorded as pose automation to reproduce it offline.
- **Integration:** optional Three.js and XR/head-tracking adapters supply world poses and timestamps through the same API. TuneJS core does not depend on Three.js, a camera, a sensor, or an XR session. Tracking loss holds the last valid pose and reports state to the application; explicit application actions control recentering.
- **Expansion:** room reflections/reverb zones, occlusion, ambisonics, and multichannel speaker output use declared spatial extension contracts. Generic reverb alone is not a claim of geometric room simulation. Object-scene exports and binaural stereo WAV exports are distinct deliverables; spatial object metadata is not implied by WAV encoding.

Spatial acceptance includes moving sources, rotating the listener, distance/directivity changes, multiple emitters, render-mode failures, and reproducible offline trajectories. HRTF selection and processing cost are part of backend feasibility work, not deferred until release.

### Lifecycle, capabilities, and errors

Construction is side-effect-light: no device activation, sample fetch, or permission prompt on import. Engine states are idle, starting, running, suspended, interrupted, failed, and disposed. Start is idempotent; concurrent starts share the same activation attempt.

Capabilities distinguish support from authorization and current availability. Report capture, MIDI, streaming seek, codecs, HRTF, offline rendering, and custom processor support separately. An unavailable feature returns a typed error; it does not quietly produce a different sound or discard content.

Host adapters own permission requests, route changes, device loss, and foreground/background transitions. On interruption, freeze musical position and notify the application. Resume without replaying missed events when the host permits; otherwise expose an explicit user-action recovery path. Timeline continuity does not guarantee uninterrupted hardware output.

Errors carry a stable code, affected resource, context, and recovery guidance. Asset loading supports cancellation and deduplicates requests. Failed loading leaves existing working graph content intact. Diagnostics include output latency when available, active voices, queue pressure, memory counters, clipping, and underruns when the host exposes them.

### Capture, projects, and offline output

Recording explicitly selects an input or bus. Microphone capture never auto-connects to speakers. Capture uses bounded buffers and reports overflow; lengthy recording needs a supported streaming sink rather than unlimited in-memory accumulation.

Projects serialize version, graph configuration, parameter automation, musical arrangement, reproducible random seeds, asset references, and extension identities/versions. They exclude permissions, open devices, UI callbacks, and live playback handles. Loading validates the whole description before changing a working graph. Unknown versions or missing extensions produce diagnostics.

Offline rendering uses the same graph semantics, a declared sample rate, an explicit range and tail, and an application-provided asset resolver. It rejects live inputs and non-renderable extensions unless the application explicitly substitutes recorded content. Baseline export is PCM WAV; other encoders are optional. Numerical tolerance, not byte identity across all CPUs, governs shared DSP conformance.

### Extensions

Separate safe composition of built-in nodes from custom real-time DSP. Composition extensions declare ports, parameters, state, and resources. DSP extensions additionally declare processing artifacts, channel support, latency, offline support, and real-time constraints.

Native DSP extensions execute trusted native code; this API does not provide a sandbox. AI and speech integrations may be asynchronous services, with their outputs becoming ordinary assets or events. Professional plugin hosts remain optional adapters with their own platform requirements.

## References informing the candidate

- [Three.js fundamentals](https://threejs.org/manual/en/fundamentals.html): composable developer-facing concepts.
- [Tone.js](https://tonejs.github.io/): existing musical abstractions that TuneJS must learn from and meaningfully improve on.
- [miniaudio manual](https://miniaud.io/docs/manual/index.html): native device and audio infrastructure under consideration.
- [OfflineAudioContext](https://developer.mozilla.org/en-US/docs/Web/API/OfflineAudioContext): browser offline rendering facilities available for evaluation.
- [Web Audio spatialization model](https://www.w3.org/TR/webaudio/#PannerNode): reference for panning, listener, distance, and directional-source behavior; TuneJS backend conformance still requires its own tests.

These references establish available building blocks, not evidence that TuneJS's proposed implementation meets its targets.
