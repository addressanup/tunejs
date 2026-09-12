import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Engine,TuneError} from '../dist/index.js';
import {softKeys} from '../dist/presets.js';
import {decodeWav,encodeWav} from '../dist/assets.js';

const code=expected=>error=>error instanceof TuneError && error.code===expected;

// Host double with a synthetic tap: `taps[i].emit(channels)` pushes one chunk as the host would from its render thread,
// honouring the in-flight bound (chunks beyond `inFlightChunks` unacknowledged ones are dropped and counted into the next
// delivered chunk's `droppedFramesBefore`). `capture` resolves a fake microphone node or rejects like getUserMedia.
function host({sampleRate=48000,captureError=null,tapping=true}={}) {
  const taps=[],captures=[],events=[];
  const param=()=>({value:1,setValueAtTime(v,t){events.push(['set',v,t]);},linearRampToValueAtTime(v,t){events.push(['ramp',v,t]);},cancelScheduledValues(t){events.push(['cancel',t]);}});
  const mknode=()=>({disconnects:0,targets:[],connect(t){this.targets.push(t);},disconnect(){this.disconnects++;this.targets=[];}});
  const context={state:'suspended',sampleRate,currentTime:0,destination:mknode(),
    createGain:()=>({...mknode(),gain:param()}),
    createBiquadFilter:()=>({...mknode(),type:'lowpass',frequency:param(),Q:param()}),
    createOscillator:()=>({...mknode(),type:'sine',frequency:param(),start(){},stop(){}}),
    createStereoPanner:()=>({...mknode(),pan:param()}),
    createBuffer(channels,frames,rate){const data=Array.from({length:channels},()=>new Float32Array(frames));return {sampleRate:rate,length:frames,numberOfChannels:channels,copyToChannel(src,i){data[i].set(src);},getChannelData:i=>data[i]};},
    createBufferSource:()=>({...mknode(),buffer:null,loop:false,loopStart:0,loopEnd:0,playbackRate:param(),start(){},stop(){}}),
    async resume(){this.state='running';},async suspend(){this.state='suspended';},async close(){this.state='closed';}};
  const adapter={name:'capture-test-double',hostLimits:{fanOut:true},createContext:()=>context,setEnded(node,fn){node.onEnded=fn;},hostTime:(frame,rate)=>frame/rate,
    ...(tapping?{tapping:{async createTap(_context,{chunkFrames,inFlightChunks}){
      const tap={...mknode(),chunkFrames,inFlightChunks,inFlight:0,dropped:0,sequence:0,nextFrame:0,closed:false,callback:null,acknowledged:[],
        onChunk(cb){this.callback=cb;},
        acknowledge(sequence){this.acknowledged.push(sequence);this.inFlight=Math.max(0,this.inFlight-1);},
        close(){ if(this.dropped&&this.callback) this.callback({sequence:this.sequence++,startFrame:this.nextFrame,channels:[new Float32Array(0)],droppedFramesBefore:this.dropped}); this.dropped=0; this.closed=true; this.callback=null; },
        emit(channels){ const frames=channels[0].length; const startFrame=this.nextFrame; this.nextFrame+=frames;
          if(this.closed||!this.callback) return;
          if(this.inFlight>=this.inFlightChunks){this.dropped+=frames;return;}
          this.inFlight++; const droppedFramesBefore=this.dropped; this.dropped=0;
          this.callback({sequence:this.sequence++,startFrame,channels:channels.map(c=>Float32Array.from(c)),droppedFramesBefore}); }};
      taps.push(tap); return tap; }}}:{}),
    async capture(_context,{kind,signal}){
      if(captureError){ const error=new Error(captureError); error.name=captureError; throw error; }
      if(signal?.aborted){ const error=new Error('aborted'); error.name='AbortError'; throw error; }
      const capture={node:mknode(),stopped:0,kind,stop(){this.stopped++;}}; captures.push(capture); return capture; }};
  return {engine:new Engine({adapter}),context,taps,captures,events};
}
const tone=(frames,frequency=432,rate=48000,offset=0,amplitude=0.5)=>Float32Array.from({length:frames},(_,i)=>amplitude*Math.sin(2*Math.PI*frequency*(offset+i)/rate));
const settle=()=>new Promise(resolve=>setTimeout(resolve,0));
const drain=async(iterable,count)=>{const out=[];for await(const chunk of iterable){out.push(chunk);if(out.length>=count) break;}return out;};

