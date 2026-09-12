// Shared by browser, Electron and React Native. Host UI owns teardown/subscriptions.
import { Engine } from 'tunejs';
import { pluck } from 'tunejs/presets';

// Four pluck emitters on a 3 m circle (phases a quarter-turn apart), each retriggered by a
// transport pattern on its own note. The stereo renderer pans each voice by its azimuth.
const NOTES = ['C4', 'E4', 'G4', 'A4'];

export function spatialPlayground(adapter) {
  const engine = new Engine({ adapter });
  const listener = engine.listener;
  const transport = engine.transport;
  transport.bpm.set(96);
  const emitters = [];
  const ready = (async () => {
    for (let i = 0; i < 4; i += 1) {
      const keys = engine.instrument(pluck);
      const source = await engine.spatialSource({ rendering: 'stereo' });
      keys.connect(source).connect(engine.output);
      const pattern = engine.pattern({
        length: { beats: 4 },
        events: [{ beat: i, notes: NOTES[i], duration: { beats: 1 } }],
      });
      transport.schedule(pattern, keys);
      emitters.push({ source, keys });
    }
  })();
  const move = time => {
    for (let i = 0; i < emitters.length; i += 1) {
      const angle = time * 0.4 + (i * Math.PI) / 2;
      emitters[i].source.setPosition({ x: 3 * Math.cos(angle), y: 0, z: 3 * Math.sin(angle) });
    }
  };
  return {
    engine, emitters, listener, transport, ready,
    async start() { await ready; await engine.start(); transport.start(); move(0); },
    move,
    rotateListener(radians) {
      // Absolute yaw from the default −Z forward (UI sliders send absolute angles).
      listener.setPose({ forward: { x: -Math.sin(radians), y: 0, z: -Math.cos(radians) } });
    },
    stop() { transport.stop(); },
    dispose() { return engine.dispose(); },
  };
}
