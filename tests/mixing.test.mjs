import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Engine,TuneError,syntheticReverbResponse} from '../dist/index.js';
const code=expected=>error=>error instanceof TuneError && error.code===expected;
const close=(a,b)=>Math.abs(a-b)<=1e-9;

// Per-node event capture; every host node records connect() targets so effect input wiring is assertable.
function host() {
  const hostCalls=[],gains=[],panners=[],delays=[],convolvers=[],buffers=[];
  const mkparam=events=>({value:1,setValueAtTime(v,t){events.push(['set',v,t]);},linearRampToValueAtTime(v,t){events.push(['ramp',v,t]);},cancelScheduledValues(t){events.push(['cancel',t]);}});
  const mknode=()=>({disconnects:0,connections:[],connect(target){this.connections.push(target);},disconnect(){this.disconnects++;}});
  const context={state:'suspended',sampleRate:48000,currentTime:0,destination:mknode(),
    createGain(){const events=[];const g={...mknode(),events,gain:mkparam(events)};gains.push(g);return g;},
    createBiquadFilter(){const events=[];return {...mknode(),events,type:'lowpass',frequency:mkparam(events),Q:mkparam(events)};},
    createOscillator(){const events=[];return {...mknode(),events,type:'sine',frequency:mkparam(events),start(){},stop(){}};},
    createBuffer(channels,frames,rate){const b={sampleRate:rate,length:frames,numberOfChannels:channels,copies:[],copyToChannel(src,i){this.copies.push([i,src.length]);}};buffers.push(b);return b;},
    createBufferSource(){const events=[];return {...mknode(),events,buffer:null,loop:false,loopStart:0,loopEnd:0,playbackRate:mkparam(events),starts:[],stops:[],start(...a){this.starts.push(a);},stop(t){this.stops.push(t);}};},
    createStereoPanner(){const events=[];const p={...mknode(),events,pan:mkparam(events)};panners.push(p);return p;},
    createDelay(maxDelay){const events=[];const d={...mknode(),events,maxDelay,delayTime:mkparam(events)};delays.push(d);return d;},
    createConvolver(){const c={...mknode(),buffer:null,normalize:true};convolvers.push(c);return c;},
    async resume(){this.state='running';},async suspend(){this.state='suspended';},async close(){this.state='closed';}};
  const adapter={name:'mixing-test-double',createContext(){return context;},setEnded(node,fn){node.onEnded=fn;},hostTime(frame,rate){hostCalls.push([frame,rate]);return frame/rate;}};
  return {engine:new Engine({adapter}),context,gains,panners,delays,convolvers,buffers,hostCalls};
}

test('bus maps dB onto a linear host gain and reads ramps back in dB',async()=>{
  const h=host(),e=h.engine;
  assert.throws(()=>e.bus({gainDb:-61}),code('INVALID_VALUE'));
  assert.throws(()=>e.bus({gainDb:13}),code('INVALID_VALUE'));
  const bus=e.bus({gainDb:-6});
  const plain=e.bus();
  bus.connect(e.output);plain.connect(e.output);
  await e.start();
  assert.deepEqual(bus.gainDb.value,-6);
  const busGain=h.gains[0],plainGain=h.gains[1];
  assert.deepEqual(busGain.events,[['set',10**(-6/20),0]]);
  assert.deepEqual(plainGain.events,[['set',1,0]]);
  bus.gainDb.rampTo(-12,{seconds:1});
  assert.deepEqual(busGain.events.slice(1),[['cancel',0],['set',10**(-6/20),0],['ramp',10**(-12/20),1]]);
  h.context.currentTime=0.5;
  assert.ok(close(bus.gainDb.value,20*Math.log10((10**(-6/20)+10**(-12/20))/2)),`value ${bus.gainDb.value}`);
  await e.dispose();
});

test('pan binds an equal-power host panner and rejects out-of-range values',async()=>{
  const h=host(),e=h.engine;
  assert.throws(()=>e.pan({pan:1.5}),code('INVALID_VALUE'));
  assert.throws(()=>e.pan({pan:-1.5}),code('INVALID_VALUE'));
  const pan=e.pan({pan:-0.75});
  const plain=e.pan();
  const source=e.oscillator();
  source.connect(pan).connect(e.output);
  plain.connect(e.output);
  assert.throws(()=>pan.connect(source),code('INVALID_CONNECTION'));
  await e.start();
  assert.equal(h.panners.length,2);
  assert.deepEqual(h.panners[0].events,[['set',-0.75,0]]);
  assert.deepEqual(h.panners[1].events,[['set',0,0]]);
  assert.equal(h.gains.length,1,'only the oscillator unity gain');
  await e.dispose();
});

