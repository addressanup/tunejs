# Developing the first-sound snapshot

Version `0.0.1-dev.0`, private and unpublished. `docs/first-release-spec.md` is a target, not a list of delivered features. See [backend decision](backend-decision.md) for measurements and host gaps.

## Run in the browser

From the repository root, with Node 22 or later:

```sh
npm ci
npm test
npm run check:package
npm run dev
```

Open http://127.0.0.1:4173 and press **Play 2-second tone**. The level defaults to 0.06. Use Filter and Level while playing; Stop stops the voice, Suspend stops all voices and suspends output, and Dispose permanently releases the engine. Reload after disposal to start over. After backgrounding, press Play explicitly to resume. An engine's running state does not verify the physical audio route or volume.

Each `npm run check:package` creates a fresh `artifacts/package-check-<id>/` directory and prints its path. Open its `consumer.html` through the local server to exercise installed tarball exports rather than workspace source. Previous consumers, tarballs and result files are preserved. Imports, setup and playback are shared with the native example through `examples/shared/first-sound.js`.

```js
import { Engine } from 'tunejs';
import { browserAdapter } from 'tunejs/browser';
import { softKeys } from 'tunejs/presets';

const engine = new Engine({ adapter: browserAdapter() });
const keys = engine.instrument(softKeys);
keys.connect(engine.output);

// Call directly inside the application's button/touch handler.
await engine.start();
const chord = keys.play(['C4', 'E4', 'G4'], { duration: { seconds: 1.5 } });
keys.filterHz.rampTo(800, { seconds: 0.2 });
chord.stop();
await engine.dispose();
```

This is the specified softKeys first-sound example; the bare oscillator path remains available for low-level use. Sources are reusable configuration and each `play` creates an independent voice. Ordinary application code never receives audio backend nodes. The core imports no React, React Native, Three.js or native audio library.

## Current API and semantics

