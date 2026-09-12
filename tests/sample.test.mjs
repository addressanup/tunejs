import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Engine,TuneError} from '../dist/index.js';
import {wav} from './helpers/wav.mjs';
const code=expected=>error=>error instanceof TuneError && error.code===expected;
const close=(a,b)=>Math.abs(a-b)<=1e-9;

// Per-node event capture, same conventions as instrument.test.mjs, plus createBuffer/createBufferSource.
// buffers[] records {sampleRate,length,numberOfChannels,copies:[[channel,length]]}; sources[] records
// starts[]/stops[] argument lists and playbackRate events.
function host() {
  const hostCalls=[],gains=[],buffers=[],sources=[];
  const mkparam=events=>({value:1,setValueAtTime(v,t){events.push(['set',v,t]);},linearRampToValueAtTime(v,t){events.push(['ramp',v,t]);},cancelScheduledValues(t){events.push(['cancel',t]);}});
  const mknode=()=>({disconnects:0,connect(){},disconnect(){this.disconnects++;}});
  const context={state:'suspended',sampleRate:48000,currentTime:0,destination:mknode(),
    createGain(){const events=[];const g={...mknode(),events,gain:mkparam(events)};gains.push(g);return g;},
    createBiquadFilter(){const events=[];return {...mknode(),events,type:'lowpass',frequency:mkparam(events),Q:mkparam(events)};},
    createOscillator(){const events=[];return {...mknode(),events,type:'sine',frequency:mkparam(events),start(){},stop(){}};},
    createBuffer(channels,frames,rate){const b={sampleRate:rate,length:frames,numberOfChannels:channels,copies:[],copyToChannel(src,i){this.copies.push([i,src.length]);}};buffers.push(b);return b;},
    createBufferSource(){const events=[];const s={...mknode(),events,buffer:null,loop:false,loopStart:0,loopEnd:0,playbackRate:{...mkparam(events),events},starts:[],stops:[],start(...a){this.starts.push(a);},stop(t){this.stops.push(t);}};sources.push(s);return s;},
    async resume(){this.state='running';},async suspend(){this.state='suspended';},async close(){this.state='closed';}};
  const adapter={hostLimits:{fanOut:true},name:'sample-test-double',createContext(){return context;},setEnded(node,fn){node.onEnded=fn;},hostTime(frame,rate){hostCalls.push([frame,rate]);return frame/rate;}};
  return {engine:new Engine({adapter}),context,gains,buffers,sources,hostCalls};
}
const wav2s=()=>wav([new Float32Array(96000),new Float32Array(96000)],48000,'float32');

test('bytes asset caches decoded PCM, shares it across nodes, and clears unreferenced entries',async()=>{
  const h=host(),e=h.engine;
  const bytes=wav([new Int16Array(480),new Int16Array(480)],48000,'pcm16');
  const a=await e.sample({id:'a',bytes});
  assert.equal(a.id,'a');assert.equal(a.sampleRate,48000);assert.equal(a.channels,2);assert.equal(a.frames,480);
  assert.ok(close(a.duration,0.01));
  assert.equal(e.diagnostics.cachedAssetBytes,2*480*4);
  const b=await e.sample({id:'a',bytes});
  assert.notEqual(a,b);
  a.connect(e.output);b.connect(e.output);
  await e.start();
  assert.equal(h.buffers.length,1);
  assert.equal(e.clearAssets(),0);
  a.dispose();b.dispose();
  assert.equal(e.clearAssets(),3840);
  assert.equal(e.diagnostics.cachedAssetBytes,0);
  await e.dispose();
});

test('url assets fetch and decode; failures and cancellation leave the cache untouched',async()=>{
  const h=host(),e=h.engine;
  const bytes=wav([Int16Array.from([1,2,3])],8000,'pcm16');
  const originalFetch=globalThis.fetch;
  try {
    globalThis.fetch=async()=>({ok:true,arrayBuffer:async()=>bytes.slice(0)});
    const s=await e.sample({id:'u',url:'/x.wav'});
    assert.equal(s.frames,3);
    globalThis.fetch=async()=>({ok:false,status:404});
    const err=await e.sample({id:'missing',url:'/404.wav'}).catch(e=>e);
    assert.equal(err.code,'ASSET_FAILED');assert.ok(err.message.includes('missing'));assert.ok(err.message.includes('404'));
    globalThis.fetch=async()=>{throw new Error('net down');};
    await assert.rejects(e.sample({id:'boom',url:'/x.wav'}),code('ASSET_FAILED'));
    const pre=new AbortController();pre.abort();
    let called=false;globalThis.fetch=async()=>{called=true;return {ok:true,arrayBuffer:async()=>bytes.slice(0)};};
    await assert.rejects(e.sample({id:'pre',url:'/x.wav'},{signal:pre.signal}),code('CANCELLED'));
    assert.equal(called,false);
    const mid=new AbortController();
    globalThis.fetch=async(_u,{signal}={})=>new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(new Error('aborted'))));
    const pending=e.sample({id:'mid',url:'/x.wav'},{signal:mid.signal});
    mid.abort();
    await assert.rejects(pending,code('CANCELLED'));
    assert.equal(e.diagnostics.cachedAssetBytes,3*4);
  } finally { globalThis.fetch=originalFetch; }
  await e.dispose();
});

