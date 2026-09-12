// Shared by browser, Electron and React Native. Host UI owns teardown/subscriptions.
import { Engine } from 'tunejs';

// Microphone → meter (level) → bounded recorder → WAV asset → sample playback. No monitoring path.
export function recordReuse(adapter) {
  const engine = new Engine({ adapter });
  let microphone = null;
  let meter = null;
  let recorder = null;
  let recording = null;
  let sample = null;
  let voice = null;
  return {
    engine,
    async start() { await engine.start(); },
    async arm() {
      microphone = await engine.input({ kind: 'microphone' });
      meter = await engine.meter({ source: microphone });
      return microphone;
    },
    async record(seconds = 10) {
      if (!microphone) throw new Error('arm() first');
      recorder = engine.recorder({ source: microphone, maxSeconds: seconds });
      await recorder.start();
      return recorder;
    },
    async stopRecording() {
      recording = await recorder.stop();
      sample = await engine.sample(recording.asAsset('take-1'));
      sample.connect(engine.output);
      return recording;
    },
    play() { voice = sample?.play(); return voice; },
    seek(seconds) { return voice?.seek(seconds); },
    readMeter() { return meter?.read(); },
    get recording() { return recording; },
    get recorder() { return recorder; },
    get microphone() { return microphone; },
    async dispose() {
      meter?.dispose();
      await engine.dispose();
    },
  };
}
