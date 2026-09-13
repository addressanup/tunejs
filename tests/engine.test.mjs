import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Engine,TuneError} from '../dist/index.js';
import {BoundedChunks} from '../experiments/capture.js';
function host() {
  const events=[];
  const param=()=>({value:1,setValueAtTime(v,t){events.push(['set',v,t]);},linearRampToValueAtTime(v,t){events.push(['ramp',v,t]);},cancelScheduledValues(t){events.push(['cancel',t]);}});
  const node=()=>({connections:[],disconnects:0,connect(t){this.connections.push(t);},disconnect(){this.disconnects++;}});
  const context={state:'suspended',sampleRate:48000,currentTime:0,destination:node(),createGain:()=>({...node(),gain:param()}),createBiquadFilter:()=>({...node(),type:'lowpass',frequency:param(),Q:param()}),createOscillator:()=>({...node(),frequency:param(),type:'sine',start(){},stop(){}}),async resume(){this.state='running';},async suspend(){this.state='suspended';},async close(){this.state='closed';}};
  let creates=0;
  const adapter={hostLimits:{fanOut:true},name:'unit-test-double',createContext(){creates++;return context;},setEnded(node,fn){node.onEnded=fn;},hostTime(frame,rate){events.push(['hostTime',frame,rate]);return frame/rate;}};
  return {engine:new Engine({adapter}),adapter,context,events,creates:()=>creates};
}
const code=expected=>error=>error instanceof TuneError && error.code===expected;
const flat=error=>[error?.message??String(error),...(error instanceof AggregateError?error.errors.flatMap(flat):[]),...(error?.cause?flat(error.cause):[])];
test('construction and graph setup do not activate; concurrent starts share promise',async()=>{
 const h=host(),e=h.engine; const source=e.oscillator(),g=e.gain(),f=e.filter(); source.connect(g).connect(f).connect(e.output);
 assert.equal(h.creates(),0);assert.throws(()=>source.play(),code('NOT_RUNNING'));
 const a=e.start(),b=e.start();assert.equal(a,b);await a;assert.equal(h.creates(),1); await e.start();assert.equal(h.creates(),1);await e.dispose();
});
test('validates ownership, cycles, inputs, duplicate connections and disposed nodes',async()=>{
 const {engine:e}=host(),other=host().engine;const s=e.oscillator(),g=e.gain(),f=e.filter();s.connect(g);s.connect(g);assert.equal(s.targets.size,1);g.connect(f);
 assert.throws(()=>f.connect(g),code('INVALID_CONNECTION'));assert.throws(()=>g.connect(s),code('INVALID_CONNECTION'));assert.throws(()=>s.connect(other.output),code('CROSS_ENGINE'));assert.throws(()=>e.oscillator({frequencyHz:NaN}),code('INVALID_VALUE'));assert.throws(()=>g.gain.set(Infinity),code('INVALID_VALUE'));g.dispose();assert.equal(s.targets.size,0);assert.throws(()=>g.gain.set(1),code('DISPOSED')); await e.dispose();await other.dispose();
});
test('mid-ramp replacement holds interpolated value and removes the previous endpoint',async()=>{
 const h=host(),g=h.engine.gain({gain:0});await h.engine.start();g.gain.rampTo(1,{seconds:2});h.context.currentTime=1;assert.equal(g.gain.value,0.5);g.gain.rampTo(0,{seconds:1});assert.deepEqual(h.events.slice(-3),[['cancel',1],['set',0.5,1],['ramp',0,2]]);await h.engine.dispose();
});
test('100 ownership cycles dispose all graph/voice resources',async()=>{
 for(let i=0;i<100;i++){const {engine:e}=host();const s=e.oscillator();s.connect(e.gain()).connect(e.output);await e.start();const v=s.play();v.stop();v.stop();const a=e.dispose();assert.equal(a,e.dispose());await a;assert.equal(e.diagnostics.nodes,0);assert.equal(e.diagnostics.voices,0);await assert.rejects(e.start(),code('DISPOSED'));}
});
test('activation failure can retry; disposal during pending start cannot resurrect engine',async()=>{
 const h=host();h.context.resume=async()=>{throw new Error('denied');};await assert.rejects(h.engine.start(),code('ACTIVATION_FAILED'));assert.equal(h.engine.state,'failed');h.context.resume=async()=>{h.context.state='running';};await h.engine.start();await h.engine.dispose();
 const j=host();let done;j.context.resume=()=>new Promise(r=>done=r);const pending=j.engine.start();await j.engine.dispose();done();await assert.rejects(pending,code('DISPOSED'));assert.equal(j.engine.state,'disposed');
});
test('suspend stops existing voices; external suspension rejects play',async()=>{
 const h=host(),s=h.engine.oscillator();await h.engine.start();s.play();await h.engine.suspend();assert.equal(h.engine.diagnostics.voices,0);await h.engine.start();h.context.state='suspended';assert.throws(()=>s.play(),code('NOT_RUNNING'));await h.engine.dispose();
});
test('bounded PCM queue drops oldest and transfers exact discontinuity count',()=>{
 const q=new BoundedChunks(2048);for(let i=0;i<10;i++)q.push({sequence:i,startFrame:i*1024,channels:[new Float32Array(1024)],droppedFramesBefore:0});assert.equal(q.peak,2048);assert.equal(q.shift().droppedFramesBefore,8192);assert.equal(q.shift().droppedFramesBefore,0);assert.equal(q.frames,0);
});
test('ramps configured before activation are materialized on the host timeline',async()=>{
 const h=host(),g=h.engine.gain({gain:0});g.gain.rampTo(1,{seconds:2});await h.engine.start();assert.ok(h.events.some(event=>event[0]==='ramp'&&event[1]===1&&event[2]===2));await h.engine.dispose();
});
test('failed node construction retries materialization before output resumes',async()=>{
 const h=host();h.engine.filter();const create=h.context.createBiquadFilter;h.context.createBiquadFilter=()=>{throw new Error('allocation failed');};await assert.rejects(h.engine.start(),code('ACTIVATION_FAILED'));h.context.createBiquadFilter=create;await h.engine.start();assert.equal(h.engine.state,'running');assert.ok([...h.engine.nodes].every(node=>node.host));await h.engine.dispose();
});
test('engine dispose releases every node despite host disconnect failure',async()=>{
 const h=host(),e=h.engine;const s=e.oscillator(),g=e.gain();s.connect(g).connect(e.output);await e.start();
 const refs=[...e.nodes],oldHost=g.host;let disconnects=0;oldHost.disconnect=()=>{disconnects++;throw new Error('disconnect failed');};
 const d=e.dispose();await assert.rejects(d,error=>error instanceof TuneError&&error.code==='HOST_FAILURE'&&error.cause instanceof AggregateError);
 assert.equal(e.dispose(),d);assert.equal(e.diagnostics.nodes,0);assert.equal(e.diagnostics.voices,0);assert.equal(disconnects,1);
 for(const node of refs){assert.equal(node.host,undefined);assert.equal(node.targets.size,0);}
 assert.equal(h.context.state,'closed');assert.doesNotThrow(()=>g.dispose());assert.throws(()=>s.play(),code('DISPOSED'));await assert.rejects(e.start(),code('DISPOSED'));
});
test('direct node dispose reports every failed incoming edge and completes teardown',async()=>{
 const h=host(),e=h.engine;const s1=e.oscillator(),s2=e.oscillator(),m=e.gain();s1.connect(m);s2.connect(m);m.connect(e.output);await e.start();
 const e1=new Error('first source'),e2=new Error('second source'),e3=new Error('middle host');
 s1.host.disconnect=()=>{throw e1;};s2.host.disconnect=()=>{throw e2;};m.host.disconnect=()=>{throw e3;};
 assert.throws(()=>m.dispose(),error=>error.code==='HOST_FAILURE'&&error.cause instanceof AggregateError&&error.cause.errors.length===3&&error.cause.errors.includes(e1)&&error.cause.errors.includes(e2)&&error.cause.errors.includes(e3));
 assert.equal(s1.targets.has(m),false);assert.equal(s2.targets.has(m),false);assert.equal(m.host,undefined);assert.equal(e.nodes.has(m),false);
 s1.host.disconnect=()=>{};s2.host.disconnect=()=>{};await e.dispose();
});
test('source dispose drains voices and retains every cleanup cause',async()=>{
 const h=host(),e=h.engine;const s=e.oscillator();s.connect(e.output);await e.start();
 const createOsc=h.context.createOscillator,oscs=[];h.context.createOscillator=()=>{const o=createOsc();oscs.push(o);return o;};
 const v1=s.play(),v2=s.play();
 let failedDisconnects=0;oscs[0].stop=()=>{throw new Error('stop failed');};oscs[0].disconnect=()=>{failedDisconnects++;throw new Error('disconnect failed');};
 let stops=0,disconnects=0;oscs[1].stop=()=>{stops++;};oscs[1].disconnect=()=>{disconnects++;};
 assert.throws(()=>s.dispose(),error=>{if(error.code!=='HOST_FAILURE')return false;const all=flat(error);return all.includes('stop failed')&&all.includes('disconnect failed');});
 assert.equal(e.nodes.has(s),false);assert.equal(e.voices.size,0);assert.equal(v1.state,'ended');assert.equal(v2.state,'ended');assert.equal(stops,1);assert.equal(disconnects,1);assert.equal(failedDisconnects,1);
 assert.doesNotThrow(()=>s.dispose());await e.dispose();
});
test('ended callback unregistration failure still releases the voice',async()=>{
 const h=host(),e=h.engine;const s=e.oscillator();s.connect(e.output);await e.start();
 const createOsc=h.context.createOscillator,oscs=[];h.context.createOscillator=()=>{const o=createOsc();oscs.push(o);return o;};
 const v=s.play(),osc=oscs[0];let disconnects=0;osc.disconnect=()=>{disconnects++;};
 const setEnded=e.adapter.setEnded;e.adapter.setEnded=(node,fn)=>{if(fn===null)throw new Error('unbind failed');setEnded(node,fn);};
 assert.throws(()=>osc.onEnded(),error=>error.code==='HOST_FAILURE');
 assert.equal(v.state,'ended');assert.equal(e.voices.size,0);assert.equal(disconnects,1);assert.doesNotThrow(()=>osc.onEnded());
 e.adapter.setEnded=setEnded;await e.dispose();
});
test('ended callback registration failure leaves no voice and releases the oscillator',async()=>{
 const h=host(),e=h.engine;const s=e.oscillator();s.connect(e.output);await e.start();
 const createOsc=h.context.createOscillator;let disconnects=0;h.context.createOscillator=()=>{const o=createOsc();o.disconnect=()=>{disconnects++;};return o;};
 const setEnded=e.adapter.setEnded;e.adapter.setEnded=(node,fn)=>{if(fn)throw new Error('bind failed');setEnded(node,fn);};
 assert.throws(()=>s.play(),error=>error.code==='HOST_FAILURE');assert.equal(e.voices.size,0);assert.equal(disconnects,1);
 e.adapter.setEnded=setEnded;await e.dispose();
});
test('oscillator allocation failure reports host failure without registering voices',async()=>{
 const h=host(),e=h.engine;const s=e.oscillator();s.connect(e.output);await e.start();
 h.context.createOscillator=()=>{throw new Error('allocation failed');};
 assert.throws(()=>s.play(),error=>error.code==='HOST_FAILURE');assert.equal(e.voices.size,0);await e.dispose();
});
test('oscillator start failure retains both start and cleanup causes',async()=>{
 const h=host(),e=h.engine;const s=e.oscillator();s.connect(e.output);await e.start();
 const createOsc=h.context.createOscillator;h.context.createOscillator=()=>{const o=createOsc();o.start=()=>{throw new Error('start failed');};o.disconnect=()=>{throw new Error('disconnect failed');};return o;};
 assert.throws(()=>s.play(),error=>{if(error.code!=='HOST_FAILURE')return false;const all=flat(error);return all.includes('start failed')&&all.includes('disconnect failed');});
 assert.equal(e.voices.size,0);h.context.createOscillator=createOsc;await e.dispose();
});
test('context close failure reports once and repeated dispose returns the same rejection',async()=>{
 const h=host(),e=h.engine;const s=e.oscillator();s.connect(e.output);await e.start();s.play();
 let closes=0;h.context.close=async()=>{closes++;throw new Error('close failed');};
 const d=e.dispose();await assert.rejects(d,code('HOST_FAILURE'));assert.equal(e.dispose(),d);
 assert.equal(e.diagnostics.nodes,0);assert.equal(e.diagnostics.voices,0);assert.equal(closes,1);await assert.rejects(e.start(),code('DISPOSED'));
});
test('suspend drains every voice and still attempts host suspend when cleanup fails',async()=>{
 const h=host(),e=h.engine;const s=e.oscillator();s.connect(e.output);await e.start();
 const createOsc=h.context.createOscillator,oscs=[];h.context.createOscillator=()=>{const o=createOsc();oscs.push(o);return o;};
 s.play();s.play();oscs[0].stop=()=>{throw new Error('stop failed');};
 let suspends=0;h.context.suspend=async function(){suspends++;this.state='suspended';};
 await assert.rejects(e.suspend(),code('HOST_FAILURE'));assert.equal(suspends,1);assert.equal(e.voices.size,0);assert.equal(e.state,'suspended');await e.dispose();
});
test('host suspend rejection marks failure and permits reactivation',async()=>{
 const h=host(),e=h.engine;const s=e.oscillator();s.connect(e.output);await e.start();s.play();
 h.context.suspend=async()=>{throw new Error('suspend failed');};
 await assert.rejects(e.suspend(),code('HOST_FAILURE'));assert.equal(e.state,'failed');assert.equal(e.voices.size,0);
 h.context.suspend=async function(){this.state='suspended';};await e.start();assert.equal(e.state,'running');await e.dispose();
});
test('pending suspend deduplicates, blocks activation, and loses the dispose race',async()=>{
 const h=host(),e=h.engine;const s=e.oscillator();s.connect(e.output);await e.start();
 let resolveSuspend;h.context.suspend=()=>new Promise(r=>{resolveSuspend=r;});
 const a=e.suspend(),b=e.suspend();assert.equal(a,b);const pending=assert.rejects(a,code('DISPOSED'));
 await assert.rejects(e.start(),code('NOT_RUNNING'));assert.throws(()=>s.play(),code('NOT_RUNNING'));
 await e.dispose();resolveSuspend();await pending;assert.equal(e.state,'disposed');
});
test('natural completion releases the voice once and ignores repeated teardown',async()=>{
 const h=host(),e=h.engine;const s=e.oscillator();s.connect(e.output);await e.start();
 const createOsc=h.context.createOscillator,oscs=[];h.context.createOscillator=()=>{const o=createOsc();oscs.push(o);return o;};
 const v=s.play(),osc=oscs[0];let disconnects=0;osc.disconnect=()=>{disconnects++;};
 const ended=osc.onEnded;
 assert.equal(e.voices.size,1);ended();
 assert.equal(v.state,'ended');assert.equal(e.voices.size,0);assert.equal(disconnects,1);assert.equal(osc.onEnded,null);
 assert.doesNotThrow(()=>v.stop());assert.doesNotThrow(()=>v.dispose());assert.doesNotThrow(()=>ended());await e.dispose();
});
test('failed filter param binding cleans the host node and retries cleanly',async()=>{
 const h=host(),e=h.engine;const f=e.filter();const create=h.context.createBiquadFilter;let disconnects=0;
 h.context.createBiquadFilter=()=>({connect(){},disconnect(){disconnects++;},type:'lowpass',frequency:{value:1,setValueAtTime(){throw new Error('bind failed');},linearRampToValueAtTime(){},cancelScheduledValues(){}},Q:{value:1,setValueAtTime(){},linearRampToValueAtTime(){},cancelScheduledValues(){}}});
 await assert.rejects(e.start(),code('ACTIVATION_FAILED'));assert.equal(f.host,undefined);assert.equal(disconnects,1);
 h.context.createBiquadFilter=create;await e.start();assert.equal(e.state,'running');assert.ok(f.host);assert.ok(h.events.some(event=>event[0]==='set'&&event[1]===1200));await e.dispose();
});
test('node creation failure while running reports host failure and keeps the graph',async()=>{
 const h=host(),e=h.engine;await e.start();const before=e.diagnostics.nodes,create=h.context.createBiquadFilter;let disconnects=0;
 h.context.createBiquadFilter=()=>({connect(){},disconnect(){disconnects++;},type:'lowpass',frequency:{value:1,setValueAtTime(){throw new Error('bind failed');},linearRampToValueAtTime(){},cancelScheduledValues(){}},Q:{value:1,setValueAtTime(){},linearRampToValueAtTime(){},cancelScheduledValues(){}}});
 assert.throws(()=>e.filter(),error=>error.code==='HOST_FAILURE');assert.equal(e.diagnostics.nodes,before);assert.equal(disconnects,1);
 h.context.createBiquadFilter=create;const f=e.filter();assert.ok(f.host);await e.dispose();
});
test('resume is invoked synchronously and concurrent starts share one activation',async()=>{
 const h=host(),e=h.engine;let resumes=0;h.context.resume=function(){resumes++;this.state='running';return Promise.resolve();};
 const a=e.start(),b=e.start();assert.equal(resumes,1);assert.equal(a,b);await a;assert.equal(resumes,1);assert.equal(e.state,'running');await e.dispose();
});
test('voices schedule host start and stop on adapter frame times',async()=>{
 const h=host(),e=h.engine;const s=e.oscillator();s.connect(e.output);await e.start();
 h.context.currentTime=0.5;const v=s.play({duration:{seconds:2}});
 assert.equal(e.currentFrame,24000);
 assert.ok(h.events.some(event=>event[0]==='hostTime'&&event[1]===24000&&event[2]===48000));
 assert.ok(h.events.some(event=>event[0]==='hostTime'&&event[1]===120000&&event[2]===48000));
 h.context.currentTime=1.0000001;v.stop();
 assert.ok(h.events.some(event=>event[0]==='hostTime'&&event[1]===48000&&event[2]===48000));
 await e.dispose();
});
test('sampleRate is null and currentFrame 0 before activation; frame conversion rejects non-integers',async()=>{
 const h=host(),e=h.engine;
 assert.equal(e.sampleRate,null);assert.equal(e.currentFrame,0);
 await e.start();assert.equal(e.sampleRate,48000);
 assert.throws(()=>e.hostTimeAt(1.5),code('INVALID_VALUE'));
 assert.throws(()=>e.hostTimeAt(-1),code('INVALID_VALUE'));
 await e.dispose();
});
test('adapter hostTime failure during play surfaces HOST_FAILURE and releases the voice',async()=>{
 const h=host(),e=h.engine;const s=e.oscillator();s.connect(e.output);await e.start();
 const createOsc=h.context.createOscillator;let disconnects=0;h.context.createOscillator=()=>{const o=createOsc();o.disconnect=()=>{disconnects++;};return o;};
 const hostTime=e.adapter.hostTime;e.adapter.hostTime=()=>{throw new Error('hostTime failed');};
 assert.throws(()=>s.play(),code('HOST_FAILURE'));
 assert.equal(e.voices.size,0);assert.equal(disconnects,1);
 e.adapter.hostTime=hostTime;await e.dispose();
});
test('start wires sources through a TuneJS-owned master gain into the destination',async()=>{
 const h=host(),e=h.engine;const s1=e.oscillator(),s2=e.oscillator();s1.connect(e.output);s2.connect(e.output);await e.start();
 const master=e.output.host;
 assert.notEqual(master,h.context.destination);
 assert.deepEqual(master.connections,[h.context.destination]);
 assert.deepEqual(h.events.find(e=>e[0]==='set'),['set',1,0]);
 const s1host=s1.host.connections,s2host=s2.host.connections;
 assert.ok(s1host.includes(master)&&s2host.includes(master));
 assert.equal(master.connections.length,1);
 await e.dispose();
});
test('master gain creation failure rejects ACTIVATION_FAILED and a retry succeeds',async()=>{
 const h=host(),e=h.engine;const create=h.context.createGain;let once=false;
 h.context.createGain=()=>{if(!once){once=true;throw new Error('boom');}return create();};
 await assert.rejects(e.start(),code('ACTIVATION_FAILED'));
 assert.equal(e.output.host,undefined);
 await e.start();assert.ok(e.output.host);assert.deepEqual(e.output.host.connections,[h.context.destination]);
 await e.dispose();
});
test('dispose disconnects the master gain once and closes the context',async()=>{
 const h=host(),e=h.engine;const s=e.oscillator();s.connect(e.output);await e.start();
 const master=e.output.host;await e.dispose();
 assert.equal(master.disconnects,1);assert.equal(h.context.state,'closed');
});
test('host fan-out limit rejects a second outgoing edge and disables parallel effects',async()=>{
 const h=host(),e=h.engine;
 assert.equal(e.capabilities.fanOut,true);assert.equal(e.capabilities.delay,true);assert.equal(e.capabilities.reverb,true);
 const limited=host();
 const e2=new Engine({adapter:{...limited.adapter,hostLimits:{fanOut:false}}});
 assert.equal(e2.capabilities.fanOut,false);assert.equal(e2.capabilities.delay,false);assert.equal(e2.capabilities.reverb,false);
 const s=e2.oscillator(),g1=e2.gain(),g2=e2.gain();
 s.connect(g1);s.connect(g1); // idempotent
 assert.throws(()=>s.connect(g2),code('UNSUPPORTED'));
 s.disconnect();s.connect(g2);
 const before=e2.diagnostics.nodes;
 assert.throws(()=>e2.delay(),code('UNSUPPORTED'));
 assert.throws(()=>e2.reverb(),code('UNSUPPORTED'));
 assert.equal(e2.diagnostics.nodes,before);
 await e.dispose();await e2.dispose();
});

