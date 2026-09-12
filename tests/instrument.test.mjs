import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Engine,TuneError,noteToFrequency} from '../dist/index.js';
import {softKeys} from '../dist/presets.js';
const code=expected=>error=>error instanceof TuneError && error.code===expected;
const close=(a,b)=>Math.abs(a-b)<=1e-9;

// Per-node event capture: each created node's `events` records its own param calls; `disconnects`
// counts host disconnect calls. Creation order is fixed by Instrument/SynthVoice: level gain is
// gains[0] is the engine master gain, gains[1] the instrument level gain, the preset filter is filters[0], then each note voice appends env gain + 3 layer gains
// and 3 oscillators (softKeys has 3 layers).
function host() {
  const hostCalls=[],gains=[],oscs=[],filters=[];
  const mkparam=events=>({value:1,setValueAtTime(v,t){events.push(['set',v,t]);},linearRampToValueAtTime(v,t){events.push(['ramp',v,t]);},cancelScheduledValues(t){events.push(['cancel',t]);}});
  const mknode=()=>({disconnects:0,connect(){},disconnect(){this.disconnects++;}});
  const context={state:'suspended',sampleRate:48000,currentTime:0,destination:mknode(),
    createGain(){const events=[];const g={...mknode(),events,gain:mkparam(events)};gains.push(g);return g;},
    createBiquadFilter(){const events=[];const f={...mknode(),events,type:'lowpass',frequency:mkparam(events),Q:mkparam(events)};filters.push(f);return f;},
    createOscillator(){const events=[];const o={...mknode(),events,type:'sine',frequency:mkparam(events),starts:[],stops:[],start(t){this.starts.push(t);},stop(t){this.stops.push(t);}};oscs.push(o);return o;},
    async resume(){this.state='running';},async suspend(){this.state='suspended';},async close(){this.state='closed';}};
  const adapter={hostLimits:{fanOut:true},name:'instrument-test-double',createContext(){return context;},setEnded(node,fn){node.onEnded=fn;},hostTime(frame,rate){hostCalls.push([frame,rate]);return frame/rate;}};
  return {engine:new Engine({adapter}),context,gains,oscs,filters,hostCalls};
}
function assertEvents(actual,expected) {
  assert.equal(actual.length,expected.length,`events: ${JSON.stringify(actual)}`);
  for(const [i,event] of actual.entries()) {
    assert.equal(event[0],expected[i][0],`kind at ${i}`);
    assert.ok(close(event[1],expected[i][1]),`value at ${i}: ${event[1]} vs ${expected[i][1]}`);
    if(expected[i].length>2) assert.ok(close(event[2],expected[i][2]),`time at ${i}: ${event[2]} vs ${expected[i][2]}`);
  }
}
const preset=overrides=>({name:'test',layers:[{wave:'sine'}],envelope:{attack:.01,decay:.1,sustain:.5,release:.2},level:.5,...overrides});

test('noteToFrequency maps names to equal temperament and rejects malformed names',()=>{
  assert.equal(noteToFrequency('A4'),440);
  assert.ok(Math.abs(noteToFrequency('C4')-261.6256)<1e-3);
  assert.equal(noteToFrequency('C#4'),noteToFrequency('Db4'));
  assert.equal(noteToFrequency('a4'),440);
  for(const bad of ['H4','C','','C10','C#-2']) assert.throws(()=>noteToFrequency(bad),code('INVALID_VALUE'));
});

test('preset and voice-limit validation rejects malformed definitions',()=>{
  const h=host(),e=h.engine;
  assert.throws(()=>e.instrument(preset({layers:[]})),code('INVALID_VALUE'));
  assert.throws(()=>e.instrument(preset({layers:Array(9).fill({wave:'sine'})})),code('INVALID_VALUE'));
  assert.throws(()=>e.instrument(preset({layers:[{wave:'noise'}]})),code('INVALID_VALUE'));
  assert.throws(()=>e.instrument(preset({layers:[{wave:'sine',ratio:0}]})),code('INVALID_VALUE'));
  assert.throws(()=>e.instrument(preset({envelope:{attack:.01,decay:.1,sustain:1.5,release:.2}})),code('INVALID_VALUE'));
  assert.throws(()=>e.instrument(preset({envelope:{attack:.01,decay:.1,sustain:.5,release:0}})),code('INVALID_VALUE'));
  assert.throws(()=>e.instrument(preset({level:5})),code('INVALID_VALUE'));
  assert.throws(()=>e.instrument(preset({maxVoices:0})),code('INVALID_VALUE'));
  assert.throws(()=>e.instrument(preset({maxVoices:65})),code('INVALID_VALUE'));
  assert.throws(()=>e.instrument(preset({maxVoices:1.5})),code('INVALID_VALUE'));
  assert.equal(e.instrument(softKeys).maxVoices,16);
  assert.equal(e.instrument(softKeys,{maxVoices:4}).maxVoices,4);
});

