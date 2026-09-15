# Wave 12 usability evaluation script

Status: prepared, not yet run. This script operationalizes the v0.1 specification's
usability target: *three developers unfamiliar with TuneJS should each obtain first sound
within five minutes after the starter is installed and complete a pattern/effect/spatial
modification within fifteen minutes using the docs.* Results are recorded evidence — the
target is not met until sessions are run and reported. Do not contact participants without
authorization (see `docs/roadmap.md`, external gates).

## Participants and setup

- 3 developers who have not read TuneJS internals. Any JS/TS experience level; record it.
- A machine with Node ≥ 22, a Chromium-based browser, headphones, and a microphone
  (tasks 4–5 are more comfortable with headphones).
- Starter: a clean directory with the packed snapshot installed (`npm run check:package`
  prints a tarball path) or a checkout with `npm ci && npm run build` already run.
- Allowed materials: `README.md`, `docs/development.md`, `docs/api.md`, and the example
  pages served by `npm run dev` (http://127.0.0.1:4173). No source reading tasks require
  `src/`; note if a participant resorts to it — that is a docs gap, not a participant
  failure.
- Facilitator: give the tasks verbatim, one at a time. Answer no API questions; if a
  participant is blocked past the task's time cap, mark the task failed, then unblock them
  so later tasks still run. Record everything they say about the API.

## Observation template (copy per participant per task)

```
Participant: ___   Task: ___   Date: ___
Started/finished: ___ / ___    Wall-clock time: ___   Result: pass / partial / fail
Errors seen (TuneError codes, console messages):
  -
Where they looked for help (README / development.md / api.md / example page / source / web / gave up):
  -
Missteps and wrong assumptions:
  -
Verbatim quotes:
  - "..."
Facilitator interventions (what was said, at what time):
  -
Follow-up notes (docs gap? API surprise? evidence to re-check?):
  -
```

Session-level record per participant: first sound within 5 min of starter install?
yes/no + time. Pattern/effect/spatial modification within 15 min? yes/no + time.
Versions: browser + version, OS, Node, package version (`0.0.1-dev.0`).

## Task 1 — First sound: engine + softKeys

> "Using TuneJS, make a page or script that plays a short `softKeys` chord when you press
> a button. Stop the sound, then dispose the engine."

Covers: `new Engine({ adapter: browserAdapter() })`, `engine.instrument(softKeys)`,
`connect(engine.output)`, `await engine.start()` inside the click handler,
`play(notes, { duration })`, `voice.stop()`, `engine.dispose()`.

Success criteria:
- A button press produces audible output (participant confirms they heard it).
- `start()` is called inside the gesture handler, not at module top level.
- Engine ends `disposed`; no uncaught promise rejections in the console.

Watch for: awaiting `start()` before the handler (autoplay rejection), forgetting
`connect` to `engine.output`, passing preset objects to `engine.instrument` vs. importing
from `tunejs/presets`.

## Task 2 — Load a sample

> "Load a WAV file into TuneJS and play it back. Then play only its first half, looping."

Covers: `engine.sample({ id, url | bytes })`, `sample.play({ region, loop })`,
`voice.position`/`seek`. Any short WAV the participant supplies or
`Recording.asAsset()` output is acceptable; facilitators may provide a file.

Success criteria:
- Asset resolves without an unhandled rejection; playback is audible.
- A `{ region: { start, end } }` loop runs continuously.
- Participant can state the difference between the asset `id` (cache identity) and the
  `Sample` node.

Watch for: non-WAV files (decode rejects `ASSET_FAILED` — a correct error counts as
understanding, not failure), `bytes`/`url` both set, expectation of pitch-preserving
`rate`.

## Task 3 — Three-voice pattern

> "Using the transport, loop a 4-beat pattern that plays three different voices — e.g. a
> drum hit, a bass note, and a chord. Then change the tempo while it runs and replace the
> melodic part at a bar boundary."

Covers: `engine.pattern`, `transport.schedule(pattern, target, { loop })` for an
instrument, a kit, and (optionally) a sample; `transport.bpm.set`; `part.replace`.

Success criteria:
- Three parts on one transport share the beat grid (audibly aligned).
- `bpm.set` while running returns `{ appliedAt: 'next-bar' }` and the participant waits
  for or anticipates the boundary.
- `part.replace` returns `{ effectiveBeat }`; the old phrase is not retriggered and no
  notes are left hanging after `cancel()`/`stop()`.

Watch for: scheduling parts on different engines, expecting immediate tempo change while
running, treating `notes` on a kit part as note names instead of hit names.

## Task 4 — Move a binaural emitter

> "Put on headphones. Create a binaural emitter, feed it a looping sound, and move it
> around the listener — at least once from front to behind and once across the stereo
> field. Rotate the listener if you like."

Covers: `engine.loadHrtf({ url | bytes })` for the shipped asset,
`engine.spatialSource({ rendering: 'binaural', hrtf, position })`,
`setPosition`/`setDirection`, `listener.setPose`. The asset path is
`assets/hrtf/sadie2-d1-ku100-v1.tjhrtf` (served at `/assets/hrtf/…` under `npm run dev`;
in a packed install it ships inside the package).

Success criteria:
- `rendering: 'binaural'` with a resolved `HrtfAsset` (an `hrtf` that is bytes, a string,
  or missing must produce a visible error — that error path is part of the task).
- Perceived movement while `setPosition` is called repeatedly or on a slider; no
  exceptions for finite poses.
- Participant discovers that `direction: null` is omnidirectional and that positions are
  meters, −Z forward.

Watch for: passing the asset path instead of the loaded asset, expecting stereo content
from a stereo input (mono-in), interpreting "verified" as a localization-quality promise
(record any verbatim quality judgements for the pending listening review — they do not
substitute for it).

## Task 5 — Export and render a project

> "Save your current graph and arrangement as a project, reopen it in a fresh engine, and
> render the first 8 beats plus a 1-second tail to a WAV file."

Covers: `engine.exportProject()`, `engine.importProject(project, { resolveAsset })`,
`Engine.render(project, { range: { fromBeat, toBeat }, tail: { seconds }, sampleRate, resolveAsset })`,
`result.encode({ format: 'wav' })`.

Success criteria:
- Export produces a `tunejs-project` v1 document; the participant notices `warnings`
  when the transport is running.
- Import into a new engine succeeds with `resolveAsset` supplying the recorded bytes;
  no live input/tap is attached at export time (the `PROJECT_INVALID` path is acceptable
  evidence if it occurs and is understood).
- Render returns stereo `channels` whose `frames` equal range + tail; `encode` yields a
  WAV the participant can inspect or play.

Watch for: expecting runtime handles in the export, missing `resolveAsset`, confusion
between live host output and the deterministic offline render (record verbatim
expectations — the docs state they are not claimed sample-equal).

## After the session

- Interview 5 minutes: what was hardest, what did the errors say, what did you expect
  instead? Record verbatim.
- Collect the participant's code diff or project files into the session record.
- Fill one evidence note per session under `docs/evidence/<date>/usability/` with the
  completed templates, timings, versions, and the facilitator's judgement of pass/partial/
  fail per task. Only then is the specification's usability claim evaluable.