test('concurrent loads of the same id share one cache entry',async()=>{
  const h=host(),e=h.engine;
  const bytes=wav([Int16Array.from([1,2,3,4]),Int16Array.from([4,3,2,1])],48000,'pcm16');
  const originalFetch=globalThis.fetch;
  try {
    const pending=[];
    globalThis.fetch=()=>new Promise(resolve=>pending.push(resolve));
    const p1=e.sample({id:'dup',url:'/x.wav'}),p2=e.sample({id:'dup',url:'/x.wav'});
    await Promise.resolve();await Promise.resolve();
    assert.equal(pending.length,2);
    for(const resolve of pending) resolve({ok:true,arrayBuffer:async()=>bytes.slice(0)});
    const [a,b]=await Promise.all([p1,p2]);
    assert.equal(a.entry,b.entry);
    assert.equal(e.diagnostics.cachedAssetBytes,2*4*4);
    a.connect(e.output);b.connect(e.output);await e.start();
    assert.equal(h.buffers.length,1);
    a.dispose();b.dispose();
    assert.equal(e.clearAssets(),32);
    assert.equal(e.diagnostics.cachedAssetBytes,0);
  } finally { globalThis.fetch=originalFetch; }
  await e.dispose();
});

test('argument and decoding failures reject with the documented codes',async()=>{
  const h=host(),e=h.engine;
  const bytes=wav([Int16Array.from([1])],8000,'pcm16');
  await assert.rejects(e.sample({bytes}),code('INVALID_VALUE'));
  await assert.rejects(e.sample({id:'x',bytes,url:'/x.wav'}),code('INVALID_VALUE'));
  await assert.rejects(e.sample({id:'x'}),code('INVALID_VALUE'));
  const err=await e.sample({id:'bad',bytes:new Uint8Array(20)}).catch(e=>e);
  assert.equal(err.code,'ASSET_FAILED');assert.ok(err.message.includes('bad'));
  await assert.rejects(e.sample({id:'empty',bytes:wav([new Int16Array(0)],48000,'pcm16')}),code('ASSET_FAILED'));
  await e.dispose();
});

test('play resamples to the context rate, applies region/loop/rate, and schedules frame stops',async()=>{
  const h=host(),e=h.engine;
  const bytes=wav([new Int16Array(88200),new Int16Array(88200)],44100,'pcm16');
  const clip=await e.sample({id:'clip',bytes});
  clip.connect(e.output);await e.start();
  assert.equal(h.buffers.length,1);
  assert.equal(h.buffers[0].numberOfChannels,2);
  assert.equal(h.buffers[0].sampleRate,48000);
  assert.equal(h.buffers[0].length,Math.round(88200*48000/44100));
  assert.deepEqual(h.buffers[0].copies,[[0,96000],[1,96000]]);
  h.context.currentTime=1;
  clip.play({region:{start:0.5,end:1.5},rate:1.25,loop:true});
  const src=h.sources[0];
  assert.equal(src.loop,true);assert.equal(src.loopStart,0.5);assert.equal(src.loopEnd,1.5);
  assert.deepEqual(src.playbackRate.events[0],['set',1.25,1]);
  assert.deepEqual(src.starts[0],[1,0.5,undefined]);
  clip.play({region:{start:0.5,end:1.5}});
  assert.deepEqual(h.sources[1].starts[0],[1,0.5,1]);
  clip.play({duration:{seconds:2}});
  assert.ok(close(h.sources[2].stops[0],(48000+Math.round(2*48000))/48000));
  assert.equal(e.diagnostics.voices,3);
  await e.dispose();
});