test('a tap on a graph bus delivers ordered, contiguous, consumer-owned chunks and reports zero drops',async()=>{
  const h=host(),e=h.engine; const keys=e.instrument(softKeys); keys.connect(e.output); await e.start();
  const tap=await e.tap({source:keys});
  assert.equal(h.taps.length,1); assert.equal(h.taps[0].chunkFrames,1024); assert.equal(h.taps[0].inFlightChunks,Math.ceil(48000/1024));
  assert.equal(tap.chunkFrames,1024); assert.equal(tap.maxBufferedFrames,Math.ceil(48000/1024)*1024);
  assert.ok(keys.host.targets.includes(h.taps[0]),'source host connects into the host tap');
  assert.equal(e.diagnostics.taps,1);
  for(let i=0;i<5;i++) h.taps[0].emit([tone(1024,432,48000,i*1024),tone(1024,432,48000,i*1024)]);
  const chunks=await drain(tap,5);
  assert.deepEqual(chunks.map(c=>c.sequence),[0,1,2,3,4]);
  assert.deepEqual(chunks.map(c=>c.startFrame),[0,1024,2048,3072,4096]);
  assert.ok(chunks.every(c=>c.sampleRate===48000 && c.channels.length===2 && c.channels[0].length===1024 && c.droppedFramesBefore===0));
  chunks[0].channels[0][0]=123; // consumer-owned copy: the host double's data is untouched
  assert.deepEqual(h.taps[0].acknowledged,[0,1,2,3,4]);
  assert.deepEqual(tap.diagnostics,{delivered:5,droppedFrames:0,queuedFrames:0,peakQueuedFrames:5120,state:'active'});
  tap.cancel();
  assert.equal(tap.diagnostics.state,'cancelled'); assert.equal(h.taps[0].closed,true); assert.equal(h.taps[0].disconnects,1);
  assert.equal(e.diagnostics.taps,0); assert.ok(e.nodes.has(keys),'cancelling a tap keeps its source');
  await e.dispose();
});

test('ten-second synthetic source: every discontinuity is reported and buffering stays within capacity',async()=>{
  const h=host(),e=h.engine; const keys=e.instrument(softKeys); keys.connect(e.output); await e.start();
  const tap=await e.tap({source:keys,chunkFrames:1024,maxBufferedFrames:4096});
  const hostTap=h.taps[0];
  assert.equal(hostTap.inFlightChunks,4);
  const totalFrames=480000, chunkFrames=1024, chunkCount=Math.ceil(totalFrames/chunkFrames);
  // Ten seconds arrive with no consumer: the host keeps four chunks in flight, drops the rest and counts them; the
  // TuneJS queue never exceeds its 4096-frame capacity.
  for(let i=0;i<chunkCount;i++){ const frames=Math.min(chunkFrames,totalFrames-i*chunkFrames); hostTap.emit([tone(frames,432,48000,i*chunkFrames)]); }
  assert.ok(tap.diagnostics.queuedFrames<=4096 && tap.diagnostics.peakQueuedFrames<=4096,JSON.stringify(tap.diagnostics));
  const first=(await drain(tap,1))[0];
  assert.equal(first.droppedFramesBefore,0); assert.equal(first.startFrame,0);
  // The next produced chunk carries every discarded frame exactly once.
  hostTap.emit([tone(chunkFrames,432,48000,totalFrames)]);
  const remaining=await drain(tap,4);
  assert.deepEqual(remaining.map(c=>c.droppedFramesBefore),[0,0,0,totalFrames-4096]);
  let delivered=first.channels[0].length, accounted=first.droppedFramesBefore;
  for(const chunk of remaining){ accounted+=chunk.droppedFramesBefore; delivered+=chunk.channels[0].length; }
  const lastDelivered=remaining[remaining.length-1];
  assert.equal(lastDelivered.startFrame+lastDelivered.channels[0].length, delivered+accounted, 'frames delivered plus frames reported dropped equal the source timeline');
  assert.equal(tap.diagnostics.droppedFrames,accounted);
  let expectedStart=first.startFrame+first.channels[0].length;
  for(const chunk of remaining){ assert.equal(chunk.startFrame,expectedStart+chunk.droppedFramesBefore); expectedStart=chunk.startFrame+chunk.channels[0].length; }
  tap.cancel();
  assert.equal(e.diagnostics.taps,0);
  await e.dispose();
});

