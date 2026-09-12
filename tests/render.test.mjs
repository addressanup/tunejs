import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Engine,TuneError,syntheticReverbResponse} from '../dist/index.js';
import {softKeys,softDrums} from '../dist/presets.js';
import {decodeWav} from '../dist/assets.js';
import {wav} from './helpers/wav.mjs';

const code=expected=>error=>error instanceof TuneError && error.code===expected;

// Minimal host double: rendering never touches it, but building a project through the public API does.
function host() {
  const param=()=>({value:1,setValueAtTime(){},linearRampToValueAtTime(){},cancelScheduledValues(){}});
  const node=()=>({connect(){},disconnect(){}});
  const context={state:'suspended',sampleRate:48000,currentTime:0,destination:node(),
    createGain:()=>({...node(),gain:param()}),createBiquadFilter:()=>({...node(),type:'lowpass',frequency:param(),Q:param()}),
    createOscillator:()=>({...node(),type:'sine',frequency:param(),start(){},stop(){}}),createStereoPanner:()=>({...node(),pan:param()}),
    createDelay:()=>({...node(),delayTime:param()}),createConvolver:()=>({...node(),buffer:null,normalize:true}),
    createBuffer:(c,f,r)=>({sampleRate:r,length:f,numberOfChannels:c,copyToChannel(){}}),createBufferSource:()=>({...node(),buffer:null,loop:false,loopStart:0,loopEnd:0,playbackRate:param(),start(){},stop(){}}),
    async resume(){this.state='running';},async suspend(){this.state='suspended';},async close(){this.state='closed';}};
  return new Engine({adapter:{name:'render-test-double',hostLimits:{fanOut:true},createContext:()=>context,setEnded(){},hostTime:(f,r)=>f/r}});
}
// Float32 mono impulse asset (exact 1.0 at frame 0) so single-node behaviour can be checked exactly at 48 kHz.
const impulseBytes=(()=>{const data=new Float32Array(48000);data[0]=1;return wav([data],48000,'float32');})();
const stereoImpulseBytes=(()=>{const l=new Float32Array(48000),r=new Float32Array(48000);l[0]=1;r[0]=0.5;return wav([l,r],48000,'float32');})();
const resolveAsset=async id=>id==='stereo'?stereoImpulseBytes:impulseBytes;

// Build a project whose only content is one sample playing once at beat 0 through the node returned by `chain(engine)`.
async function impulseProject(chain,{assetId='impulse',region}={}) {
  const e=host();
  const sample=await e.sample({id:assetId,bytes:assetId==='stereo'?stereoImpulseBytes:impulseBytes});
  const tail=chain?chain(e):null;
  if(tail) sample.connect(tail).connect(e.output); else sample.connect(e.output);
  e.transport.schedule(e.pattern({length:{beats:4},events:[{beat:0,notes:'sample',duration:{beats:4},...(region?{region}:{})}]}),sample,{at:{beats:0},loop:false});
  const {project}=e.exportProject();
  await e.dispose();
  return project;
}
const maxAbs=(data,from=0,to=data.length)=>{let m=0;for(let i=from;i<to;i++) m=Math.max(m,Math.abs(data[i]));return m;};
const close=(a,b,tolerance)=>assert.ok(Math.abs(a-b)<=tolerance,`${a} vs ${b} (tolerance ${tolerance})`);
// RBJ biquad reference as specified by Web Audio for BiquadFilterNode lowpass/highpass with Q in dB.
function rbj(type,frequency,qDb,sampleRate,input) {
  const w=2*Math.PI*frequency/sampleRate, q=10**(qDb/20), alpha=Math.sin(w)/(2*q), cw=Math.cos(w);
  let b0,b1,b2; const a0=1+alpha, a1=-2*cw, a2=1-alpha;
  if(type==='lowpass'){ b0=(1-cw)/2; b1=1-cw; b2=b0; } else { b0=(1+cw)/2; b1=-(1+cw); b2=b0; }
  const out=new Float64Array(input.length); let x1=0,x2=0,y1=0,y2=0;
  for(let i=0;i<input.length;i++){ const x=input[i]; const y=(b0*x+b1*x1+b2*x2-a1*y1-a2*y2)/a0; out[i]=y; x2=x1;x1=x;y2=y1;y1=y; }
  return out;
}

