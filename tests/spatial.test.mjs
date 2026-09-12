import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Engine,TuneError,stereoRender} from '../dist/index.js';
import {softKeys} from '../dist/presets.js';
const code=expected=>error=>error instanceof TuneError && error.code===expected;
const close=(a,b,tol=1e-9)=>Math.abs(a-b)<=tol;
const rejectCode=expected=>error=>error instanceof TuneError && error.code===expected;

const listener={position:{x:0,y:0,z:0},forward:{x:0,y:0,z:-1},up:{x:0,y:1,z:0}};
const at=(position,overrides={})=>({position,direction:null,distanceModel:{reference:1,max:50,rolloff:1},cone:{innerDegrees:360,outerDegrees:360,outerGain:0},...overrides});

function host() {
  const gains=[],panners=[];
  const mkparam=events=>({value:1,setValueAtTime(v,t){events.push(['set',v,t]);},linearRampToValueAtTime(v,t){events.push(['ramp',v,t]);},cancelScheduledValues(t){events.push(['cancel',t]);}});
  const mknode=()=>({disconnects:0,connections:[],connect(target){this.connections.push(target);},disconnect(){this.disconnects++;}});
  const context={state:'suspended',sampleRate:48000,currentTime:0,destination:mknode(),
    createGain(){const events=[];const g={...mknode(),events,gain:mkparam(events)};gains.push(g);return g;},
    createBiquadFilter(){const events=[];return {...mknode(),events,type:'lowpass',frequency:mkparam(events),Q:mkparam(events)};},
    createOscillator(){const events=[];return {...mknode(),events,type:'sine',frequency:mkparam(events),start(){},stop(){}};},
    createBuffer(c,f,r){return {sampleRate:r,length:f,numberOfChannels:c,copyToChannel(){}};},
    createBufferSource(){const events=[];return {...mknode(),events,buffer:null,loop:false,playbackRate:mkparam(events),start(){},stop(){}};},
    createStereoPanner(){const events=[];const p={...mknode(),events,pan:mkparam(events)};panners.push(p);return p;},
    async resume(){this.state='running';},async suspend(){this.state='suspended';},async close(){this.state='closed';}};
  const adapter={hostLimits:{fanOut:true},name:'spatial-test-double',createContext(){return context;},setEnded(node,fn){node.onEnded=fn;},hostTime(frame,rate){return frame/rate;}};
  return {engine:new Engine({adapter}),context,gains,panners,adapter};
}

test('stereoRender pan and azimuth table at the default listener',()=>{
  const cases=[
    [{x:0,y:0,z:-1},0,0],[{x:1,y:0,z:-1},0.5,45],[{x:1,y:0,z:0},1,90],[{x:-1,y:0,z:0},-1,-90],
    [{x:0,y:0,z:1},0,0],[{x:1,y:0,z:1},0.5,45],[{x:-1,y:0,z:1},-0.5,-45],[{x:0,y:0,z:5},0,0],[{x:0,y:5,z:0},0,0],
  ];
  for(const [position,pan,azimuth] of cases){
    const r=stereoRender(listener,at(position));
    assert.ok(close(r.pan,pan),`${JSON.stringify(position)} pan ${r.pan} !== ${pan}`);
    assert.ok(close(r.azimuthDegrees,azimuth),`${JSON.stringify(position)} azimuth ${r.azimuthDegrees} !== ${azimuth}`);
    assert.ok(Number.isFinite(r.gain));
  }
  const coincident=stereoRender(listener,at({x:0,y:0,z:0}));
  assert.ok(close(coincident.pan,0)&&close(coincident.gain,1)&&close(coincident.distance,0));
});

test('stereoRender distance uses the Web Audio inverse model',()=>{
  const r=d=>stereoRender(listener,at({x:0,y:0,z:-d})).gain;
  assert.ok(close(r(1),1));
  assert.ok(close(r(3),1/3),'inverse model: 1/(1+(3-1))');
  assert.ok(close(r(2),0.5));
  assert.ok(close(r(0.2),1),'clamped to reference');
  assert.ok(close(stereoRender(listener,at({x:0,y:0,z:-100},{distanceModel:{reference:1,max:50,rolloff:1}})).gain,1/50),'clamped to max');
});

test('stereoRender cone attenuates outside the inner angle',()=>{
  const cone={innerDegrees:60,outerDegrees:120,outerGain:0.1};
  const direction={x:0,y:0,z:1}; // source faces +Z; rolloff 0 isolates the cone term
  const flat={reference:1,max:50,rolloff:0};
  const source=position=>stereoRender(listener,at(position,{direction,cone,distanceModel:flat}));
  assert.ok(close(source({x:0,y:0,z:-3}).gain,1),'listener ahead of the direction is inside the cone');
  const s45=Math.SQRT1_2;
  assert.ok(close(source({x:s45,y:0,z:-s45}).gain,0.55),'45° is the linear midpoint between half-angles 30 and 60');
  assert.ok(close(source({x:0,y:0,z:3}).gain,0.1),'behind the direction is outside the cone');
  assert.ok(close(stereoRender(listener,at({x:0,y:0,z:3},{direction,cone:{innerDegrees:60,outerDegrees:360,outerGain:0.1},distanceModel:flat})).gain,1),'outerDegrees 360 disables the cone');
});