test('taps end with an explicit reason on source or engine disposal, and reject unsupported or invalid requests',async()=>{
  const h=host(),e=h.engine; const keys=e.instrument(softKeys); keys.connect(e.output); await e.start();
  const tap=await e.tap({source:keys});
  const iterator=tap[Symbol.asyncIterator]();
  const pending=iterator.next();
  keys.dispose();
  assert.deepEqual(await pending,{done:true,value:undefined});
  assert.equal(tap.diagnostics.state,'ended'); assert.equal(tap.endReason,'source-disposed');
  const other=e.instrument(softKeys); other.connect(e.output);
  const tap2=await e.tap({source:other});
  const pending2=tap2[Symbol.asyncIterator]().next();
  await e.dispose();
  assert.deepEqual(await pending2,{done:true,value:undefined});
  assert.equal(tap2.endReason,'engine-disposed');
  const g=host(),ge=g.engine; const source=ge.instrument(softKeys);
  await assert.rejects(ge.tap({source}),code('NOT_RUNNING'));
  await ge.start();
  await assert.rejects(ge.tap({source,chunkFrames:100}),code('INVALID_VALUE'));       // not a multiple of 128
  await assert.rejects(ge.tap({source,chunkFrames:128,maxBufferedFrames:64}),code('INVALID_VALUE')); // capacity below one chunk
  await assert.rejects(ge.tap({source:ge.output}),code('INVALID_CONNECTION'));           // output cannot be tapped
  await assert.rejects(ge.tap({source:host().engine.instrument(softKeys)}),code('CROSS_ENGINE'));
  await ge.dispose();
  const n=host({tapping:false}); const ns=n.engine.instrument(softKeys); await n.engine.start();
  assert.equal(n.engine.capabilities.taps,false);
  await assert.rejects(n.engine.tap({source:ns}),code('UNSUPPORTED'));
  await n.engine.dispose();
});

test('microphone input requests permission only through engine.input and is never routed to output',async()=>{
  const h=host(),e=h.engine; await e.start();
  assert.equal(h.captures.length,0);
  const microphone=await e.input({kind:'microphone'});
  assert.equal(h.captures.length,1); assert.equal(h.captures[0].kind,'microphone');
  assert.equal(microphone.kind,'source');
  assert.ok(h.captures[0].node.targets.includes(microphone.host),'capture node feeds the input host gain');
  assert.equal(microphone.targets.size,0,'no automatic monitoring');
  assert.throws(()=>e.output.connect(microphone),code('INVALID_CONNECTION'));
  microphone.dispose();
  assert.equal(h.captures[0].stopped,1); assert.equal(e.nodes.has(microphone),false);
  const denied=host({captureError:'NotAllowedError'}); await denied.engine.start();
  await assert.rejects(denied.engine.input({kind:'microphone'}),code('PERMISSION_DENIED'));
  const missing=host({captureError:'NotFoundError'}); await missing.engine.start();
  await assert.rejects(missing.engine.input({kind:'microphone'}),code('NO_DEVICE'));
  const cancelled=host(); await cancelled.engine.start(); const controller=new AbortController(); controller.abort();
  await assert.rejects(cancelled.engine.input({kind:'microphone'},{signal:controller.signal}),code('CANCELLED'));
  await assert.rejects(e.input({kind:'line'}),code('INVALID_VALUE'));
  const idle=host(); await assert.rejects(idle.engine.input({kind:'microphone'}),code('NOT_RUNNING'));
  await e.dispose(); await denied.engine.dispose(); await missing.engine.dispose(); await cancelled.engine.dispose();
});

