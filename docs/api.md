# TuneJS API reference — `0.0.1-dev.0`

This page documents the public surface of the development snapshot. Signatures are copied
from the TypeScript sources; behavior statements are qualified by the recorded evidence
(see [support matrix](support-matrix.md) and `docs/evidence/`). Nothing here is a stable
API promise — the package is private and unpublished.

Entry points: `tunejs` (core), `tunejs/browser`, `tunejs/native`, `tunejs/presets`,
`tunejs/three`.

## Engine lifecycle

An `Engine` owns its graph, assets, clock, and voices. Construction performs no audio
activation, permission prompts, or network fetching; `start()` activates the host output
and must be called synchronously inside a user gesture on the browser adapter.

```ts
new Engine(options: { adapter: Adapter })
engine.start(): Promise<void>
engine.suspend(): Promise<void>
engine.dispose(): Promise<void>
engine.state: EngineState  // 'idle' | 'starting' | 'running' | 'suspended' | 'interrupted' | 'failed' | 'disposed'
engine.currentTime: number
engine.sampleRate: number | null
engine.currentFrame: number
engine.output: GraphNode
engine.capabilities        // frozen per-host flags, e.g. fanOut, delay, binaural, taps, capture
engine.diagnostics         // { state, backend, sampleRate, nodes, voices, cachedAssetBytes, taps, underruns, outputLatencySeconds }
```

Adapters: `browserAdapter(): Adapter` (`tunejs/browser`) and
`nativeAdapter(createContext: () => HostContext, options?: { worklets?: NativeWorklets }): Adapter`
(`tunejs/native`). The native adapter is experimental; without `worklets` (from
`react-native-worklets`) delay/reverb, taps, the recorder, meters, and binaural emitters
reject `UNSUPPORTED`, and user-level fan-out rejects regardless.

**Gotcha:** `start()` is idempotent and shares concurrent attempts, but a dispose during
activation rejects that start permanently. `suspend()` pauses the transport and disposes
voices — a later `start()` does not replay them. A `running` state is not proof the user
hears sound; `diagnostics.underruns` and `outputLatencySeconds` report `null` on every
current host.

### Connections

```ts
node.connect<T extends GraphNode>(target: T): T
node.disconnect(target?: GraphNode): void
```

`connect` returns its target for chaining. Cycles, output-as-source, source-as-target, and
cross-engine edges reject `INVALID_CONNECTION`/`CROSS_ENGINE`; duplicate edges are
idempotent. On a fan-out-limited host (`hostLimits.fanOut === false`, the native adapter)
a second outgoing edge rejects `UNSUPPORTED` — route through a `bus` instead.

## Instruments and presets

```ts
engine.instrument(preset: InstrumentPreset, options: { maxVoices?: number } = {}): Instrument
engine.kit(preset: KitPreset, options: { maxVoices?: number } = {}): Kit
instrument.play(notes: string | { frequencyHz: number } | Array<string | { frequencyHz: number }>, options: PlayOptions = {}): InstrumentVoice
kit.play(hit: string | string[], options: PlayOptions = {}): InstrumentVoice
instrument.setEnvelope(patch: Partial<Envelope>): this
instrument.stopAll(): void;  kit.stopAll(): void
noteToFrequency(note: string): number
```

`tunejs/presets` exports frozen data-only presets `softKeys` and `pluck`
(`InstrumentPreset`) and `softDrums` (`KitPreset` with `kick`, `snare`, `hat`). Note names
map through A4 = 440 Hz 12-tone equal temperament (`'C4'`, `'F#3'`, `'Bb5'`); explicit
`{ frequencyHz }` bypasses it. `PlayOptions` = `{ velocity?: number; duration?: Seconds; at?: { frame: number } }`.

```ts
interface Envelope { attack: number; decay: number; sustain: number; release: number }
interface InstrumentPreset { name: string; layers: readonly InstrumentLayer[]; envelope: Envelope; filter?: { type: 'lowpass' | 'highpass'; frequencyHz: number }; level: number; maxVoices?: number }
interface KitPreset { name: string; hits: Readonly<Record<string, HitPreset>>; level: number; maxVoices?: number }
interface HitPreset { frequencyHz: number; layers: readonly InstrumentLayer[]; envelope: Envelope }
```

