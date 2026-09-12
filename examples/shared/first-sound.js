// Shared by browser, Electron and React Native. Host UI owns teardown/subscriptions.
import { Engine } from 'tunejs';
import { softKeys } from 'tunejs/presets';
export function firstSound(adapter) {
  const engine = new Engine({ adapter });
  const keys = engine.instrument(softKeys);
  keys.connect(engine.output);
  let chord;
  return {
    engine, keys,
    async play() { await engine.start(); chord?.stop(); chord = keys.play(['C4', 'E4', 'G4'], { duration: { seconds: 1.5 } }); },
    stop() { chord?.stop(); },
    dispose() { return engine.dispose(); },
  };
}
