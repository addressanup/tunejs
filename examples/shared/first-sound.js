// Shared by browser, Electron and React Native. Host UI owns teardown/subscriptions.
import { Engine } from 'tunejs';
export function firstSound(adapter) {
  const engine = new Engine({ adapter });
  const tone = engine.oscillator({ frequencyHz: 220, wave: 'triangle' });
  const filter = engine.filter({ frequencyHz: 1200 });
  const level = engine.gain({ gain: 0.06 });
  tone.connect(filter).connect(level).connect(engine.output);
  let voice;
  return {
    engine, filter, level,
    async play() { await engine.start(); voice?.stop(); voice = tone.play({ duration: { seconds: 2 } }); },
    stop() { voice?.stop(); },
    dispose() { return engine.dispose(); },
  };
}