test('recorder finalizes a bounded recording, encodes WAV, fails on overflow and stops at the duration limit',async()=>{
  const h=host(),e=h.engine; const keys=e.instrument(softKeys); keys.connect(e.output); await e.start();
  const recorder=e.recorder({source:keys,maxSeconds:1});
  assert.equal(recorder.state,'idle');
  await recorder.start();
  assert.equal(recorder.state,'recording'); assert.equal(h.taps.length,1);
  const hostTap=h.taps[0];
  for(let i=0;i<10;i++){ hostTap.emit([tone(1024,432,48000,i*1024,0.5),tone(1024,432,48000,i*1024,0.25)]); await settle(); }
  const recording=await recorder.stop();
  assert.equal(recorder.state,'stopped');
  assert.equal(recording.reason,'stopped'); assert.equal(recording.frames,10240); assert.equal(recording.sampleRate,48000); assert.equal(recording.channels.length,2);
  assert.ok(Math.abs(recording.channels[0][1000]-0.5*Math.sin(2*Math.PI*432*1000/48000))<=1e-6);
  const wav=recording.toWav();
  assert.equal(wav.clippedSamples,0);
  const decoded=decodeWav(wav.bytes);
  assert.equal(decoded.frames,10240); assert.equal(decoded.sampleRate,48000);
  let error=0; for(let i=0;i<10240;i++) error=Math.max(error,Math.abs(decoded.channels[1][i]-recording.channels[1][i]));
  assert.ok(error<=1/32768,`16-bit roundtrip error ${error}`);
  const asset=recording.asAsset('take-1');
  assert.equal(asset.id,'take-1'); assert.ok(asset.bytes instanceof ArrayBuffer);
  assert.equal(hostTap.closed,true); assert.equal(e.diagnostics.taps,0);
  // Duration limit: 1 s max at 48 kHz = 46 full chunks + a partial one; the recorder finalizes itself.
  const limited=e.recorder({source:keys,maxSeconds:1}); await limited.start(); const tap2=h.taps[1];
  for(let i=0;i<60;i++){ tap2.emit([tone(1024,432,48000,i*1024)]); await settle(); }
  const auto=await limited.stop();
  assert.equal(auto.reason,'duration-limit'); assert.equal(auto.frames,48000);
  // Overflow: a stalled consumer inside the recorder cannot silently lose audio.
  const overflow=e.recorder({source:keys,maxSeconds:60,maxBufferedFrames:2048}); await overflow.start(); const tap3=h.taps[2];
  overflow.stall(true); // internal hook: stop draining the recorder's tap
  for(let i=0;i<8;i++) tap3.emit([tone(1024,432,48000,i*1024)]);
  overflow.stall(false); await settle();
  // stop() closes the tap; the host flushes its pending drop count, which the recorder must not ignore.
  await assert.rejects(overflow.stop(),error=>error instanceof TuneError && error.code==='OVERFLOW' && /dropped/.test(error.message));
  assert.equal(overflow.state,'failed');
  assert.equal(e.diagnostics.taps,0);
  assert.throws(()=>e.recorder({source:keys,maxSeconds:0}),code('INVALID_VALUE'));
  assert.throws(()=>e.recorder({source:keys,maxSeconds:601}),code('INVALID_VALUE'));
  await e.dispose();
});