- `new Engine({adapter})`: lazy controller; no AudioContext construction, network or permissions. Adapter selection is currently explicit. `start()` calls host resume synchronously before its first promise continuation, shares concurrent attempts, and supports retry after activation failure. Dispose during start rejects that start and cannot resurrect the engine.
- `oscillator({frequencyHz=440,wave='sine'})`: frequency 1–20,000 Hz, wave sine/triangle/square/sawtooth. No noise, notes, presets or polyphony policy yet. `play({duration:{seconds}})` optionally schedules a native stop, with 0.001–3,600 second durations. Without duration it continues until explicitly stopped/disposed.
- `gain({gain=0.1})`: linear amplitude 0–4. `filter({type='lowpass',frequencyHz=1200})`: lowpass/highpass, 10–20,000 Hz, fixed Q=0 dB. Values above host Nyquist need further contract work; no sample-rate selection is exposed by the browser adapter yet.
- `connect(target)` returns target. Duplicate edges are idempotent. Cross-engine edges, cycles, input to a source and output-as-source reject. `disconnect(target?)` removes one or all outgoing edges. These are control-thread operations; atomic graph mutation at an audio block is not promised in this snapshot.
- Gain and filter Params implement `set` and `rampTo(value,{seconds})`. A new ramp replaces pending automation and starts at the interpolated current value computed by TuneJS. Ramps configured before activation bind to the engine timeline. `set` is immediate; use a short ramp for live controls. Backend maximum precision remains under test.
- `voice.stop()` and `dispose()` are idempotent. Stop requests audio-timeline termination; `state` remains `stopping` until the host end event. Dispose disconnects and releases the handle immediately. There is no release envelope yet, so immediate stops can click. Engine suspension disposes voices; subsequent start does not replay them.
- Engine diagnostics expose owned graph/voice counts, zero currently allocated asset/tap resources, actual sample rate after activation, and unknown latency/underruns as `null`. These are not process-memory or hardware-audibility measurements.
- `TuneError` includes `code`, `message`, `recovery`, and optional cause. Codes include invalid values/connections, ownership mismatch, disposed resources, unavailable backend, not running, activation failure and host failure. Application UI owns its subscriptions and listeners.
- Scheduling is frame-based inside the engine: voice start/stop times are rounded to whole engine frames (`engine.currentFrame`, `engine.sampleRate`), and each adapter converts a frame to the seconds value its host expects through `Adapter.hostTime(frame, sampleRate)`. The browser adapter passes `frame / sampleRate`; the native adapter adds a quarter-frame bias because React Native Audio API truncates `time * sampleRate`. Parameter automation still uses seconds and may land one frame early on native; that is within the specified onset tolerance and is documented rather than hidden.
- `instrument(preset, {maxVoices})` creates a polyphonic voice-allocating source: per note, each preset layer gets `oscillator → layer gain → shared envelope gain`, and all voices feed the instrument's built-in `filterHz`/`level` Params. `noteToFrequency('C4')` maps note names through equal temperament; `play(notes, {velocity, duration})` accepts a note name, `{frequencyHz}`, or a chord array.
- The envelope schedules attack/decay to the sustain level in host-seconds; releases are computed by TuneJS interpolation (`cancelScheduledValues` at the interpolated value, then a linear ramp to zero), so no reliance on host AudioParam.value reads. Voice stealing releases the oldest live voice with a 20 ms release; when every live voice is already stealing, allocation still proceeds (bounded overshoot). `setEnvelope(patch)` affects future voices only; `stopAll()` releases every live voice.
- `tunejs/presets` exports frozen presets (`softKeys`, `pluck`); they are pure data, no sample assets.
- `engine.sample({id, bytes | url}, {signal?})` decodes PCM WAV assets (RIFF/WAVE integer PCM 8/16/24/32, float32, and extensible wrapping of both). The `id` is the cache identity: a repeated id reuses the decoded asset without re-fetching or re-decoding. URL assets use `globalThis.fetch`; unsupported or failed decodes reject `ASSET_FAILED`, aborted loads reject `CANCELLED`, and failures cache nothing.
- `sample.play({region, loop, rate, duration})` plays the decoded clip on the context sample rate — differing rates are resampled once per context rate with a fixed, documented Kaiser-windowed sinc: 64 taps, β = 12, cutoff 0.5·min(1, toRate/fromRate) so downsampling anti-aliases, weights normalized per output sample, edge-clamped. A 1e-5 interior tone fixture pins its accuracy; that tolerance is not a claim about arbitrary material. `rate` changes playback speed and pitch together; it is not independent time-stretch. `position` is a JS-computed asset-timeline estimate; `seek(seconds)` swaps the host source on the next frame boundary (rounded to the asset's own frame grid) and keeps the old source playing if host setup fails. `voice.stop()` is immediate — no crossfade or release yet, so abrupt stops and seeks can click.
- `engine.clearAssets()` releases cached decoded assets that no `Sample` node still references and returns the freed byte count. `diagnostics.cachedAssetBytes` counts decoded Float32 PCM only (channels × frames × 4); host-resident buffer copies are excluded. `engine.dispose()` releases every cached entry.

Wave 1 hardening makes graph/voice teardown complete logical ownership cleanup even when host operations fail. Independent cleanup attempts continue, failures retain their causes in `TuneError`, and partial host-node initialization is disconnected before retry. These guarantees concern controller ownership; failed host cleanup is not proof of released device or process memory. Dispose the engine after a cleanup error.

Implemented: lifecycle, graph ownership/routing, oscillator voices, gain/filter Params, envelope-controlled instruments with note names, polyphonic voice allocation/stealing, presets, decoded PCM WAV samples with region/loop/playback-rate voices and an asset cache, explicit activation, stop/suspend/disposal and errors. Experimental only: native adapter and backend comparison fixtures. Not implemented yet: buses, pan, delay, reverb, transport, spatial API/Three.js integration, analyzer/tap/recorder API, projects or WAV/offline public output; the percussion preset is still pending (it needs noise). The false capability flags refer to TuneJS API support, even when a host primitive exists. The specification's v0.1 feature deferrals remain deferred.

## Native example

The app consumes the packed TuneJS library and generated copies of the same fixture and sound-setup modules. Regenerate copies after edits; do not hand-edit `generated/`. `npm run prepare:native` refreshes shared generated files; `npm run check:native` detects missing or stale copies without writing. It does not check the installed tarball. Package checks no longer replace the legacy tarball path: install the newly printed tarball explicitly before native validation. Substitute that absolute path for the example value below; npm install updates the native example manifest and lockfile.

```sh
# Repository root
npm run check:package
npm run prepare:native
TUNEJS_TARBALL="/absolute/path/printed/by/check-package/tunejs-0.0.1-dev.0.tgz"
npm install --prefix examples/native "$TUNEJS_TARBALL"
npm run check:native
cd examples/native
npx tsc --noEmit
npx expo prebuild --no-install
npx pod-install
```

For iOS, open the generated `ios/TuneJS.xcworkspace`, select a simulator or provisioned phone and build Release. Alternatively:

```sh
npx expo run:ios --configuration Release
```

For Android, configure JAVA_HOME and ANDROID_HOME for your installation, then:

```sh
npx expo run:android --variant release
```

On this Mac, Java is at `/Applications/Android Studio.app/Contents/jbr/Contents/Home` and Android SDK at `$HOME/Library/Android/sdk`. An APK-only command is `./gradlew assembleRelease -PreactNativeArchitectures=arm64-v8a --max-workers=2` in `examples/native/android`. Generated Expo release signing uses its development key; it is not a distribution-ready artifact. Native build directories are disposable. `ios-Podfile.lock` preserves the attempted CocoaPods resolution; copy it into `ios/Podfile.lock` after prebuild when reproducing that resolution.

The native app runs offline fixtures on mount and displays results, then attempts to POST them to the local fixture server (iOS simulator loopback, Android emulator 10.0.2.2). The example app carries a network security config permitting cleartext only to the emulator host alias 10.0.2.2 for local fixture reporting (mirroring the iOS `NSAllowsLocalNetworking` entry); it is example-app configuration, not library behavior. Physical-device result export needs a host-reachable endpoint; a network POST failure does not establish a DSP failure. Playback still requires pressing Play. The foreground AppState handler suspends output and stops voices; it does not request background services or microphone permission. Native audio uses `nativeAdapter(() => new AudioContext())` with AudioContext imported from React Native Audio API.

Keep several GB of free disk available for native builds. Android arm64 release packaging and iOS arm64 Release simulator builds succeeded after storage cleanup. iOS simulator offline PCM ran and exposed a one-frame rounding difference at 44.1 kHz; see the decision/evidence for details. Do not treat a generated app, TypeScript check or simulator as a physical-device audio pass.

## Electron example

Start the root `npm run dev` server, then in another terminal:

```sh
cd examples/electron
npm ci
npm start
```

It loads the exact browser example with Node integration off, context isolation and sandboxing on. The example is a local desktop shell; no native desktop backend, installer, Windows/Linux verification or release signing is implied.

## Experiments and tests

- `npm test`: deterministic controller tests use an explicitly labeled host double, covering lazy/concurrent activation, retries, dispose races, graph validation, ramps, 100 ownership cycles and host failure/cleanup regressions; an isolated package-consumer regression exercises the packed tarball without touching workspace artifacts. These are not audio correctness measurements.
- Open `/experiments/browser.html` on the local server. Run offline/lifecycle fixtures, then the 10-second synthetic capture. JSON appears in the page and is saved to `artifacts/browser-results.json`. Capture is unmonitored AudioWorklet-generated PCM, not microphone capture. Only its consumer queue has a measured bound; the MessagePort backlog still needs production flow control. A failed check remains visible; inspect status for every result.
- The **Compare browser / C++ / WASM** button compares complete browser PCM with both C++ outputs after running the C++ command. It is an offline arithmetic check.
- `npm run experiment:cpp`: compiles the same offline kernel to native and WASM, renders shared fixtures and saves raw planar float buffers and JSON. It uses Apple clang++ and an NDK LLVM path; override the latter with `TUNEJS_LLVM` if needed. No Emscripten installation is required for this freestanding experiment.
- `npm run check:package`: compiles sources into a unique staging directory, packs that fresh build, validates clean JS/TS consumers, and retains the tarball, consumer HTML and report in the printed `artifacts/package-check-<id>/` directory. It never deletes an existing consumer or overwrites previous evidence.
- `npm run check:native`: read-only check that generated native files match their shared sources; it reports missing or stale copies without writing them and does not verify the installed package or device behavior.

Fixture version 3 keeps the version-2 onset diagnostics and adds a labeled scheduling conversion (`scheduling: 'raw-seconds'` by default; adapters may pass `hostTime`). This diagnostic uses the already specified one-frame onset tolerance; it does not replace or relax the top-level strict PCM-buffer result. Missing/extra impulses fail onset acceptance without inventing a frame-error value. Buffer comparisons reject length mismatches and nonfinite samples. `node --test tests/fixtures.test.mjs` verifies these rules with synthetic test data; it is not a fresh native-device or browser-render measurement. Historical version-1 evidence remains unchanged.

The Wave 2 fixture-version-2 rerun used a freshly staged TuneJS tarball in a Release build on the iPhone 17 Pro simulator, iOS 26.5, React Native 0.86.3. The 44.1 kHz strict timing failure reproduced: requested frame 1023 appeared at 1022 in both channels, with maximum onset error one frame and zero gain error at actual onset. Timing at 48 kHz, filter smoke checks and stereo-pan arithmetic checks passed; HRTF remained explicitly unavailable at both rates. The local result is retained in `artifacts/package-check-lNKU0I/artifacts/native-results.json`; historical evidence is unchanged. This run does not test TuneJS lifecycle, microphone capture, audible output or physical-device behavior. Known physical iPhones were offline at the earlier readiness check; Android runtime and physical-device validation remain open.

The first Android runtime fixtures ran on the arm64 API 35 emulator after the example app gained its scoped cleartext exception. Every fixture matched the iOS simulator sample-for-sample: the raw 44.1 kHz shift reproduced, adapter frame scheduling placed all impulses exactly, filter and pan values were identical, and HRTF was unavailable. That APK bundled the Wave 3 library (the fixture pipeline does not use samples); see `docs/evidence/2026-09-12/android-emulator-analysis.json`. Emulator results are not physical-device evidence.

A second run with fixture version 3 on the same simulator compared raw-seconds scheduling with the native adapter's frame conversion. Raw scheduling reproduced the 44.1 kHz shift again; scheduling every impulse through `nativeAdapter.hostTime` placed all twelve impulses on their requested frames at both rates with zero strict buffer error, while filter, pan and HRTF results were unchanged. Snapshots and an analysis note are under `docs/evidence/2026-09-12/`. This resolves scheduled source start/stop placement for offline rendering on that host; parameter automation, live-context behavior, transport and physical devices are not covered.

During package refresh, disabling lockfile use allowed Expo dependencies to drift and the first app build crashed on launch. Restoring the lockfile dependency tree, then installing the fresh TuneJS files and rebuilding, produced the captured run. This establishes the working pinned setup, not an isolated root cause in any one upgraded package. Preserve the native lockfile and do not use `--package-lock=false` to refresh the local library. The captured app used fresh TuneJS files although the native manifest still names the legacy tarball; the installed library must be checked independently of that manifest and its unchanged development version.

The three release workflows, physical latency/interruption checks, microphone permission tests, sustained workload, HRTF reference/listening tests and developer usability evaluation remain outstanding. Android runtime fixtures and physical-device measurements take priority alongside the next envelope/softKeys implementation slice; native frame conversion for scheduled sources is now handled by the adapter and verified offline on the simulator.

Historical local artifacts remain at `artifacts/tunejs-android-arm64-release.apk` and `artifacts/TuneJS-simulator.app`. The latter is the earlier simulator-only build, not the fresh Wave 2 app, and cannot run on a physical iPhone. The fresh installed app is retained at `artifacts/package-check-lNKU0I/ios-build/Build/Products/Release-iphonesimulator/TuneJS.app`. Earlier compiler intermediates were removed to recover disk space.