test('listener setPose re-orthogonalizes and re-evaluates every emitter',async()=>{
  const h=host(),e=h.engine;await e.start();
  const s1=await e.spatialSource({rendering:'stereo',position:{x:1,y:0,z:0}});
  const s2=await e.spatialSource({rendering:'stereo',position:{x:0,y:0,z:-1}});
  assert.throws(()=>e.listener.setPose({forward:{x:1,y:0,z:0},up:{x:2,y:0,z:0}}),code('INVALID_VALUE'));
  assert.throws(()=>e.listener.setPose({position:{x:NaN,y:0,z:0}}),code('INVALID_VALUE'));
  e.listener.setPose({forward:{x:1,y:0,z:0}},{seconds:0});
  // looking down +X: source at (1,0,0) is ahead → pan 0; source at (0,0,-1) is left → pan -1
  assert.ok(close(h.panners[0].events.at(-1)[1],0),`s1 pan ${JSON.stringify(h.panners[0].events)}`);
  assert.ok(close(h.panners[1].events.at(-1)[1],-1),`s2 pan ${JSON.stringify(h.panners[1].events)}`);
  e.listener.setPose({forward:{x:0,y:0,z:-1},up:{x:0,y:1,z:0}},{seconds:0});
  assert.ok(close(h.panners[0].events.at(-1)[1],1));
  assert.ok(close(h.panners[1].events.at(-1)[1],0));
  await e.dispose();
});

test('spatial source wires distance gain then panner into a single chain',async()=>{
  const h=host(),e=h.engine;await e.start();
  const keys=e.instrument(softKeys);
  const emitter=await e.spatialSource({rendering:'stereo',position:{x:1,y:0,z:-1}});
  keys.connect(emitter);emitter.connect(e.output);
  const distanceGain=emitter.distanceGain,panner=emitter.panner;
  assert.ok(distanceGain&&panner,'host nodes created');
  assert.equal(emitter.input,distanceGain,'mono input lands on the distance gain');
  assert.ok(h.gains[1].connections.includes(distanceGain),'instrument level gain feeds the distance gain');
  assert.ok(distanceGain.connections.includes(panner),'gain feeds the panner');
  assert.ok(panner.connections.includes(h.gains[0]),'panner feeds the master gain via output');
  assert.ok(panner.events.length>0,'pan bound');
  const beforePan=panner.events.length,beforeGain=distanceGain.events.length;
  emitter.setPosition({x:-1,y:0,z:-1},{seconds:0.02});
  assert.deepEqual(panner.events.slice(beforePan).map(e=>e[0]),['cancel','set','ramp']);
  assert.deepEqual(distanceGain.events.slice(beforeGain).map(e=>e[0]),['cancel','set','ramp']);
  // fan-out-limited host still supports the single chain
  const h2=host();h2.adapter.hostLimits={fanOut:false};const e2=new Engine({adapter:h2.adapter});await e2.start();
  const limited=await e2.spatialSource({rendering:'stereo'});
  e2.instrument(softKeys).connect(limited).connect(e2.output);
  await e.dispose();await e2.dispose();
});

test('spatialSource validates, rejects binaural, and disposes cleanly',async()=>{
  const h=host(),e=h.engine;
  await assert.rejects(e.spatialSource({rendering:'binaural'}),rejectCode('UNSUPPORTED'));
  await assert.rejects(e.spatialSource({rendering:'widedom'}),rejectCode('INVALID_VALUE'));
  await assert.rejects(e.spatialSource({rendering:'stereo',distance:{reference:0}}),rejectCode('INVALID_VALUE'));
  await assert.rejects(e.spatialSource({rendering:'stereo',distance:{reference:10,max:5}}),rejectCode('INVALID_VALUE'));
  await assert.rejects(e.spatialSource({rendering:'stereo',cone:{innerDegrees:200,outerDegrees:100}}),rejectCode('INVALID_VALUE'));
  await assert.rejects(e.spatialSource({rendering:'stereo',position:{x:1,y:0,z:NaN}}),rejectCode('INVALID_VALUE'));
  assert.equal(e.diagnostics.nodes,1,'only the output node exists');
  await e.start();
  const emitter=await e.spatialSource({rendering:'stereo'});
  emitter.dispose();
  for(let i=0;i<100;i++){const s=await e.spatialSource({rendering:'stereo'});s.dispose();}
  assert.equal(e.diagnostics.nodes,1,'only the output node remains');
  assert.equal(e.spatial.size,0);
  await e.dispose();
  assert.equal(e.diagnostics.nodes,0);
});