// TuneJS DSP path: a fake HostDsp over the fanOut:false adapter. Nodes record calls.
function dspHost(){
  const h=host();
  const created=[];
  const mknode=()=>({connections:[],disconnects:0,connect(t){this.connections.push(t);},disconnect(){this.disconnects++;}});
  const cache=new WeakMap();
  const dsp={
    loads:0,
    load(context){let p=cache.get(context);if(!p){this.loads++;p=Promise.resolve().then(()=>{});cache.set(context,p);}return p;}, // cached per context, resolves on a later microtask
    createDelay(context,spec){const n={...mknode(),kind:'delay',spec,closes:0,mix:{value:0,calls:[],setValueAtTime(v,t){this.calls.push(['set',v,t]);this.value=v;},linearRampToValueAtTime(v,t){this.calls.push(['ramp',v,t]);this.value=v;},cancelScheduledValues(t){this.calls.push(['cancel',t]);}},close(){this.closes++;}};created.push(n);return n;},
    createConvolver(context,spec){const n={...mknode(),kind:'convolver',spec,closes:0,mix:{value:0,calls:[],setValueAtTime(v,t){this.calls.push(['set',v,t]);this.value=v;},linearRampToValueAtTime(v,t){this.calls.push(['ramp',v,t]);this.value=v;},cancelScheduledValues(t){this.calls.push(['cancel',t]);}},close(){this.closes++;}};created.push(n);return n;},
  };
  const engine=new Engine({adapter:{...h.adapter,hostLimits:{fanOut:false},dsp}});
  return {engine,h,dsp,created};
}