test('chord allocation builds per-layer voices on adapter frame times',async()=>{
  const h=host(),e=h.engine;const keys=e.instrument(softKeys);keys.connect(e.output);await e.start();
  h.context.currentTime=0.5;
  const chord=keys.play(['C4','E4','G4']);
  assert.equal(h.oscs.length,9);
  assert.equal(h.gains.length,2+3*4);
  assert.equal(h.filters.length,1);
  for(const osc of h.oscs) assert.ok(close(osc.starts[0],24000/48000),`start ${osc.starts[0]}`);
  assert.ok(h.hostCalls.filter(call=>call[0]===24000&&call[1]===48000).length>=3);
  for(const k of [0,1,2]) assertEvents(h.gains[2+k*4].events,[['set',0,0.5],['ramp',0.8,0.512],['ramp',0.44,0.862]]);
  assert.equal(keys.activeVoices,3);
  assert.equal(e.diagnostics.voices,3);
  assert.equal(chord.state,'playing');
  keys.play('A4');
  const aOscs=h.oscs.slice(9,12);
  assert.ok(close(aOscs[0].events[0][1],440));
  assert.ok(close(aOscs[1].events[0][1],880));
  assert.ok(close(aOscs[2].events[0][1],440*2**(6/1200)));
  await e.dispose();
});

test('scheduled duration ends with the envelope release and host-frame stops',async()=>{
  const h=host(),e=h.engine;const keys=e.instrument(softKeys);keys.connect(e.output);await e.start();
  h.context.currentTime=0.5;
  keys.play('A4',{duration:{seconds:2}});
  const env=h.gains[2];
  assertEvents(env.events.slice(-2),[['set',0.44,2.5],['ramp',0,2.9]]);
  const stopSeconds=(Math.round(2.9*48000)+1)/48000;
  for(const osc of h.oscs) assert.ok(close(osc.stops[0],stopSeconds),`stop ${osc.stops[0]}`);
  keys.play('A4',{duration:{seconds:0.006}});
  assertEvents(h.gains[6].events,[['set',0,0.5],['ramp',0.4,0.506],['ramp',0,0.906]]);
  assert.ok(!h.gains[6].events.some(e=>e[1]===0.8));
  keys.play('A4',{duration:{seconds:0.2}});
  const expected=0.8+(0.44-0.8)*((0.7-0.512)/0.35);
  assertEvents(h.gains[10].events,[['set',0,0.5],['ramp',0.8,0.512],['ramp',expected,0.7],['ramp',0,1.1]]);
  await e.dispose();
});

test('live release mid-attack cancels to the interpolated value',async()=>{
  const h=host(),e=h.engine;const keys=e.instrument(softKeys);keys.connect(e.output);await e.start();
  h.context.currentTime=0.5;
  const chord=keys.play('A4');
  const env=h.gains[2];
  h.context.currentTime=0.506;
  chord.stop();
  assert.equal(chord.state,'stopping');
  assertEvents(env.events.slice(3),[['cancel',0.506],['set',0.4,0.506],['ramp',0,0.906]]);
  const stopSeconds=(Math.round(0.906*48000)+1)/48000;
  for(const osc of h.oscs) assert.ok(close(osc.stops[0],stopSeconds),`stop ${osc.stops[0]}`);
  h.oscs[0].onEnded();
  assert.equal(chord.state,'ended');
  assert.equal(keys.activeVoices,0);
  assert.equal(e.voices.size,0);
  for(const node of [...h.oscs,...h.gains.slice(2,6)]) assert.equal(node.disconnects,1);
  const length=env.events.length;
  chord.stop();
  assert.equal(env.events.length,length);
  await e.dispose();
});

