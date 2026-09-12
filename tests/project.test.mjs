import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Engine,TuneError,fnv1a64Float32,encodeWav} from '../dist/index.js';
import {softKeys,softDrums} from '../dist/presets.js';
const code=expected=>error=>error instanceof TuneError && error.code===expected;
const close=(a,b)=>Math.abs(a-b)<=1e-9;

function host({failOnGain=Infinity}={}) {
  const gains=[],panners=[],sources=[],created={gains:0};
  const mkparam=events=>({value:1,setValueAtTime(v,t){events.push(['set',v,t]);},linearRampToValueAtTime(v,t){events.push(['ramp',v,t]);},cancelScheduledValues(t){events.push(['cancel',t]);}});
  const mknode=()=>({disconnects:0,targets:[],connect(t){this.targets.push(t);},disconnect(){this.disconnects++;this.targets=[];}});
  const context={state:'suspended',sampleRate:48000,currentTime:0,destination:mknode(),
    createGain(){if(++created.gains>=failOnGain) throw new Error('gain budget');const events=[];const g={...mknode(),events,gain:mkparam(events)};gains.push(g);return g;},
    createBiquadFilter(){const events=[];return {...mknode(),events,type:'lowpass',frequency:mkparam(events),Q:mkparam(events)};},
    createOscillator(){const events=[];return {...mknode(),events,type:'sine',frequency:mkparam(events),starts:[],start(...a){this.starts.push(a);},stop(){}};},
    createBuffer(c,f,r){const data=Array.from({length:c},()=>new Float32Array(f));return {sampleRate:r,length:f,numberOfChannels:c,copyToChannel(src,i){data[i].set(src);},getChannelData:i=>data[i]};},
    createBufferSource(){const events=[];const s={...mknode(),events,buffer:null,loop:false,playbackRate:mkparam(events),starts:[],start(...a){this.starts.push(a);},stop(){}};sources.push(s);return s;},
    createStereoPanner(){const events=[];const p={...mknode(),events,pan:mkparam(events)};panners.push(p);return p;},
    createDelay(maxDelay){const events=[];return {...mknode(),events,maxDelay,delayTime:mkparam(events)};},
    createConvolver(){return {...mknode(),buffer:null,normalize:true};},
    async resume(){this.state='running';},async suspend(){this.state='suspended';},async close(){this.state='closed';}};
  const adapter={hostLimits:{fanOut:true},name:'project-test-double',createContext(){return context;},setEnded(node,fn){node.onEnded=fn;},hostTime:(frame,rate)=>frame/rate,
    tapping:{async createTap(){ const tap={...mknode(),inFlight:0,dropped:0,sequence:0,nextFrame:0,closed:false,callback:null,
      onChunk(cb){this.callback=cb;},acknowledge(){this.inFlight=Math.max(0,this.inFlight-1);},
      close(){this.closed=true;this.callback=null;},emit(){}}; return tap; }}};
  return {engine:new Engine({adapter}),context,gains,sources,adapter};
}
const wav=()=>encodeWav([Float32Array.from([0,0.5,-0.5,0.25]),Float32Array.from([0,0.1,-0.1,0.2])],48000).bytes;

