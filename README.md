# TuneJS

**Make sound easy to begin with, expressive to shape, and open-ended to explore.**

TuneJS is an experimental JavaScript/TypeScript framework for sound. Its ambition is to give developers a coherent foundation for instruments, music, games, installations, audio tools, and experiences we have not anticipated.

Like Three.js, it should combine approachable building blocks with room for advanced work. A few lines should produce something worth hearing; those same foundations should support a much larger creation.

## Project status

The development snapshot (`0.0.1-dev.0`, private, unpublished) implements the v0.1 feature set in the browser: engine lifecycle and ownership; envelope-controlled polyphonic instruments with note names and the `softKeys`, `pluck` and `softDrums` presets; decoded WAV samples with regions, looping, playback rate and seeking; buses, stereo pan, a feedforward delay and a synthetic convolution reverb; a transport with patterns, tempo and phrase changes at the next bar; a listener with stereo and binaural/HRTF spatial emitters and a Three.js pose adapter; bounded PCM taps, microphone input, a bounded recorder, WAV encoding and coalesced meters; versioned project export/import with an integrity-checked asset manifest; and deterministic offline rendering to WAV with TuneJS's own DSP. 178 automated tests cover the controller behaviour; browser fixtures, a ten-minute reference-workload run and an Electron run are recorded under `docs/evidence/`.

The React Native adapter is experimental and its support is earned per capability: instruments, kits, samples, buses, pan, stereo spatial emitters and the transport run through it, and — when the app passes `react-native-worklets` to `nativeAdapter` — delay, reverb, PCM taps, the recorder, meters and binaural/HRTF emitters run inside TuneJS-owned worklet processors that share the offline renderer's DSP kernel (live probes pass on the iOS simulator and Android emulator). React Native Audio API 0.13.3 delivers only one outgoing connection per node (measured on the iOS simulator, the Android emulator and a physical Android phone), so user-level fan-out still rejects with `UNSUPPORTED` there, and microphone capture stays unsupported natively until the host reports its input drops. Binaural rendering uses the shipped SADIE II asset (`assets/hrtf/`, Apache-2.0 attribution in `NOTICE`) and is verified on Chromium, Firefox and Safari (offline fixtures) plus both native simulators; it requires an explicit `hrtf` asset and never falls back to stereo. Safari's live probes need one manual click (autoplay); physical-device, latency, listening and usability validation are outstanding. There is no published package or v0.1 release.

Run `npm ci`, `npm test`, then `npm run dev` and open http://127.0.0.1:4173 (first sound, living loop, spatial playground and record/reuse pages). See [development instructions](docs/development.md) for the executable API, native/Electron examples and tests, and [backend decision](docs/backend-decision.md) for measured evidence and host gaps. Package naming and registry availability have not been established.

## What we are designing for

- **Immediate results:** expressive instruments, usable presets, and sensible defaults.
- **Creative combinations:** sources, effects, patterns, and controls that work together.
- **Progressive depth:** move from simple controls to custom synthesis and processing without replacing the application.
- **Live exploration:** edit sound while listening, with predictable transitions.
- **Shareable creations:** reusable instruments, effects, patterns, and arrangements.
- **Dependable foundations:** precise scheduling, clear ownership, explicit capabilities, and recovery from interruptions.

Ease is a property of the public API, documentation, defaults, error messages, and examples. It is not just a short introductory snippet.

## Intended coverage

Playback and streaming; synthesis and sampling; effects and mixing; musical time and composition; spatial sound; microphone input; recording and offline rendering; analysis; MIDI; and custom processors.

**Spatial audio is a first-class capability:** place instruments and sounds in 3D, move sources and the listener, shape distance and direction, and render immersive headphone audio. The design includes stereo spatial rendering and first-party binaural/HRTF rendering, with adapters for Three.js and tracked listening experiences. Room acoustics, ambisonics, and multichannel speaker rendering have extension paths.

Target hosts are browsers, React Native applications, and JavaScript desktop applications. TuneJS exposes a JavaScript/TypeScript API; direct Swift, Kotlin, and C++ application APIs are outside the initial public scope.

Speech, AI audio, acoustic simulation, and professional audio plugin hosting fit through extension contracts. They are not prerequisites for the core framework.

## Design documents

- [First-release specification](docs/first-release-spec.md): v0.1 scope, creative examples, public contracts, and measurable acceptance targets.
- [Requirements research](docs/requirements-research.md): public requests, evidence limits, existing solutions, and recommended priorities.
- [Creative API examples](docs/creative-api.md): experiences and proposed code that the architecture must support.
- [Architecture](docs/architecture.md): shared concepts, execution model, timing, ownership, and platform boundaries.
- [Capabilities and roadmap](docs/roadmap.md): delivery order, validation experiments, and acceptance criteria.

Design proceeds from creative experience to API to implementation. A rendering technology must demonstrate that it supports the experience before it becomes a permanent dependency.