test('render produces the requested range plus tail at both sample rates and is deterministic',async()=>{
  const e=host(); const keys=e.instrument(softKeys); keys.connect(e.output);
  e.transport.schedule(e.pattern({length:{beats:4},events:[{beat:0,notes:['C4','E4','G4'],duration:{beats:1}},{beat:2,notes:'A4',duration:{beats:0.5}}]}),keys);
  const {project}=e.exportProject(); await e.dispose();
  const result=await Engine.render(project,{range:{fromBeat:0,toBeat:4},tail:{seconds:0.5},sampleRate:48000});
  assert.equal(result.sampleRate,48000); assert.equal(result.frames,96000+24000); assert.equal(result.channels.length,2);
  assert.equal(result.channels[0].length,result.frames); assert.ok(result.channels[0].every(Number.isFinite));
  assert.ok(maxAbs(result.channels[0],0,48000)>0.01,'the chord is audible in the first two seconds');
  assert.ok(maxAbs(result.channels[0],result.frames-2400)<1e-6,'the tail decays to silence');
  const again=await Engine.render(project,{range:{fromBeat:0,toBeat:4},tail:{seconds:0.5},sampleRate:48000});
  assert.deepEqual([...again.channels[0]],[...result.channels[0]]); assert.deepEqual([...again.channels[1]],[...result.channels[1]]);
  const other=await Engine.render(project,{range:{fromBeat:0,toBeat:4},tail:{seconds:0.5},sampleRate:44100});
  assert.equal(other.frames,88200+22050);
  const seconds=await Engine.render(project,{range:{fromSeconds:0.5,toSeconds:1.25},tail:{seconds:0},sampleRate:48000});
  assert.equal(seconds.frames,36000);
  const wavOut=seconds.encode({format:'wav'});
  const decoded=decodeWav(wavOut.bytes); assert.equal(decoded.frames,36000); assert.equal(decoded.channels.length,2); assert.equal(wavOut.clippedSamples,0);
});

test('render validates its arguments and refuses unsupported projects',async()=>{
  const e=host(); e.instrument(softKeys).connect(e.output); const {project}=e.exportProject(); await e.dispose();
  await assert.rejects(Engine.render(project,{range:{fromBeat:0,toBeat:4},tail:{seconds:0},sampleRate:22050}),code('INVALID_VALUE'));
  await assert.rejects(Engine.render(project,{range:{fromBeat:4,toBeat:4},tail:{seconds:0},sampleRate:48000}),code('INVALID_VALUE'));
  await assert.rejects(Engine.render(project,{range:{fromBeat:0,toBeat:4},tail:{seconds:-1},sampleRate:48000}),code('INVALID_VALUE'));
  await assert.rejects(Engine.render(project,{range:{fromBeat:0,toBeat:4},tail:{seconds:0},sampleRate:48000,maxSeconds:1}),code('INVALID_VALUE'));
  await assert.rejects(Engine.render({...project,version:2},{range:{fromBeat:0,toBeat:4},tail:{seconds:0},sampleRate:48000}),code('PROJECT_INVALID'));
  const withSample=await impulseProject(null);
  await assert.rejects(Engine.render(withSample,{range:{fromBeat:0,toBeat:1},tail:{seconds:0},sampleRate:48000}),code('PROJECT_INVALID'));
  await assert.rejects(Engine.render(withSample,{range:{fromBeat:0,toBeat:1},tail:{seconds:0},sampleRate:48000,resolveAsset:async()=>{throw new Error('offline');}}),code('ASSET_FAILED'));
});

