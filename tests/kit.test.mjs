import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Engine,TuneError} from '../dist/index.js';
import {softDrums,softKeys} from '../dist/presets.js';
const code=expected=>error=>error instanceof TuneError && error.code===expected;

function host() {
  const events=[],gains=[],filters=[],oscs=[],buffers=[],sources=[];
  const mkparam=ev=>({value:1,setValueAtTime(v,t){ev.push(['set',v,t]);},linearRampToValueAtTime(v,t){ev.push(['ramp',v,t]);},cancelScheduledValues(t){ev.push(['cancel',t]);}});
  const mknode=()=>({disconnects:0,connections:[],connect(t){this.connections.push(t);},disconnect(){this.disconnects++;}});
  const context={state:'suspended',sampleRate:48000,currentTime:0,destination:mknode(),
    createGain(){const ev=[];const g={...mknode(),events:ev,gain:mkparam(ev)};gains.push(g);return g;},
    createBiquadFilter(){const ev=[];const f={...mknode(),events:ev,type:'lowpass',frequency:mkparam(ev),Q:mkparam(ev)};filters.push(f);return f;},
    createOscillator(){const ev=[];const o={...mknode(),events:ev,type:'sine',frequency:mkparam(ev),starts:[],stops:[],start(...a){this.starts.push(a);},stop(t){this.stops.push(t);}};oscs.push(o);return o;},
    createBuffer(channels,frames,rate){const b={sampleRate:rate,length:frames,numberOfChannels:channels,copies:[],data:null,copyToChannel(src,i){this.copies.push([i,src.length]);if(i===0)this.data=src.slice();}};buffers.push(b);return b;},
    createBufferSource(){const ev=[];const s={...mknode(),events:ev,buffer:null,loop:false,loopStart:0,loopEnd:0,playbackRate:mkparam(ev),starts:[],stops:[],start(...a){this.starts.push(a);},stop(t){this.stops.push(t);}};sources.push(s);return s;},
    async resume(){this.state='running';},async suspend(){this.state='suspended';},async close(){this.state='closed';}};
  const adapter={hostLimits:{fanOut:true},name:'kit-test-double',createContext(){return context;},setEnded(node,fn){node.onEnded=fn;},hostTime(frame,rate){events.push(['hostTime',frame,rate]);return frame/rate;}};
  return {engine:new Engine({adapter}),context,events,gains,filters,oscs,buffers,sources};
}

test('engine caches one deterministic noise buffer per context rate',async()=>{
  const h=host(),e=h.engine;
  const kit=e.kit(softDrums);kit.connect(e.output);
  const keys=e.instrument(softKeys);keys.connect(e.output);
  await e.start();
  kit.play('snare'); // noise + triangle
  kit.play('hat');   // second noise layer reuses the cached buffer
  assert.equal(h.buffers.length,1);
  assert.equal(h.buffers[0].numberOfChannels,1);
  assert.equal(h.buffers[0].length,96000);
  assert.equal(h.buffers[0].sampleRate,48000);
  assert.deepEqual(h.buffers[0].copies,[[0,96000]]);
  for(const x of h.buffers[0].data) assert.ok(Math.abs(x)<1);
  const h2=host(),e2=h2.engine;
  const k2=e2.kit(softDrums);k2.connect(e2.output);
  await e2.start();
  k2.play('hat');
  assert.equal(h2.buffers.length,1,'second engine builds its own noise buffer');
  assert.deepEqual([...h2.buffers[0].data],[...h.buffers[0].data],'noise is deterministic across engines');
  await e.dispose();await e2.dispose();
});

test('noise and pitch layers build the documented voice graph',async()=>{
  const h=host(),e=h.engine;
  const kit=e.kit(softDrums);kit.connect(e.output);await e.start();
  h.context.currentTime=0.25;
  kit.play('snare');
  const t0=0.25;
  assert.equal(h.sources.length,1,'one buffer source for the noise layer');
  assert.equal(h.oscs.length,1,'one oscillator for the pitched layer');
  const noise=h.sources[0];
  assert.equal(noise.loop,true);
  assert.equal(noise.buffer,h.buffers[0]);
  const filter=h.filters[0];
  assert.equal(filter.type,'highpass');
  assert.deepEqual(filter.events,[['set',1800,t0],['set',0,t0]],'frequency then Q scheduled on the layer filter');
  // noise -> highpass filter -> layer gain -> env -> kit level gain
  assert.equal(noise.connections[0],filter);
  const noiseLayerGain=filter.connections[0];
  const env=noiseLayerGain.connections[0];
  assert.equal(env.connections[0],kit.host);
  const osc=h.oscs[0];
  assert.deepEqual(osc.connections[0].connections[0],env,'triangle layer gain feeds the same env');
  // pitch envelope: 180*1.6 -> 180 over 0.03 s
  assert.deepEqual(osc.events,[['set',288,t0],['ramp',180,t0+0.03]]);
  assert.deepEqual(noise.starts[0],[t0]);
  assert.deepEqual(osc.starts[0],[t0]);
  await e.dispose();
});