test('voice stealing releases the oldest live voice and tolerates full-overshoot',async()=>{
  const h=host(),e=h.engine;const keys=e.instrument(softKeys,{maxVoices:2});keys.connect(e.output);await e.start();
  h.context.currentTime=0.5;
  keys.play('C4');keys.play('E4');keys.play('G4');
  const c4env=h.gains[2];
  assertEvents(c4env.events.slice(-3),[['cancel',0.5],['set',0,0.5],['ramp',0,0.52]]);
  assert.equal(keys.activeVoices,3);
  h.oscs[0].onEnded();
  assert.equal(keys.activeVoices,2);
  keys.stopAll();
  keys.play('A4');keys.play('B4');
  assert.ok(keys.activeVoices>2);
  for(const osc of h.oscs) if(osc.onEnded) osc.onEnded();
  assert.equal(keys.activeVoices,0);
  const created=h.oscs.length;
  assert.throws(()=>keys.play(['C4','E4','G4']),code('INVALID_VALUE'));
  assert.equal(h.oscs.length,created);
  await e.dispose();
});

test('setEnvelope validates and affects only voices played afterwards',async()=>{
  const h=host(),e=h.engine;const keys=e.instrument(softKeys);keys.connect(e.output);await e.start();
  h.context.currentTime=0.5;
  const before=keys.play('A4');
  keys.setEnvelope({release:1});
  assert.equal(keys.envelope.release,1);
  const after=keys.play('B4');
  h.context.currentTime=0.6;
  before.stop();after.stop();
  const atStop=0.8+(0.44-0.8)*((0.6-0.512)/0.35);
  assertEvents(h.gains[2].events.slice(-3),[['cancel',0.6],['set',atStop,0.6],['ramp',0,1]]);
  assertEvents(h.gains[6].events.slice(-3),[['cancel',0.6],['set',atStop,0.6],['ramp',0,1.6]]);
  assert.throws(()=>keys.setEnvelope({release:0}),code('INVALID_VALUE'));
  await e.dispose();
});

test('host failure during chord allocation releases this call\'s voices',async()=>{
  const h=host(),e=h.engine;const keys=e.instrument(softKeys);keys.connect(e.output);await e.start();
  h.context.currentTime=0.5;
  const createOscillator=h.context.createOscillator;let calls=0;
  h.context.createOscillator=()=>{if(++calls===2) throw new Error('allocation failed');return createOscillator.call(h.context);};
  assert.throws(()=>keys.play(['C4','E4']),code('HOST_FAILURE'));
  assert.equal(keys.activeVoices,0);
  assert.equal(e.voices.size,0);
  for(const node of [...h.oscs,...h.gains.slice(2)]) assert.equal(node.disconnects,1);
  await e.dispose();
});

test('instrument dispose ends live voices, drops the host chain and rejects further use',async()=>{
  const h=host(),e=h.engine;const keys=e.instrument(softKeys);keys.connect(e.output);await e.start();
  h.context.currentTime=0.5;
  keys.play(['C4','E4']);
  const filter=h.filters[0];
  keys.dispose();
  assert.equal(keys.activeVoices,0);
  assert.equal(e.voices.size,0);
  for(const node of [...h.oscs,...h.gains.slice(2)]) assert.equal(node.disconnects,1);
  assert.equal(filter.disconnects,1);
  assert.equal(keys.input,undefined);
  assert.equal(e.nodes.has(keys),false);
  assert.throws(()=>keys.play('A4'),code('DISPOSED'));
  const idle=host();const fresh=idle.engine.instrument(softKeys);
  assert.throws(()=>fresh.play('A4'),code('NOT_RUNNING'));
  await e.dispose();await idle.engine.dispose();
});

test('100 instrument cycles release all graph and voice resources',async()=>{
  for(let i=0;i<100;i++) {
    const h=host(),e=h.engine;const keys=e.instrument(softKeys);keys.connect(e.output);await e.start();
    const chord=keys.play(['C4','E4','G4'],{duration:{seconds:0.01}});
    chord.stop();
    await e.dispose();
    assert.equal(e.diagnostics.nodes,0);
    assert.equal(e.diagnostics.voices,0);
  }
});