test('sample, gain, bus and filter nodes render exactly against their references',async()=>{
  const plain=await Engine.render(await impulseProject(null),{range:{fromBeat:0,toBeat:1},tail:{seconds:0},sampleRate:48000,resolveAsset});
  assert.equal(plain.frames,24000);
  assert.equal(plain.channels[0][0],1); assert.equal(plain.channels[1][0],1,'mono sources reach both output channels');
  assert.equal(maxAbs(plain.channels[0],1),0);
  const gained=await Engine.render(await impulseProject(e=>e.gain({gain:0.5})),{range:{fromBeat:0,toBeat:1},tail:{seconds:0},sampleRate:48000,resolveAsset});
  assert.equal(gained.channels[0][0],0.5); assert.equal(maxAbs(gained.channels[1],1),0);
  const bus=await Engine.render(await impulseProject(e=>e.bus({gainDb:-6.0206})),{range:{fromBeat:0,toBeat:1},tail:{seconds:0},sampleRate:48000,resolveAsset});
  close(bus.channels[0][0],0.5,1e-5);
  for(const type of ['lowpass','highpass']) {
    const filtered=await Engine.render(await impulseProject(e=>e.filter({type,frequencyHz:1200})),{range:{fromBeat:0,toBeat:1},tail:{seconds:0},sampleRate:48000,resolveAsset});
    const impulse=new Float64Array(256); impulse[0]=1;
    const reference=rbj(type,1200,0,48000,impulse);
    for(let i=0;i<256;i++) close(filtered.channels[0][i],reference[i],1e-6);
  }
});

test('stereo pan and spatial nodes render the documented equal-power laws',async()=>{
  const left=await Engine.render(await impulseProject(e=>e.pan({pan:-0.75})),{range:{fromBeat:0,toBeat:1},tail:{seconds:0},sampleRate:48000,resolveAsset});
  close(left.channels[0][0],Math.cos(Math.PI/16),1e-6); close(left.channels[1][0],Math.sin(Math.PI/16),1e-6);
  const stereo=await Engine.render(await impulseProject(e=>e.pan({pan:0.5}),{assetId:'stereo'}),{range:{fromBeat:0,toBeat:1},tail:{seconds:0},sampleRate:48000,resolveAsset});
  const x=0.5*Math.PI/2; // stereo input, pan > 0: L = L·cos(x), R = R + L·sin(x)
  close(stereo.channels[0][0],1*Math.cos(x),1e-6); close(stereo.channels[1][0],0.5+1*Math.sin(x),1e-6);
  // Spatial emitters need the async factory; build the project by hand around it.
  const e=host(); const sample=await e.sample({id:'impulse',bytes:impulseBytes});
  const emitter=await e.spatialSource({rendering:'stereo',position:{x:0,y:0,z:-2}}); sample.connect(emitter).connect(e.output);
  const far=await e.spatialSource({rendering:'stereo',position:{x:1,y:0,z:0}}); const sample2=await e.sample({id:'impulse',bytes:impulseBytes}); sample2.connect(far).connect(e.output);
  e.transport.schedule(e.pattern({length:{beats:1},events:[{beat:0,notes:'sample',duration:{beats:1}}]}),sample,{loop:false});
  e.transport.schedule(e.pattern({length:{beats:1},events:[{beat:0.5,notes:'sample',duration:{beats:0.5}}]}),sample2,{loop:false});
  const {project}=e.exportProject(); await e.dispose();
  const spatial=await Engine.render(project,{range:{fromBeat:0,toBeat:1},tail:{seconds:0},sampleRate:48000,resolveAsset});
  close(spatial.channels[0][0],0.5*Math.cos(Math.PI/4),1e-6); close(spatial.channels[1][0],0.5*Math.sin(Math.PI/4),1e-6); // 2 m ahead: gain 0.5, centre
  close(spatial.channels[0][12000],0,1e-6); close(spatial.channels[1][12000],1,1e-6); // 1 m to the right: pan 1, gain 1
});