test('at schedules voices on future frames for kits and instruments',async()=>{
  const h=host(),e=h.engine;
  const kit=e.kit(softDrums);kit.connect(e.output);
  const keys=e.instrument(softKeys);keys.connect(e.output);
  await e.start();
  h.context.currentTime=0.5;
  const frame=e.currentFrame+4800;
  const v=kit.play('kick',{at:{frame}});
  assert.equal(v.state,'playing');
  const startAt=frame/48000;
  assert.deepEqual(h.oscs[0].starts[0],[startAt]);
  // env gain: ['set',0,t0] first
  const env=h.gains.find(g=>g.events[0]&&g.events[0][0]==='set'&&g.events[0][1]===0&&g.events[0][2]===frame/48000);
  assert.ok(env,'envelope anchored at the scheduled frame');
  assert.throws(()=>kit.play('kick',{at:{frame:e.currentFrame-1}}),code('INVALID_VALUE'));
  assert.throws(()=>kit.play('kick',{at:{frame:frame+0.5}}),code('INVALID_VALUE'));
  const oscsBefore=h.oscs.length;
  assert.throws(()=>kit.play('kick',{at:{frame:0}}),code('INVALID_VALUE'));
  assert.equal(h.oscs.length,oscsBefore,'no host nodes for rejected at');
  keys.play('C4',{at:{frame}});
  assert.equal(h.oscs.at(-1).starts[0][0],startAt,'instrument accepts at identically');
  await e.dispose();
});

test('kit exposes hits, validates names, steals across hits and cleans up',async()=>{
  const h=host(),e=h.engine;
  const kit=e.kit(softDrums,{maxVoices:2});kit.connect(e.output);
  assert.deepEqual(kit.hits,['kick','snare','hat']);
  assert.equal(kit.maxVoices,2);
  await e.start();
  assert.throws(()=>kit.play('boom'),code('INVALID_VALUE'));
  assert.equal(h.oscs.length,0,'no host work for an unknown hit');
  const two=kit.play(['kick','hat']);
  assert.equal(two.state,'playing');
  assert.equal(kit.activeVoices,2);
  kit.play('snare'); // steals the oldest
  assert.equal(kit.activeVoices,3);
  h.oscs[0].onEnded();
  assert.equal(kit.activeVoices,2);
  kit.stopAll();
  for(const s of [...h.oscs,...h.sources]) if(s.onEnded) s.onEnded();
  assert.equal(kit.activeVoices,0);
  kit.dispose();
  assert.equal(e.nodes.has(kit),false);
  assert.throws(()=>kit.play('kick'),code('DISPOSED'));
  await e.dispose();
  assert.equal(e.diagnostics.nodes,0);
  for(let i=0;i<100;i++){
    const h2=host(),e2=h2.engine;
    e2.kit(softDrums).connect(e2.output);
    await e2.start();await e2.dispose();
    assert.equal(e2.diagnostics.nodes,0);
    assert.equal(e2.diagnostics.voices,0);
  }
});

test('invalid kit presets and noise-layer options reject before host work',async()=>{
  const h=host(),e=h.engine;
  assert.throws(()=>e.kit({name:'x',level:0.5,hits:{}}),code('INVALID_VALUE'));
  assert.throws(()=>e.kit({name:'x',level:0.5,hits:Object.fromEntries(Array.from({length:17},(_,i)=>[`h${i}`,{frequencyHz:100,layers:[{wave:'sine'}],envelope:softDrums.hits.kick.envelope}]))}),code('INVALID_VALUE'));
  assert.throws(()=>e.kit({name:'x',level:0.5,hits:{bad:{frequencyHz:0,layers:[{wave:'sine'}],envelope:softDrums.hits.kick.envelope}}}),code('INVALID_VALUE'));
  assert.throws(()=>e.kit({name:'x',level:0.5,hits:{bad:{frequencyHz:100,layers:[{source:'noise',wave:'sine'}],envelope:softDrums.hits.kick.envelope}}}),code('INVALID_VALUE'));
  await e.dispose();
});