test('encodeWav writes 16-bit PCM with clipping diagnostics that decodeWav reads back',()=>{
  const left=Float32Array.from([0,0.5,-0.5,1,-1,1.5,-1.25,0.25]), right=Float32Array.from([0.1,-0.1,0.2,-0.2,0.3,-0.3,0.4,-0.4]);
  const {bytes,clippedSamples}=encodeWav([left,right],44100);
  assert.equal(clippedSamples,2);
  assert.equal(bytes.byteLength,44+8*2*2);
  const view=new DataView(bytes);
  assert.equal(String.fromCharCode(...new Uint8Array(bytes,0,4)),'RIFF'); assert.equal(view.getUint16(20,true),1); assert.equal(view.getUint16(22,true),2); assert.equal(view.getUint32(24,true),44100); assert.equal(view.getUint16(34,true),16);
  const decoded=decodeWav(bytes);
  assert.equal(decoded.frames,8); assert.equal(decoded.sampleRate,44100);
  assert.deepEqual([...decoded.channels[0]].map(x=>Math.round(x*32768)),[0,16384,-16384,32767,-32768,32767,-32768,8192]);
  for(let i=0;i<8;i++) assert.ok(Math.abs(decoded.channels[1][i]-right[i])<=1/32768);
  assert.throws(()=>encodeWav([],44100),code('INVALID_VALUE'));
  assert.throws(()=>encodeWav([left,new Float32Array(3)],44100),code('INVALID_VALUE'));
  assert.throws(()=>encodeWav([left],0),code('INVALID_VALUE'));
  assert.throws(()=>encodeWav([Float32Array.from([NaN])],44100),code('INVALID_VALUE'));
});

test('meters coalesce level, waveform and frame timestamps at no more than the requested rate',async()=>{
  const h=host(),e=h.engine; const keys=e.instrument(softKeys); keys.connect(e.output); await e.start();
  let now=0; const timers={now:()=>now,set:(fn,ms)=>({fn,ms}),clear(){}}; // deterministic clock for the meter
  const meter=await e.meter({source:keys,updatesPerSecond:30},{timers});
  assert.equal(h.taps.length,1);
  const updates=[]; const unsubscribe=meter.subscribe(snapshot=>updates.push(snapshot));
  h.taps[0].emit([tone(1024,432,48000,0,0.5),new Float32Array(1024)]);
  await settle();
  const snapshot=meter.read();
  assert.equal(snapshot.frame,0); assert.equal(snapshot.frames,1024); assert.equal(snapshot.sampleRate,48000);
  assert.ok(Math.abs(snapshot.peak[0]-0.5)<=1e-3); assert.ok(Math.abs(snapshot.rms[0]-0.5/Math.SQRT2)<=1e-3); assert.equal(snapshot.peak[1],0); assert.equal(snapshot.rms[1],0);
  assert.equal(snapshot.waveform.min.length,64); assert.equal(snapshot.waveform.max.length,64);
  assert.ok(snapshot.waveform.max[0]>=snapshot.waveform.min[0]);
  // Ten chunks within one 33 ms window coalesce into a single subscriber update; the next window gets one more.
  for(let i=1;i<=10;i++){ h.taps[0].emit([tone(1024,432,48000,i*1024,0.5),new Float32Array(1024)]); await settle(); }
  meter.flush(); assert.equal(updates.length,1); assert.equal(updates[0].frame,10*1024);
  now+=40; meter.flush(); assert.equal(updates.length,1,'no new data since the last flush');
  h.taps[0].emit([tone(1024,432,48000,11*1024,0.5),new Float32Array(1024)]); await settle(); meter.flush();
  assert.equal(updates.length,2); assert.equal(updates[1].frame,11*1024);
  unsubscribe(); h.taps[0].emit([tone(1024),new Float32Array(1024)]); await settle(); now+=40; meter.flush();
  assert.equal(updates.length,2);
  meter.dispose(); assert.equal(e.diagnostics.taps,0);
  await assert.rejects(e.meter({source:keys,updatesPerSecond:0}),code('INVALID_VALUE'));
  await assert.rejects(e.meter({source:keys,updatesPerSecond:61}),code('INVALID_VALUE'));
  await e.dispose();
});