test('delay and reverb render their finite structures and match direct references',async()=>{
  const delayed=await Engine.render(await impulseProject(e=>e.delay({time:{seconds:0.01},feedback:0.5,taps:3,mix:1})),{range:{fromBeat:0,toBeat:1},tail:{seconds:0},sampleRate:48000,resolveAsset});
  const nonzero=[...delayed.channels[0].entries()].filter(([,v])=>v!==0);
  assert.deepEqual(nonzero,[[0,1],[480,0.5],[960,0.25],[1440,0.125]]);
  const reverbed=await Engine.render(await impulseProject(e=>e.reverb({decay:{seconds:0.1},mix:1})),{range:{fromBeat:0,toBeat:1},tail:{seconds:0},sampleRate:48000,resolveAsset});
  const ir=syntheticReverbResponse(0.1,48000);
  assert.equal(ir[0].length,4800);
  for(const channel of [0,1]) {
    const expected=new Float32Array(24000); expected.set(ir[channel]); expected[0]+=1; // dry impulse + wet response
    let error=0; for(let i=0;i<24000;i++) error=Math.max(error,Math.abs(reverbed.channels[channel][i]-expected[i]));
    assert.ok(error<=1e-5,`reverb channel ${channel} error ${error}`);
  }
});

test('instrument voices follow the envelope, stop after release, and honour the render range',async()=>{
  const preset={name:'test',layers:[{wave:'sine'}],envelope:{attack:0.01,decay:0.1,sustain:0.5,release:0.1},filter:{type:'lowpass',frequencyHz:20000},level:1};
  const e=host(); const keys=e.instrument(preset); keys.connect(e.output);
  e.transport.schedule(e.pattern({length:{beats:4},events:[{beat:0,notes:'A4',duration:{beats:1}},{beat:3.5,notes:'A4',duration:{beats:1}}]}),keys,{loop:true});
  const {project}=e.exportProject(); await e.dispose();
  const r=await Engine.render(project,{range:{fromBeat:0,toBeat:4},tail:{seconds:0.5},sampleRate:48000});
  const L=r.channels[0];
  close(maxAbs(L,Math.round(0.009*48000),Math.round(0.012*48000)),0.8,0.05);   // attack peak ≈ velocity 0.8
  close(maxAbs(L,Math.round(0.2*48000),Math.round(0.45*48000)),0.4,0.01);      // sustain 0.5 × 0.8
  assert.ok(maxAbs(L,Math.round(0.62*48000),Math.round(1.7*48000))<1e-9,'silence after the release until the beat-3.5 event');
  assert.ok(maxAbs(L,Math.round(1.76*48000),Math.round(2.3*48000))>0.3,'the beat-3.5 event and the looped beat-4 event sound');
  assert.ok(maxAbs(L,0,480)>0,'the voice starts within the first 10 ms of the output');
  // Rendering from beat 4: the beat-3.5 occurrence started before the range and is excluded, so the attack peak is a single voice.
  const later=await Engine.render(project,{range:{fromBeat:4,toBeat:8},tail:{seconds:0},sampleRate:48000});
  close(maxAbs(later.channels[0],Math.round(0.009*48000),Math.round(0.012*48000)),0.8,0.05);
  assert.ok(maxAbs(later.channels[0],Math.round(0.62*48000),Math.round(1.7*48000))<1e-9,'no event that started before the range leaks in');
});

test('kits, noise layers, pitch envelopes and layer filters render deterministically and finitely',async()=>{
  const e=host(); const drums=e.kit(softDrums); drums.connect(e.output);
  e.transport.schedule(e.pattern({length:{beats:4},events:[{beat:0,notes:'kick',duration:{beats:0.5}},{beat:1,notes:'snare',duration:{beats:0.5}},{beat:2,notes:['kick','hat'],duration:{beats:0.5}}]}),drums);
  const {project}=e.exportProject(); await e.dispose();
  const a=await Engine.render(project,{range:{fromBeat:0,toBeat:4},tail:{seconds:0.2},sampleRate:48000});
  const b=await Engine.render(project,{range:{fromBeat:0,toBeat:4},tail:{seconds:0.2},sampleRate:48000});
  assert.deepEqual([...a.channels[0]],[...b.channels[0]]);
  assert.ok(a.channels[0].every(Number.isFinite)); assert.ok(maxAbs(a.channels[0],0,24000)>0.05); assert.ok(maxAbs(a.channels[0],24000,48000)>0.01,'the snare noise burst is present');
  assert.ok(maxAbs(a.channels[0],a.frames-1000)<1e-6);
});
