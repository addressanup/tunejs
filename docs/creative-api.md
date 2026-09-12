# Creative API examples

These examples specify the intended developer experience. They are proposed APIs; no code here is implemented. `tunejs` is a placeholder import name.

The [v0.1 specification](first-release-spec.md) selects the first-release subset and takes precedence for preview implementation. These broader examples also illustrate later capabilities: continuous BPM ramps, long media streaming, head-tracking adapters, and arbitrary custom DSP are outside v0.1. The preview delivers spatial stereo/binaural modes, basic patterns, foreground capture, project sharing, and offline rendering with the limits stated in that specification.

## Shared rules

- `new Engine()` creates an isolated controller without starting audio or requesting permission.
- `engine.start()` activates output. In a browser, call it directly from a user gesture; handle its rejection in the application.
- Factories create engine-owned objects. Nothing connects to the output automatically.
- `source.connect(target)` returns the target, allowing routing chains. Musical and audio connections remain distinct.
- `Param` properties expose units and ranges. `rampTo(value, { seconds })` smooths a live change; scheduling methods take explicit time objects.
- `engine.dispose()` releases its resources and is safe to repeat. Operations on disposed objects fail clearly.
- Presets are explicitly imported data or modules, allowing applications to choose what they ship.

The examples assume a running engine except where startup is shown. Applications catch asynchronous failures and show a useful recovery action.

## 1. Hear an instrument immediately

Intent: press a button and hear a chord without configuring oscillators or envelopes.

```ts
import { Engine } from 'tunejs';
import { softKeys } from 'tunejs/presets';

const engine = new Engine();
const keys = engine.instrument(softKeys);
keys.connect(engine.output);

playButton.addEventListener('click', async () => {
  try {
    await engine.start();
    keys.play(['C4', 'E4', 'G4'], { duration: { seconds: 1 } });
  } catch (error) {
    showAudioError(error);
  }
});
```

The initial synthesis preset needs no sample download. Advanced users can inspect and replace its components through the instrument extension contract. Each `play` call creates a voice handle; the instrument enforces a documented polyphony limit and voice-stealing policy.

## 2. Turn a sound into an atmosphere

Intent: load a loop, add space, and reshape it while listening.

```ts
const rain = await engine.sample('/audio/rain.wav');
const space = engine.reverb({ decay: { seconds: 3 }, mix: 0.25 });
const ambience = engine.bus({ gainDb: -12 });

rain.connect(space).connect(ambience).connect(engine.output);
const voice = rain.play({ loop: true });

space.mix.rampTo(0.7, { seconds: 2 });
ambience.gainDb.rampTo(-18, { seconds: 1 });

// Later, stop this playback instance while retaining the reusable sample.
voice.stop({ fade: { seconds: 0.2 } });
```

Loading failure identifies the asset and cause. Repeated playback shares decoded sample data, not mutable playback state. A sample is decoded into memory; long media streams use a separate streaming source with buffering and seek semantics.

## 3. Build a musical pattern and change it live

Intent: compose in beats, keep notes synchronized, and replace a phrase at a musical boundary.

```ts
engine.transport.bpm.set(108);

const phrase = engine.pattern({
  length: { beats: 4 },
  events: [
    { beat: 0, notes: ['C4', 'E4'], duration: { beats: 0.5 } },
    { beat: 1.5, notes: ['G4'], duration: { beats: 0.5 } },
    { beat: 3, notes: ['B4'], duration: { beats: 1 } },
  ],
});

const part = phrase.schedule(keys, { at: { beat: 0 }, loop: true });
engine.transport.start();

part.replace(nextPhrase, { boundary: 'next-bar' });
engine.transport.bpm.rampTo(124, { seconds: 4 });
```

For v0.1, use `engine.transport.bpm.set(124)` instead of the final ramp: while playing, it takes effect at the next bar and acknowledges the effective beat. Continuous tempo ramps remain a later capability.

