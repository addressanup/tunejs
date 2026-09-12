# Capabilities and implementation roadmap

Status: first-sound development snapshot begun on 2026-09-06. See [development status](development.md) and [backend evidence](backend-decision.md) for the implemented subset. The stages below remain the intended roadmap, not verified capability claims.

The [v0.1 developer-preview specification](first-release-spec.md) is the current first-release boundary. It combines a bounded subset of Stages 2–4 into three complete experiences, including binaural spatial sound and foreground PCM capture. Its host matrix, feature limits, and requirement-to-acceptance table take precedence for v0.1; the stages below retain the longer-term capability roadmap.

## Orchestrated implementation waves

Execution plan established 2026-09-12. These waves organize the v0.1 specification; they do not expand its scope or assert completion. Independent lanes can run concurrently only after their input contracts are settled. Each file has one implementation owner at a time. The lead owns API decisions, numerical/reference fixtures, evidence interpretation and integration review; implementation lanes own code and targeted verification. No later feature is declared supported before its host gate passes.

| Wave | Independent workstreams | Gate |
| --- | --- | --- |
| 1 | Lifecycle/ownership fault handling; isolated package verification | Controller regressions and fresh packed consumers pass |
| 2 | Frame timing; native lifecycle; spatial feasibility; capture-clock mapping | Recorded host contracts and explicit unresolved capability/device gaps |
| 3 | Envelopes/voice allocation; presets; shared first-sound example | Expressive first sound through browser/native adapters |
| 4 | Sample assets/voices; buses and effects | Asset sharing, seeking, routing and cleanup conformance |
| 5 | Transport/living loop; spatial rendering/Three.js | Musical and spatial workflows pass their respective fixtures |
| 6 | Capture/taps; recorder; UI-facing data | Bounded delivery, overflow, permissions and cancellation |
| 7 | Projects/asset bundles; offline rendering/WAV | Clean reopen and reproducible export |
| 8 | Host matrix; sustained workload; documentation/package/usability | Release-candidate evidence and explicit release approvals |

Wave 1 lifecycle and package-verification implementation is integrated: its 26-test integration gate passed. Wave 2 is active; fixture-version-2 timing diagnostics have seven additional passing targeted tests, and a fresh iOS 26.5 Release simulator run reproduces the strict 44.1 kHz failure while passing 48 kHz timing. Adapter-owned frame conversion (`Adapter.hostTime`) now places scheduled source starts on the requested frame at both rates on that simulator; the raw fixture stays as the host-limitation reference. The Android arm64 emulator reproduces those results sample-for-sample. Wave 3 (softKeys instrument, envelopes, polyphony) and the Wave 4 sample-asset lane are integrated. Native lifecycle/physical-device, spatial renderer and capture-clock gates remain open. Wave 2 investigations may overlap Wave 1 without changing shared runtime files. Envelope work may proceed once Wave 1 passes; transport, spatial and capture implementation additionally require their Wave 2 contracts. Sample assets and mixing precede complete Wave 5 workflows; Waves 6 and 7 depend on those shared resource and timing semantics. Wave 8 requires all included workflows, not just a build pass.

Physical-device access, CI hosting and package/license/publication decisions are external gates. They are not permission to downgrade the required host matrix, contact participants, publish a package, or push a repository automatically.

## Capability boundaries

| Area | Shared framework responsibility | Platform or extension boundary |
| --- | --- | --- |
| Playback | Buffers, voices, loops, fades, asset lifecycle | Decoders, network streams, codec availability |
| Synthesis | Oscillators, noise, envelopes, polyphony, samplers | Additional instruments and custom DSP |
| Mixing/effects | Buses, sends, parameters, filters, EQ, dynamics, time effects | Specialized processors |
| Music | Clock, transport, tempo, patterns, arrangements, note utilities | MIDI devices and external synchronization |
| Spatial | Listener, movement, direction, distance, stereo panning, first-party binaural/HRTF rendering | Three.js/tracking adapters, room simulation, ambisonics, multichannel spatial output |
| Analysis | Levels, peaks, waveform and spectrum data | UI rendering and semantic/AI interpretation |
| Capture/output | Recording lifecycle, offline rendering, WAV | Input permission, disk sinks, optional codecs |
| Portability | Common JS/TS contracts and conformance fixtures | Browser, React Native, Node-API host adapters |

The baseline must not depend on microphone permission, MIDI support, shared memory, AI services, or proprietary plugins.

## Stage 0: experience and architecture

Current deliverables: product promise, creative API walkthroughs, architecture, capability boundaries, and this roadmap.

The [2026-09-05 requirements research](requirements-research.md) adds 18 curated discussion/report sources and a comparison with existing solutions. The v0.1 specification maps all 12 inferred requirements to included behavior or an explicit deferral with acceptance criteria. X coverage was unavailable; the research distinguishes complete pages, indexed excerpts, historical complaints, and creator promotions.