**Gotcha:** voices are per-`play`; `voice.stop()` runs the release envelope, while
`dispose()` is immediate. Default `maxVoices` is 16 with oldest-voice stealing (20 ms
steal release). `setEnvelope` affects future voices only. Sustain-0 envelopes
(percussion, `pluck`) end on their own. Preset levels have not had a listening review.

## Sources: oscillator, gain, filter

```ts
engine.oscillator(options: { frequencyHz?: number; wave?: 'sine' | 'triangle' | 'square' | 'sawtooth' } = {}): Oscillator
oscillator.play(options: { duration?: Seconds } = {}): Voice
engine.gain(options: { gain?: number } = {}): Gain       // linear 0–4, default 0.1
engine.filter(options: { type?: 'lowpass' | 'highpass'; frequencyHz?: number } = {}): Filter
```

`Param` on gain/filter (`gain.gain`, `filter.frequencyHz`) supports
`set(value)` and `rampTo(value, duration: Seconds)`; ramps replace pending automation and
start at the interpolated current value.

**Gotcha:** `Seconds` is always `{ seconds: number }`. `voice.stop()` requests an
audio-timeline end; `state` reads `'stopping'` until the host end event.

## `sample()`

```ts
engine.sample(asset: SampleAsset, options: { signal?: AbortSignal } = {}): Promise<Sample>
interface SampleAsset { id: string; bytes?: ArrayBuffer | ArrayBufferView; url?: string }
sample.play(options: { region?: { start: number; end?: number }; loop?: boolean; rate?: number; duration?: Seconds; at?: { frame: number } } = {}): SampleVoice
voice.position: number
voice.seek(seconds: number): Promise<{ position: number }>
sample.stopAll(): void
engine.clearAssets(): number
```

Decodes PCM WAV (integer 8/16/24/32-bit, float32, extensible wrapping). The `id` is the
cache identity — a repeated id reuses the decoded asset without re-fetching. Exactly one
of `bytes`/`url` is required; `url` uses `globalThis.fetch`. `region` is in asset
seconds.