test('project export/import round trips nodes, params, parts, assets and listener',async()=>{
  const h=host(),e=h.engine;await e.start();
  const osc=e.oscillator({frequencyHz:220,wave:'square'});
  const gain=e.gain({gain:0.4});
  const filter=e.filter({type:'highpass',frequencyHz:800});
  const keys=e.instrument(softKeys,{maxVoices:8});
  keys.setEnvelope({release:0.7});
  keys.level.rampTo(0.3,{seconds:1});h.context.currentTime=2; // settle the ramp
  const drums=e.kit(softDrums);
  const clip=await e.sample({id:'take-1',bytes:wav()});
  const bus=e.bus({gainDb:-6});
  const pan=e.pan({pan:0.25});
  const delay=e.delay({time:{seconds:0.3},feedback:0.5,taps:6,mix:0.4});
  const reverb=e.reverb({decay:{seconds:1.5},mix:0.2});
  const emitter=await e.spatialSource({rendering:'stereo',position:{x:1,y:0,z:-2},cone:{innerDegrees:60,outerDegrees:120,outerGain:0.2}});
  keys.connect(emitter).connect(bus).connect(pan).connect(delay).connect(reverb).connect(e.output);
  drums.connect(e.output);clip.connect(e.output);osc.connect(gain).connect(filter).connect(e.output);
  const pA=e.pattern({length:{beats:4},events:[{beat:0,notes:'C4',duration:{beats:1}}]});
  const pB=e.pattern({length:{beats:2},events:[{beat:0,notes:'sample',duration:{beats:1},region:{start:0.001}}]});
  e.transport.schedule(pA,keys);
  e.transport.schedule(pB,clip,{at:{beats:4},loop:false});
  e.listener.setPose({position:{x:0.5,y:0,z:0},forward:{x:0,y:0,z:-1}},{seconds:0});
  e.transport.setMeter({beatsPerBar:3});
  e.transport.bpm.set(96);
  const first=e.exportProject();
  assert.deepEqual(first.warnings,[]);
  assert.equal(first.project.format,'tunejs-project');
  assert.equal(first.project.version,1);
  assert.equal(first.project.transport.bpm,96);assert.equal(first.project.transport.beatsPerBar,3);
  const instrumentDef=first.project.nodes.find(n=>n.type==='instrument');
  assert.equal(instrumentDef.maxVoices,8);assert.equal(instrumentDef.envelope.release,0.7);assert.ok(close(instrumentDef.params.level,0.3));
  const spatialDef=first.project.nodes.find(n=>n.type==='spatial');
  assert.equal(spatialDef.renderer,'tunejs-stereo-v1');assert.equal(spatialDef.cone.outerGain,0.2);
  assert.match(first.project.assets[0].integrity,/^fnv1a64:[0-9a-f]{16}$/);
  assert.equal(first.project.assets[0].id,'take-1');assert.equal(first.project.assets[0].frames,4);
  assert.equal(first.project.parts.length,2);assert.equal(first.project.parts[1].startBeat,4);assert.equal(first.project.parts[1].loop,false);
  // Import into a fresh engine: identical export on the other side.
  const h2=host(),e2=h2.engine;
  const result=await e2.importProject(first.project,{resolveAsset:async id=>{assert.equal(id,'take-1');return wav();}});
  assert.equal(result.nodes.get(instrumentDef.id).kind,'source');
  const second=e2.exportProject();
  assert.deepEqual(second.project,first.project,'round-tripped projects are identical');
  await e2.start();
  e2.transport.start();e2.transport.tick();
  assert.ok(e2.transport.diagnostics.scheduledEvents>0,'imported parts schedule events');
  await e.dispose();await e2.dispose();
});

test('export rejects live capture state and warns on pending transport changes',async()=>{
  const h=host(),e=h.engine;
  const keys=e.instrument(softKeys);keys.connect(e.output);await e.start();
  const tap=await e.tap({source:keys});
  assert.throws(()=>e.exportProject(),code('PROJECT_INVALID'));
  tap.cancel();
  assert.doesNotThrow(()=>e.exportProject());
  e.transport.start();e.transport.bpm.set(60);
  const out=e.exportProject();
  assert.ok(out.warnings.some(w=>/pending/i.test(w)),'pending tempo warns');
  assert.ok(out.warnings.some(w=>/running/i.test(w)),'running transport warns');
  await e.dispose();
});

test('import validation collects every problem and creates nothing',async()=>{
  const h=host(),e=h.engine;
  const bad={format:'wrong',version:2,
    transport:{bpm:96,beatsPerBar:4},listener:{position:{x:0,y:0,z:0},forward:{x:0,y:0,z:-1},up:{x:0,y:1,z:0}},
    nodes:[{id:'n1',type:'gain',params:{gain:1}},{id:'n1',type:'gain',params:{gain:1}},{id:'n2',type:'sample',assetId:'missing'},{id:'n3',type:'gain',params:{gain:1}}],
    connections:[{from:'n1',to:'n9'},{from:'n1',to:'n3'},{from:'n3',to:'n1'}],
    patterns:[{id:'p1',length:{beats:4},events:[]}],parts:[{patternId:'p9',targetId:'n1',startBeat:0,loop:true}],
    assets:[]};
  const h2=host(),e2=h2.engine;await e2.start();e2.transport.start();
  await assert.rejects(e2.importProject(bad),error=>{
    assert.ok(error instanceof TuneError&&error.code==='PROJECT_INVALID');
    const m=error.message;
    for(const token of ['format','version','duplicate','unknown','pattern','manifest','cycle','stopped']) assert.ok(m.includes(token),`missing '${token}' in: ${m}`);
    return true;
  });
  assert.equal(e2.diagnostics.nodes,1,'nothing was created');
  await e.dispose();await e2.dispose();
});