test('delay builds a finite feedforward tap chain with unity dry and a bound wet mix',async()=>{
  const h=host(),e=h.engine;
  assert.throws(()=>e.delay({time:{seconds:0}}),code('INVALID_VALUE'));
  assert.throws(()=>e.delay({time:{seconds:6}}),code('INVALID_VALUE'));
  assert.throws(()=>e.delay({feedback:0.95}),code('INVALID_VALUE'));
  assert.throws(()=>e.delay({taps:0}),code('INVALID_VALUE'));
  assert.throws(()=>e.delay({taps:17}),code('INVALID_VALUE'));
  assert.throws(()=>e.delay({taps:1.5}),code('INVALID_VALUE'));
  const delay=e.delay({time:{seconds:0.01},feedback:0.5,taps:3,mix:0.3});
  const source=e.oscillator();
  source.connect(delay).connect(e.output);
  await e.start();
  assert.equal(h.delays.length,3);
  for(const d of h.delays) assert.equal(d.maxDelay,0.01);
  for(const d of h.delays) assert.deepEqual(d.events,[['set',0.01,0]]);
  const tapGains=h.gains.filter(g=>g.events.length===1&&[0.5,0.25,0.125].includes(g.events[0][1]));
  assert.deepEqual(tapGains.map(g=>g.events[0][1]),[0.5,0.25,0.125]);
  const wet=h.gains.find(g=>g.events[0]&&g.events[0][1]===0.3);
  assert.ok(wet,'wet gain bound to mix');
  assert.equal(h.gains.length,3+3+1); // input, out, wet + 3 tap gains + oscillator unity gain
  const inputGain=h.gains[0];
  assert.ok(source.host.connections.includes(delay.input),'source lands on the effect input');
  assert.equal(delay.input,inputGain);
  delay.mix.rampTo(1,{seconds:0.1});
  assert.deepEqual(wet.events.slice(1),[['cancel',0],['set',0.3,0],['ramp',1,0.1]]);
  await e.dispose();
});

test('reverb generates a deterministic energy-normalized stereo IR into a non-normalized convolver',async()=>{
  const h=host(),e=h.engine;
  assert.throws(()=>e.reverb({decay:{seconds:0.05}}),code('INVALID_VALUE'));
  assert.throws(()=>e.reverb({decay:{seconds:11}}),code('INVALID_VALUE'));
  const a=syntheticReverbResponse(0.5,48000),b=syntheticReverbResponse(0.5,48000);
  assert.equal(a.length,2);
  for(let c=0;c<2;c++){
    assert.deepEqual([...a[c]],[...b[c]]);
    let energy=0;for(const x of a[c]){assert.ok(Number.isFinite(x));energy+=x*x;}
    assert.ok(Math.abs(energy-1)<=1e-6,`channel ${c} energy ${energy}`);
  }
  assert.notDeepEqual([...a[0].subarray(0,64)],[...a[1].subarray(0,64)]);
  const reverb=e.reverb({decay:{seconds:0.5},mix:0.25});
  e.oscillator().connect(reverb).connect(e.output);
  await e.start();
  assert.equal(h.buffers.length,1);
  assert.equal(h.buffers[0].numberOfChannels,2);
  assert.equal(h.buffers[0].length,24000);
  assert.equal(h.buffers[0].sampleRate,48000);
  assert.deepEqual(h.buffers[0].copies,[[0,24000],[1,24000]]);
  assert.equal(h.convolvers.length,1);
  assert.equal(h.convolvers[0].normalize,false);
  assert.equal(h.convolvers[0].buffer,h.buffers[0]);
  await e.dispose();
});

test('effect chains route, dispose internal host nodes once, and leave no leaks over 100 cycles',async()=>{
  const h=host(),e=h.engine;
  const source=e.oscillator();
  const delay=e.delay({taps:2}),reverb=e.reverb(),pan=e.pan(),bus=e.bus();
  source.connect(delay).connect(reverb).connect(pan).connect(bus).connect(e.output);
  await e.start();
  assert.ok(source.host.connections.includes(delay.input));
  const delayNodes=[...h.delays,...h.gains.slice(1,1+3+2)]; // taps delays + input/out/wet/tap gains
  const before=new Map(delayNodes.map(node=>[node,node.disconnects]));
  const disconnectsBefore=source.host.disconnects;
  delay.dispose();
  assert.equal(source.host.disconnects,disconnectsBefore+1,'source reconnect severs the disposed edge');
  for(const node of delayNodes) assert.equal(node.disconnects,before.get(node)+1,'each delay host node disconnected exactly once by dispose');
  await e.dispose();
  assert.equal(e.diagnostics.nodes,0);
  for(let i=0;i<100;i++){
    const h2=host(),e2=h2.engine;
    e2.oscillator().connect(e2.delay()).connect(e2.reverb()).connect(e2.pan()).connect(e2.bus()).connect(e2.output);
    await e2.start();await e2.dispose();
    assert.equal(e2.diagnostics.nodes,0);
    assert.equal(e2.diagnostics.voices,0);
  }
});

test('host failure inside an effect cleans partial nodes and start can retry',async()=>{
  const h=host(),e=h.engine;
  const reverb=e.reverb();reverb.connect(e.output);
  const created=h.gains;
  const original=h.context.createConvolver;
  h.context.createConvolver=()=>{throw new Error('no convolver');};
  await assert.rejects(e.start(),code('ACTIVATION_FAILED'));
  for(const g of created) assert.equal(g.disconnects,1,'partially created gains disconnected');
  h.context.createConvolver=original;
  await e.start();assert.equal(e.state,'running');
  await e.dispose();
  const h2=host(),e2=h2.engine;
  e2.oscillator().connect(e2.delay({taps:3})).connect(e2.output);
  const createDelay=h2.context.createDelay;let calls=0;
  h2.context.createDelay=(...a)=>{calls++;if(calls===2)throw new Error('second delay fails');return createDelay(...a);};
  await assert.rejects(e2.start(),code('ACTIVATION_FAILED'));
  for(const node of [...h2.gains.slice(1),...h2.delays]) assert.equal(node.disconnects,1);
  h2.context.createDelay=createDelay;
  await e2.start();assert.equal(e2.state,'running');
  await e2.dispose();
});