`keys` is an instrument created as in the first example, and `nextPhrase` is another pattern created with the same factory. The transport defaults to 4/4. Notes use declarative events instead of application callbacks that must wake at the exact playback time. Scheduling returns a handle for replacement and cancellation.

## 4. Connect interaction to expression

Intent: use pointer movement to alter a sound without learning the audio-thread model.

```ts
const filter = engine.filter({ type: 'lowpass', frequencyHz: 1200 });
keys.disconnect(engine.output);
keys.connect(filter).connect(engine.output);

surface.addEventListener('pointermove', (event) => {
  const bounds = surface.getBoundingClientRect();
  if (bounds.width <= 0) return;
  const x = Math.max(0, Math.min(1, (event.clientX - bounds.left) / bounds.width));
  filter.frequencyHz.rampTo(200 * 80 ** x, { seconds: 0.03 });
});
```

Rapid live updates replace pending live ramps for that parameter. Applications remove their DOM listeners during their own teardown. Later modulation APIs should allow envelopes and LFOs to drive compatible parameters without sending per-sample values through JavaScript.

## 5. Make a sound exist in space

Intent: attach a sound to a moving object and update the listener independently. Spatial processing accepts instruments and other compatible sources through this same connection API.

```ts
const bell = await engine.sample('/audio/bell.wav');
const emitter = await engine.spatialSource({
  position: [2, 0, -4],
  rendering: 'stereo',
});
bell.connect(emitter).connect(engine.output);

engine.listener.setPose({
  position: [0, 0, 0],
  forward: [0, 0, -1],
  up: [0, 1, 0],
});
bell.play();
emitter.position.rampTo([0, 0, -2], { seconds: 1 });
```

Coordinates use meters in a right-handed system with +Y up and -Z forward. This example uses a mono bell asset as a point source. Stereo material requires an explicit downmix or separate emitters.

Choose `rendering: 'binaural'` for the planned first-party HRTF renderer for headphones. Spatial source creation waits for renderer resources and rejects unsupported modes or failed asset preparation. Binaural rendering is an explicit choice; the engine does not infer the user's listening device or silently switch modes.

The same listener and emitter controls support both modes. Optional Three.js and head-tracking adapters supply world poses, while the core remains independent of a graphics framework. Save scheduled movement and listener automation with the project to reproduce them in offline audio. Acoustic room simulation and specialized spatial output formats use extension contracts.

## 6. Capture, inspect, and render

Intent: record an input, show its level, and render a reusable composition without manual audio-buffer plumbing.

```ts
const microphone = await engine.input({ kind: 'microphone' });
const meter = engine.analyzer({ kind: 'level' });
microphone.connect(meter);

const recorder = engine.recorder({ source: microphone });
await recorder.start();
// UI animation loop can read meter.read(); input is not monitored to speakers.
const recording = await recorder.stop();
const wav = await recording.encode({ format: 'wav' });
```

Input permission is requested only by `engine.input`. The recorder owns capture resources; the engine still owns the input and analyzer. Starting capture does not implicitly enable speaker monitoring.

```ts
const project = engine.project.export();
const result = await Engine.render(project, {
  range: { fromBeat: 0, toBeat: 16 },
  tail: { seconds: 3 },
  sampleRate: 48000,
  resolveAsset: async (id) => loadProjectAsset(id),
});
const wav = await result.encode({ format: 'wav' });
```

These are separate workflows: the render example requires a serializable project with scheduled content. Project export fails with actionable diagnostics for live inputs, unresolved external state, or unsupported processors; it never silently omits them. Live performances must first be captured as audio or recorded musical events. `loadProjectAsset` is supplied by the application.

## Design review questions

- Can a newcomer obtain an audible result without reading backend documentation?
- Can every example grow through the same routing, parameter, and lifecycle rules?
- Is there an explicit path from a preset to custom processing?
- Do live edits sound intentional, and can a user cancel or stop them?
- Can the musical creation be shared without sharing runtime devices or permissions?
- Can applications diagnose and recover from failures without inspecting engine internals?