test('position tracks the asset timeline and seek swaps sources on a frame boundary',async()=>{
  const h=host(),e=h.engine;
  const clip=await e.sample({id:'pos',bytes:wav2s()});
  clip.connect(e.output);await e.start();
  h.context.currentTime=1;
  const voice=clip.play({region:{start:0.5,end:1.5},loop:true});
  h.context.currentTime=1.25;assert.ok(close(voice.position,0.75),`position ${voice.position}`);
  h.context.currentTime=2.3;assert.ok(close(voice.position,0.8),`position ${voice.position}`);
  const oldSource=h.sources[0];const staleEnded=oldSource.onEnded;
  const at=Math.round(2.3*48000)/48000;
  assert.deepEqual(await voice.seek(1.2),{position:1.2});
  const newSource=h.sources[1];
  assert.deepEqual(newSource.starts[0],[at,1.2,undefined]);
  assert.ok(oldSource.stops.includes(at));
  assert.equal(oldSource.onEnded,null);
  await assert.rejects(voice.seek(1.5),code('INVALID_VALUE'));
  await assert.rejects(voice.seek(0.4),code('INVALID_VALUE'));
  assert.equal(h.sources.length,2);
  staleEnded();
  assert.equal(voice.state,'playing');
  newSource.onEnded();
  assert.equal(voice.state,'ended');
  assert.equal(e.voices.size,0);
  await assert.rejects(voice.seek(1),code('DISPOSED'));
  const stopping=clip.play({region:{start:0.5,end:1.5}});
  stopping.stop();
  assert.equal(stopping.state,'stopping');
  await assert.rejects(stopping.seek(1.2),code('DISPOSED'));
  assert.equal(h.sources[2].stops.length,1);
  await e.dispose();
});

test('sample dispose ends voices, drops host nodes, and releases the cached entry',async()=>{
  const h=host(),e=h.engine;
  const clip=await e.sample({id:'c',bytes:wav2s()});
  clip.connect(e.output);await e.start();
  clip.play();clip.play();
  clip.dispose();
  assert.equal(e.voices.size,0);
  for(const source of h.sources) assert.equal(source.disconnects,1);
  assert.equal(e.clearAssets(),2*96000*4);
  await e.dispose();
  assert.equal(e.diagnostics.cachedAssetBytes,0);
});

test('100 sample cycles release all graph, voice and asset resources',async()=>{
  const bytes=wav([new Int16Array(480)],48000,'pcm16');
  for(let i=0;i<100;i++) {
    const h=host(),e=h.engine;
    const clip=await e.sample({id:'x',bytes});
    clip.connect(e.output);await e.start();
    clip.play().stop();
    await e.dispose();
    assert.equal(e.diagnostics.nodes,0);
    assert.equal(e.diagnostics.voices,0);
    assert.equal(e.diagnostics.cachedAssetBytes,0);
  }
});

test('host failures during start, play and seek keep ownership consistent',async()=>{
  const h=host(),e=h.engine;
  const clip=await e.sample({id:'f',bytes:wav2s()});
  clip.connect(e.output);
  const createBuffer=h.context.createBuffer;
  h.context.createBuffer=(...a)=>{const b=createBuffer(...a);b.copyToChannel=()=>{throw new Error('copy failed');};return b;};
  await assert.rejects(e.start(),code('ACTIVATION_FAILED'));
  h.context.createBuffer=createBuffer;
  await e.start();assert.equal(e.state,'running');
  h.context.currentTime=0.5;
  const voice=clip.play();
  h.context.createBufferSource=()=>{throw new Error('no source');};
  await assert.rejects(voice.seek(0.7),code('HOST_FAILURE'));
  assert.equal(h.sources[0].stops.length,0);
  const h2=host(),e2=h2.engine;
  const clip2=await e2.sample({id:'f2',bytes:wav2s()});
  clip2.connect(e2.output);await e2.start();
  h2.context.createBufferSource=()=>{throw new Error('no source');};
  assert.throws(()=>clip2.play(),code('HOST_FAILURE'));
  assert.equal(e2.voices.size,0);
  await e.dispose();await e2.dispose();
});

test('play validates running state, region bounds and rate before host work',async()=>{
  const h=host(),e=h.engine;
  const clip=await e.sample({id:'v',bytes:wav2s()});
  assert.throws(()=>clip.play(),code('NOT_RUNNING'));
  clip.connect(e.output);await e.start();
  const before=h.sources.length;
  assert.throws(()=>clip.play({region:{start:1.5,end:1}}),code('INVALID_VALUE'));
  assert.throws(()=>clip.play({region:{start:-1}}),code('INVALID_VALUE'));
  assert.throws(()=>clip.play({region:{end:5}}),code('INVALID_VALUE'));
  assert.throws(()=>clip.play({rate:0.1}),code('INVALID_VALUE'));
  assert.throws(()=>clip.play({rate:5}),code('INVALID_VALUE'));
  assert.equal(h.sources.length,before);
  await e.dispose();
});