Research priorities: validate startup/recovery and release-build host behavior first; define continuous PCM and UI analysis/playhead contracts; consider sample slicing and independent pitch/time processing; add media-session integration and versioned documentation to the design backlog. Keep spatial integration early. Compare existing browser/native audio foundations, including React Native Audio API, against the bespoke renderer candidate before freezing the backend.

Review the examples for consistency before generating a large API surface. An internal symbol or package structure is justified by a creative capability or a concrete correctness requirement. Documentation clearly separates proposals, verified behavior, and shipped features.

## Stage 1: feasibility experiments

Build temporary experiments before freezing the backend:

1. Render a tone through a gain and filter in a browser AudioWorklet and a native device callback using shared DSP; compare against a minimal browser-native node graph.
2. Schedule impulses and parameter ramps across block boundaries, including tempo edits and cancellation.
3. Send rapid parameter and graph updates while applying UI-thread load; measure queue pressure, dropouts, and temporary allocation.
4. Package and launch the same minimal graph through React Native on iOS and Android and through a Node-API desktop host.
5. Compare deterministic offline output with captured pre-device render output using the same graph and sample rate.
6. Compare stereo and binaural spatial rendering with moving mono sources and rotating listeners. Evaluate HRTF dataset redistribution, loading, sample-rate conversion, CPU cost, source scaling, and offline reproducibility before selecting the renderer and dataset.

Record engine version, hardware, OS, host version, sample rate, block size, workload, startup time, latency, CPU, memory, and observed underruns. Fix reproducible failures before growing the feature surface. Retain or revise the candidate in a written architecture decision based on these results; do not advertise unmeasured latency or voice-count guarantees.

## Stage 2: one complete creative path

Implement isolated engines, buffer and oscillator sources, playback voices, gain/filter effects, buses, scheduling, level analysis, resource disposal, and offline WAV output. Include a listener and positioned mono emitters with stereo panning, distance attenuation, and directional controls. Provide one synthesizer preset and interactive examples for sound shaping and moving a sound around the listener, with start, stop, loading/error states, and teardown.

Acceptance: a newcomer can hear, modify, and position a sound, and the same signal path passes the browser and native conformance fixtures. Source movement and listener rotation produce the expected stereo result without nonfinite output at zero distance. Full native platform support remains experimental until device lifecycle checks pass on each target.

## Stage 3: expression and composition

Add polyphonic instruments, envelopes, modulation, patterns, tempo maps, live phrase replacement, arrangements, core effects, and versioned projects. Deliver first-party binaural/HRTF rendering and an optional Three.js pose adapter. Ship examples for a beat sequencer, an evolving soundscape, an interaction-controlled instrument, and a headphone spatial scene with a moving listener.

Acceptance: musical edits take effect at declared boundaries; save/load preserves arrangement intent; cancellation does not leave unintended voices running; offline export preserves scheduled content, spatial trajectories, renderer asset identity, and explicit tails. Binaural output passes reference-buffer and headphone listening checks, and unavailable render modes return explicit errors.

## Stage 4: inputs, environments, and extensions

Add microphone recording, bounded long-recording sinks, streaming sources, tracked-listener adapters, spatial extension contracts, spectrum analysis, MIDI, and documented extension registration. Validate device loss, route changes, permissions, mobile interruptions, tracking loss, and unsupported features.

Acceptance: input capture is never audible without an explicit monitoring connection; failures retain existing working content; extension and capability errors explain the missing requirement; long-running sessions keep bounded resource use.

## Verification contract

- **DSP:** use reference buffers for impulses, silence, tones, and envelopes; check numerical tolerances, finite samples, channel routing, and expected gain/frequency behavior.
- **Scheduling:** assert event frame positions offline, including boundaries, tempo changes, stop/resume, cancellations, and phrase replacement. Verify overloaded control queues report failure.
- **Spatial:** test mirrored left/right positions, listener rotations, distance/directivity curves, zero-distance behavior, rapid motion, and multiple emitters. Validate binaural output against renderer-specific reference fixtures for front/back/elevation, documented tolerances, and finite output. Check explicit mode errors, channel mismatches, missing HRTF data, Three.js world-pose conversion, tracking loss, and offline replay of recorded poses. Measure CPU under increasing emitter counts and perform headphone listening review without promising universal localization accuracy.
- **Ownership:** repeatedly load, play, stop, disconnect, and dispose; confirm voice/resource counters return to baseline and memory does not grow monotonically after stabilization.
- **Offline:** reproduce seeded arrangements within a documented tolerance and reject live or unresolved dependencies without silently removing tracks.
- **Hosts:** exercise browser activation and suspension; React Native iOS/Android interruptions; desktop device changes. Record the exact tested matrix. Simulator results do not establish physical-device latency or routing reliability.
- **Listening:** review audible transitions, effect tails, voice stealing, and preset levels alongside automated tests. Passing buffer tests alone does not establish musical quality.
- **Developer experience:** test each example from a clean consumer project, including imports, useful errors, startup, and disposal. Before release, have developers unfamiliar with the internals attempt the examples and record where they get stuck.

Package publication, public compatibility promises, and production-readiness claims follow implementation evidence. A broad architecture is not a claim of complete platform parity.