test('asset manifest mismatches and missing resolvers fail before building',async()=>{
  const h=host(),e=h.engine;await e.start();
  const clip=await e.sample({id:'take-1',bytes:wav()});
  const {project}=e.exportProject();
  const h2=host(),e2=h2.engine;
  await assert.rejects(e2.importProject(project),code('PROJECT_INVALID'),'no resolver');
  await assert.rejects(e2.importProject(project,{resolveAsset:async()=>{throw new Error('gone');}}),code('ASSET_FAILED'));
  const tampered=JSON.parse(JSON.stringify(project));tampered.assets[0].frames+=1;
  await assert.rejects(e2.importProject(tampered,{resolveAsset:async()=>wav()}),error=>{
    assert.ok(error instanceof TuneError&&error.code==='ASSET_FAILED'&&error.message.includes('take-1'));return true;});
  assert.equal(e2.diagnostics.nodes,1);
  await e.dispose();await e2.dispose();
});

test('import failure during build leaves the existing graph untouched',async()=>{
  const h=host({failOnGain:4}),e=h.engine;await e.start();
  const keys=e.instrument(softKeys);keys.connect(e.output);
  const before=e.diagnostics.nodes;
  const h2=host(),donor=h2.engine;await donor.start();
  donor.gain();donor.gain(); // n1, n2
  const {project}=donor.exportProject();
  // Import needs a 3rd createGain in e (master + pre-existing gains consumed the budget) → mid-build failure
  await assert.rejects(e.importProject(project),code('HOST_FAILURE'));
  assert.equal(e.diagnostics.nodes,before,'created nodes rolled back');
  assert.equal(e.transport.parts.size,0);
  await e.dispose();await h2.engine.dispose();
});

const longWav=()=>encodeWav([Float32Array.from({length:48000},(_,i)=>Math.sin(i/40)),Float32Array.from({length:48000},(_,i)=>Math.cos(i/40))],48000).bytes;

test('sample targets schedule with regions',async()=>{
  const h=host(),e=h.engine;await e.start();
  const clip=await e.sample({id:'take-2',bytes:longWav()});
  clip.connect(e.output);
  assert.throws(()=>e.pattern({length:{beats:4},events:[{beat:0,notes:'x',duration:{beats:1},region:{start:0.1,end:0.05}}]}),code('INVALID_VALUE'));
  assert.throws(()=>e.pattern({length:{beats:4},events:[{beat:0,notes:'x',duration:{beats:1},region:{start:-0.1}}]}),code('INVALID_VALUE'));
  const pattern=e.pattern({length:{beats:4},events:[{beat:0,notes:'sample',duration:{beats:1},region:{start:0.001,end:0.5}}]});
  e.transport.schedule(pattern,clip);
  e.transport.start();e.transport.tick();
  assert.ok(e.voices.size>0,'a sample voice was scheduled');
  const scheduled=h.sources.at(-1);
  assert.ok(scheduled.starts.length===1,'the sample source was started');
  const [atTime,offset,span]=scheduled.starts[0];
  assert.ok(atTime>h.context.currentTime,'scheduled at a future host time');
  assert.ok(close(offset,0.001)&&close(span,0.5-0.001),'region start/end applied');
  assert.equal(e.transport.diagnostics.errors,0);
  await e.dispose();
});

test('fnv1a64Float32 matches the known vector and channel order matters',()=>{
  assert.equal(fnv1a64Float32([Float32Array.from([0])]),'fnv1a64:4d25767f9dce13f5');
  const a=Float32Array.from([0.5]),b=Float32Array.from([0.25]);
  assert.notEqual(fnv1a64Float32([a,b]),fnv1a64Float32([b,a]));
  assert.equal(fnv1a64Float32([a,b]),fnv1a64Float32([Float32Array.from(a),Float32Array.from(b)]));
});
