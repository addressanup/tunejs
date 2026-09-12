// Shared by browser, Electron and React Native. Host UI owns teardown/subscriptions.
import { Engine, Instrument, Kit } from 'tunejs';
import { softKeys, softDrums } from 'tunejs/presets';

// Two alternating four-beat phrases over a steady percussion loop — the transport keeps the grid,
// so replacing the phrase applies at the next bar without touching the drums.
export function livingLoop(adapter) {
  const engine = new Engine({ adapter });
  const keys = engine.instrument(softKeys);
  const drums = engine.kit(softDrums);
  keys.connect(engine.output);
  drums.connect(engine.output);
  const transport = engine.transport;
  transport.bpm.set(108);
  const percussion = engine.pattern({
    length: { beats: 4 },
    events: [
      { beat: 0, notes: 'kick', duration: { beats: 0.5 } },
      { beat: 1, notes: 'snare', duration: { beats: 0.5 } },
      { beat: 2, notes: 'kick', duration: { beats: 0.5 } },
      { beat: 3, notes: 'snare', duration: { beats: 0.5 } },
      { beat: 0.5, notes: 'hat', duration: { beats: 0.25 } },
      { beat: 1.5, notes: 'hat', duration: { beats: 0.25 } },
      { beat: 2.5, notes: 'hat', duration: { beats: 0.25 } },
      { beat: 3.5, notes: 'hat', duration: { beats: 0.25 } },
    ],
  });
  const phraseA = engine.pattern({
    length: { beats: 4 },
    events: [
      { beat: 0, notes: 'C4', duration: { beats: 1 } },
      { beat: 1, notes: 'E4', duration: { beats: 1 } },
      { beat: 2, notes: 'G4', duration: { beats: 1 } },
      { beat: 3, notes: 'E4', duration: { beats: 1 } },
    ],
  });
  const phraseB = engine.pattern({
    length: { beats: 4 },
    events: [
      { beat: 0, notes: 'A3', duration: { beats: 0.5 } },
      { beat: 0.5, notes: 'C4', duration: { beats: 0.5 } },
      { beat: 1, notes: 'E4', duration: { beats: 1 } },
      { beat: 2, notes: 'D4', duration: { beats: 1.5 } },
      { beat: 3.5, notes: 'C4', duration: { beats: 0.5 } },
    ],
  });
  transport.schedule(percussion, drums);
  let phrase = transport.schedule(phraseA, keys);
  let onA = true;
  return {
    engine, keys, drums, transport,
    async start() { await engine.start(); transport.start(); },
    stop() { transport.stop(); },
    replacePhrase() { const ack = phrase.replace(onA ? phraseB : phraseA, { boundary: 'next-bar' }); onA = !onA; return ack; },
    setTempo(bpm) { return transport.bpm.set(bpm); },
    exportProject() { return engine.exportProject(); },
    dispose() { return engine.dispose(); },
  };
}

// Rebuild a living-loop-shaped session from an imported project. Targets are found by type; the
// phrase library (phraseA/phraseB) is not part of the project format, so replacePhrase is absent.
export async function importLoop(adapter, project, { resolveAsset } = {}) {
  const engine = new Engine({ adapter });
  await engine.start();
  const { nodes } = await engine.importProject(project, { resolveAsset });
  const keys = [...nodes.values()].find(node => node instanceof Instrument);
  const drums = [...nodes.values()].find(node => node instanceof Kit);
  const transport = engine.transport;
  return {
    engine, keys, drums, transport,
    async start() { transport.start(); },
    stop() { transport.stop(); },
    setTempo(bpm) { return transport.bpm.set(bpm); },
    exportProject() { return engine.exportProject(); },
    dispose() { return engine.dispose(); },
  };
}