test('dsp path enables effects on a fan-out-limited host and prepares once after start',async()=>{
  const {engine:e,dsp,created}=dspHost();
  assert.equal(e.capabilities.delay,true);assert.equal(e.capabilities.reverb,true);
  const s=e.oscillator();const d=e.delay({time:{seconds:0.01},feedback:0.5,taps:3});
  const r=e.reverb({decay:{seconds:0.5}});
  s.connect(d).connect(r).connect(e.output);
  assert.equal(created.length,0,'nothing prepared before start');
  await e.start();
  assert.equal(dsp.loads,1);
  assert.equal(created.length,2);
  assert.equal(created[0].kind,'delay');assert.equal(created[1].kind,'convolver');
  assert.equal(created[0].spec.delayFrames,480);assert.equal(created[0].spec.taps,3);
  assert.equal(created[1].spec.response.length,2);
  assert.equal(d.input,created[0]);assert.equal(d.host,created[0]);
  assert.ok(s.host.connections.includes(created[0]),'source lands on the DSP node');
  assert.ok(created[0].connections.includes(created[1]),'delay feeds reverb');
  assert.ok(created[1].connections.includes(e.output.host),'reverb feeds the master gain');
  // suspend + restart: load promise is cached per context; no second create.
  await e.suspend();await e.start();
  assert.equal(dsp.loads,1,'load cached per context');
  assert.equal(created.length,2,'nodes still prepared once');
  // dispose closes each DSP node once and disconnects it.
  d.dispose();
  assert.equal(created[0].closes,1);assert.ok(created[0].disconnects>=1);
  await e.dispose();
  assert.equal(created[1].closes,1);assert.ok(created[1].disconnects>=1);
  assert.equal(e.diagnostics.nodes,0);
});

test('a delay created while start() awaits the DSP module is prepared exactly once',async()=>{
  const {engine:e,created}=dspHost();
  const pending=e.start();
  const d=e.delay();e.oscillator().connect(d).connect(e.output);
  await pending;
  assert.equal(created.length,1,'prepared exactly once by the activation chain');
  await e.dispose();
});

test('without a dsp adapter the fan-out-limited host still rejects effects',async()=>{
  const limited=host();
  const e=new Engine({adapter:{...limited.adapter,hostLimits:{fanOut:false}}});
  assert.equal(e.capabilities.delay,false);assert.equal(e.capabilities.reverb,false);
  assert.throws(()=>e.delay(),code('UNSUPPORTED'));
  assert.throws(()=>e.reverb(),code('UNSUPPORTED'));
  await e.dispose();
});