**Gotcha:** `rate` changes speed and pitch together — it is not pitch-preserving stretch.
`seek` resolves with the position actually applied (quantized to the asset's frame grid)
and rejects outside the play region. `stop()` is immediate — no fade — so abrupt stops
and seeks can click. Assets decoded at a different rate are resampled once per context
rate by the documented Kaiser-windowed sinc.

## Bus, pan, delay, reverb

```ts
engine.bus(options: { gainDb?: number } = {}): Bus                   // −60…+12 dB
engine.pan(options: { pan?: number } = {}): Pan                      // −1…1 equal-power
engine.delay(options: { time?: Seconds; feedback?: number; mix?: number; taps?: number } = {}): Delay
engine.reverb(options: { decay?: Seconds; mix?: number } = {}): Reverb
delay.mix / reverb.mix: Param   // live wet level; dry is unity
```

`delay` is a finite feedforward multi-tap echo (`taps` repeats at `time` spacing, tap
gains `feedback^k`) — deliberately no feedback loop, because a native host may drop a
graph edge forming a cycle. `reverb` is `synthetic-convolution-v1`: a seeded-noise stereo
impulse response decaying −60 dB over `decay`, deterministic per (decay, sample rate) —
not a listening-reviewed room model.

**Gotcha:** on an adapter with a TuneJS DSP path (`browserAdapter`, or `nativeAdapter`
with `worklets`) these run inside one TuneJS-owned processor and need no fan-out.
Otherwise on a fan-out-limited host both reject `UNSUPPORTED` at creation. `time`,
`feedback`, `taps`, and `decay` are fixed at creation; only `mix` is automatable.

## `spatialSource` — stereo and binaural

```ts
engine.spatialSource(options: SpatialSourceOptions): Promise<SpatialSource>
interface SpatialSourceOptions {
  rendering: 'stereo' | 'binaural';
  hrtf?: HrtfAsset;                 // required for 'binaural'
  position?: Vec3;                  // default { x: 0, y: 0, z: -1 }
  direction?: Vec3 | null;          // null = omnidirectional
  distance?: { reference?: number; max?: number; rolloff?: number };  // defaults 1 / 50 / 1
  cone?: { innerDegrees?: number; outerDegrees?: number; outerGain?: number };  // defaults 360 / 360 / 0
  smoothingSeconds?: number;        // default 0.02
}
source.setPosition(position: Vec3, options: { seconds?: number } = {}): void
source.setDirection(direction: Vec3 | null, options: { seconds?: number } = {}): void
```

A mono-in/stereo-out emitter. `stereo` mode (`tunejs-stereo-v1`) is a distance+cone gain
into an equal-power panner — a single chain, so it also runs on the fan-out-limited
native adapter. `binaural` mode (`tunejs-binaural-v1`, nearest-position HRIR convolution
with linear crossfade) requires the adapter's DSP path and an explicit `hrtf` asset from
`loadHrtf`; it never falls back to stereo. Coordinates are meters, +Y up, −Z forward,
right-handed; position/direction changes are smoothed on the audio timeline.

**Gotcha:** feed emitters mono sources — stereo assets need an explicit downmix or
separate emitters (the binaural kernel averages input channels). Distance uses Web Audio
inverse gain (`reference/(reference+rolloff·(d−reference))` clamped to `[reference,max]`);
cone gain falls off linearly between inner/outer half-angles. Binaural is verified against
a synthetic-table direct-convolution reference on Chromium, Firefox, Safari (offline), the
Android Chrome emulator, and both native simulators — not a localization or listening
judgement.

### `listener`

```ts
engine.listener.setPose(pose: { position?: Vec3; forward?: Vec3; up?: Vec3 }, options: { seconds?: number } = {}): void
engine.listener.position / forward / up: Vec3
```

One listener per engine; `setPose` validates finite vectors and a nondegenerate
orientation (forward and up must be nonzero and non-parallel; `up` is re-orthogonalized),
then re-evaluates every live emitter with the smoothing window.

### Three.js adapter (`tunejs/three`)

```ts
poseFromMatrix(elements: ArrayLike<number>, options: { metersPerUnit?: number } = {}): Pose
poseFromObject(object: { matrixWorld: { elements: ArrayLike<number> }; updateWorldMatrix?: (updateParents: boolean, updateChildren: boolean) => void }, options: { metersPerUnit?: number; update?: boolean } = {}): Pose
positionFromObject(object, options: { metersPerUnit?: number; update?: boolean } = {}): Vec3
```

Reads a listener pose from a column-major 4×4 world matrix (cameras look down local −Z, so
forward is the negated third column). `poseFromObject` calls
`updateWorldMatrix(true, false)` by default and never writes to the object. No Three.js
import — any compatible shape works.

## Transport and patterns

```ts
engine.pattern(data: PatternData): Pattern
engine.transport.schedule(pattern: Pattern, target: Instrument | Kit | Sample, options: { at?: Beats; loop?: boolean } = {}): Part
part.replace(pattern: Pattern, options: { boundary: 'next-bar' }): { effectiveBeat: number }
part.cancel(): void
transport.start(): void;  transport.pause(): void;  transport.stop(): void
transport.setMeter(meter: { beatsPerBar: number }): void   // integer 1–16, only while stopped
transport.bpm: { readonly value: number; readonly pending: number | null; set(value: number): TempoAck }
transport.position: { beat: number; bar: number; beatInBar: number }
transport.diagnostics   // { state, bpm, position, lateEvents, maxLatenessSeconds, skippedEvents, scheduledEvents, interruptions, errors }
interface PatternEvent { beat: number; notes: string | string[]; duration: Beats; velocity?: number; region?: { start: number; end?: number } }
interface PatternData { length: Beats; events: readonly PatternEvent[] }
interface TempoAck { effectiveBeat: number; appliedAt: 'now' | 'next-bar' }
```

Transport defaults to 120 BPM and 4/4. Patterns are frozen event data — events sort by
beat; `beat` must be `< length.beats`; fractional beats (including thirds) are accepted
and positions derive from absolute beats through the tempo map, so nothing accumulates
drift. `schedule` returns a `Part` (`loop` default `true`; `at` defaults to beat 0 while
stopped or the next bar at/past the scheduling horizon while running). A `Sample` target
plays `event.region` slices and ignores note names.

**Gotcha:** `bpm.set` while running applies at the first bar boundary at/past the
scheduling horizon and returns `{ appliedAt: 'next-bar', effectiveBeat }`; already-scheduled
events are never re-timed. `replace` swaps future events at the next bar — sounding notes
finish their envelope; only the latest pending replacement applies. Late events clamp to
now and are counted in `diagnostics.lateEvents`; missed occurrences are skipped, never
replayed in a burst. `position` is observational — it must not drive the audio clock.

## Tap, input, recorder, meter

```ts
engine.tap(options: { source: GraphNode; chunkFrames?: number; maxBufferedFrames?: number }): Promise<Tap>
for await (const chunk of tap) { /* PCMChunk */ }
tap.cancel(): void
tap.diagnostics: TapDiagnostics
interface PCMChunk { sequence: number; startFrame: number; sampleRate: number; channels: Float32Array[]; droppedFramesBefore: number }
```

A bounded PCM async iterator over a graph node. `chunkFrames` defaults to 1024 (multiple
of 128 required, 128–16384); `maxBufferedFrames` defaults to one second at the engine rate
rounded up to whole chunks. `startFrame` is the engine frame clock, not wall time;
`channels` are planar consumer-owned copies. A slow consumer does not stop capture — the
oldest queued chunks are discarded and the next delivered chunk's `droppedFramesBefore`
reports the gap. `cancel()` releases the tap, not the source; source/engine disposal ends
iteration with `endReason` `'source-disposed'`/`'engine-disposed'`. Requires the adapter's
tap support (`capabilities.taps`); the `output` node cannot be tapped.

```ts
engine.input(options: { kind: 'microphone' }, request: { signal?: AbortSignal } = {}): Promise<Input>
```

Foreground microphone capture (browser adapter only; native is `UNSUPPORTED` because the
host input pool can drop frames without reporting). Processing is disabled
(echoCancellation/noiseSuppression/autoGainControl off) and nothing routes input to
speakers implicitly — monitoring is the caller's explicit graph. Denial maps to
`PERMISSION_DENIED`, missing devices to `NO_DEVICE`, abort to `CANCELLED`.

```ts
engine.recorder(options: { source: GraphNode; maxSeconds?: number; maxBufferedFrames?: number }): Recorder
await recorder.start(): Promise<void>
await recorder.stop(): Promise<Recording>
recording.channels / sampleRate / frames / reason   // 'stopped' | 'duration-limit'
recording.toWav(): { bytes: ArrayBuffer; clippedSamples: number }
recording.asAsset(id: string): SampleAsset
```

Bounded in-memory recording through a tap (`maxSeconds` default 60, cap 600). Unlike a
tap, a recorder cannot silently discard: any dropped frames — including the close-time
flush — fail `stop()` with `OVERFLOW`.

```ts
engine.meter(options: { source: GraphNode; updatesPerSecond?: number }, request: { timers?: MeterTimers } = {}): Promise<Meter>
meter.read(): MeterSnapshot
meter.subscribe(callback: (snapshot: MeterSnapshot) => void): () => void
interface MeterSnapshot { frame: number; frames: number; sampleRate: number; peak: number[]; rms: number[]; waveform: { min: Float32Array; max: Float32Array } }
```

Level/waveform snapshots stamped with engine frames. `updatesPerSecond` is an integer
1–60 (default 30); subscriptions coalesce while the UI is busy, `read()` polls the latest
chunk. Snapshots carry no sample-accuracy promise.

## Project export/import

```ts
engine.exportProject(): { project: ProjectV1; warnings: string[] }
engine.importProject(project: unknown, options: { resolveAsset?: (id: string) => Promise<ArrayBuffer | ArrayBufferView> } = {}): Promise<{ nodes: Map<string, GraphNode>; parts: Part[] }>
```

`exportProject` produces a `tunejs-project` v1 document: transport tempo/meter, listener
pose, every node with current parameter values, connections (output as `'output'`),
patterns and parts, and an asset manifest with `fnv1a64:` integrity over decoded PCM.
Live capture inputs or attached taps fail `PROJECT_INVALID`; a running transport and
pending tempo/replacements produce warnings. `importProject` validates every reference,
resolves and integrity-checks each manifest asset through `resolveAsset`, then builds
through the ordinary factories — on any failure it rolls back what it created and leaves
the existing graph untouched. The transport must be stopped.

## `Engine.render` — offline rendering

```ts
Engine.render(project: ProjectV1, options: {
  range: { fromBeat: number; toBeat: number } | { fromSeconds: number; toSeconds: number };
  tail: { seconds: number };
  sampleRate: 44100 | 48000;
  resolveAsset?: (id: string) => Promise<ArrayBuffer | ArrayBufferView>;
  maxSeconds?: number;   // default 600
}): Promise<RenderResult>
interface RenderResult {
  readonly channels: [Float32Array, Float32Array];
  readonly sampleRate: number;
  readonly frames: number;
  readonly range: { fromFrame: number; toFrame: number };
  encode(options: { format: 'wav' }): { bytes: ArrayBuffer; clippedSamples: number };
}
```

Deterministic TuneJS-DSP render of an exported project — pure JS, no host context, so
output is identical on every host. The range maps through the project tempo; total frames
are the range plus `tail.seconds`; only occurrences starting inside the range render.
The same kernel serves the live DSP-path effects, but live host output and offline output
are **not** claimed sample-equal (sources/gains/filters/pans remain host nodes live).
`encode` writes 16-bit PCM WAV and reports clipped samples. The underlying encoder is
also exported: `encodeWav(channels: Float32Array[], sampleRate: number): { bytes: ArrayBuffer; clippedSamples: number }`,
and `fnv1a64Float32(channels)` produces the manifest integrity hash.

## `loadHrtf` and HRTF codecs

```ts
engine.loadHrtf(options: { id?: string; url?: string; bytes?: ArrayBuffer | ArrayBufferView; signal?: AbortSignal }): Promise<HrtfAsset>
decodeHrtfAsset(input: ArrayBuffer | ArrayBufferView): HrtfAsset
encodeHrtfAsset(header: HrtfHeader, tables: Map<number, HrtfTable>): Uint8Array
hrtfTableFor(asset: HrtfAsset, sampleRate: number): HrtfTable
interface HrtfAsset { id: string; integrity: string; header: HrtfHeader; tables: Map<number, HrtfTable> }
```

Loads a `tunejs-hrtf-v1` binary (see [hrtf-asset.md](hrtf-asset.md)) from bytes or a URL;
cached by `id` (defaulting to the asset's own header id), counted in
`diagnostics.cachedAssetBytes`, and released by `clearAssets()` once no spatial source
references it. `hrtfTableFor` rejects `UNSUPPORTED` when the asset has no table for the
context rate, listing the rates it does have. The shipped asset is SADIE II D1/KU100,
794 positions at 44.1/48 kHz, 256 taps (`assets/hrtf/`, Apache-2.0 attribution in NOTICE).

## Errors

```ts
class TuneError extends Error { readonly code: ErrorCode; readonly recovery: string }
type ErrorCode = 'DISPOSED' | 'INVALID_VALUE' | 'CROSS_ENGINE' | 'INVALID_CONNECTION' | 'NOT_RUNNING' | 'ACTIVATION_FAILED' | 'HOST_FAILURE' | 'UNSUPPORTED' | 'ASSET_FAILED' | 'CANCELLED' | 'PERMISSION_DENIED' | 'NO_DEVICE' | 'OVERFLOW' | 'PROJECT_INVALID'
```

Every TuneJS failure is a `TuneError` with a machine-readable `code`, a human `message`,
and a `recovery` hint; host causes chain under `cause` (often `AggregateError` for
cleanup). Notable triggers: `UNSUPPORTED` for absent host capabilities (fan-out, native
mic, binaural without a DSP path, missing HRTF rate); `ASSET_FAILED` for fetch/decode/
integrity problems; `OVERFLOW` when a recording drops frames; `PROJECT_INVALID` collects
every structural problem into one message; `CANCELLED` for aborted loads.
