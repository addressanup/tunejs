# CI browser fixtures

`dsp.html` and `live.html` replicate the verified Wave-10/11 page set
(`artifacts/binaural/run/`) so CI can replay the fixture suite and the live DSP probes
without a test-runner dependency. They are static pages — no build of their own — but they
import `/dist/*` and `/experiments/*`, so run `npm ci && npm run build` first.

## Local recipe (what `.github/workflows/ci.yml` does)

```sh
npm ci && npm run build

# Prepared run dir, mirroring artifacts/host-matrix/NOTES.md:
mkdir -p ci/run
cp ci/fixtures/dsp.html ci/fixtures/live.html ci/run/
ln -sfn ../../dist ci/run/dist
ln -sfn ../../experiments ci/run/experiments
ln -sfn ../../assets ci/run/assets
cd ci/run && node ../../scripts/serve.mjs &   # http://127.0.0.1:4173

# Offline fixture suite (38 rows). ~2 s in headless Chrome; results POST to
# artifacts/browser-results.json under ci/run.
google-chrome --headless=new --mute-audio \
  --autoplay-policy=no-user-gesture-required "http://127.0.0.1:4173/dsp.html"
mv artifacts/browser-results.json dsp-results.json

# Live-context probes (5 probes). Needs the autoplay flag or resume() pends forever.
google-chrome --headless=new --mute-audio \
  --autoplay-policy=no-user-gesture-required "http://127.0.0.1:4173/live.html"
mv artifacts/browser-results.json live-results.json

node ../../ci/assert-fixtures.mjs dsp-results.json live-results.json
```

`google-chrome` is preinstalled on `ubuntu-latest` GitHub runners (the image also answers
to `google-chrome-stable`); the workflow probes `command -v` for both plus `chromium`/
`chromium-browser` and degrades to `npm test` when no browser is found.

## Reading the results

- `dsp.html` → `{ fixtureVersion, scheduling, results: [{ kind, rate, status, ... }] }`.
  All rows must be `pass`. Known host limitation: the raw-host `delayonly@48000` topology
  row fails on Safari and Android Chrome (identical arithmeticError 1.0728836e-05, onset
  one frame early) — recorded in `docs/evidence/2026-09-15/host-matrix/`. It is not a
  TuneJS defect (`dsp-delay` passes); if a CI Chrome build exhibits it, record the run
  rather than widening the assert script's acceptance.
- `live.html` → `{ dspLiveProbeVersion, sampleRate, results: [{ probe, status, ... }] }`.
  `status` may also be `inconclusive` when no tap chunks arrive — the assert script treats
  anything other than `pass` as a failure.
- Both pages take a few seconds to POST; the workflow polls for the results file rather
  than waiting on the browser process.
