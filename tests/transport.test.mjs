import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Engine,TuneError} from '../dist/index.js';
import {TempoMap} from '../dist/transport.js';
import {softKeys,softDrums} from '../dist/presets.js';
const code=expected=>error=>error instanceof TuneError && error.code===expected;
const close=(a,b,tol=1e-6)=>Math.abs(a-b)<=tol;

function host() {
  const events=[],oscs=[],sources=[];
  const mkparam=ev=>({value:1,setValueAtTime(v,t){ev.push(['set',v,t]);},linearRampToValueAtTime(v,t){ev.push(['ramp',v,t]);},cancelScheduledValues(t){ev.push(['cancel',t]);}});
  const mknode=()=>({disconnects:0,connections:[],connect(t){this.connections.push(t);},disconnect(){this.disconnects++;}});
  const context={state:'suspended',sampleRate:48000,currentTime:0,destination:mknode(),
    createGain(){const ev=[];return {...mknode(),events:ev,gain:mkparam(ev)};},
    createBiquadFilter(){const ev=[];return {...mknode(),events:ev,type:'lowpass',frequency:mkparam(ev),Q:mkparam(ev)};},
    createOscillator(){const ev=[];const o={...mknode(),events:ev,type:'sine',frequency:mkparam(ev),starts:[],stops:[],start(...a){this.starts.push(a);},stop(t){this.stops.push(t);}};oscs.push(o);return o;},
    createBuffer(channels,frames,rate){return {sampleRate:rate,length:frames,numberOfChannels:channels,copies:[],copyToChannel(src,i){this.copies.push([i,src.length]);}};},
    createBufferSource(){const ev=[];const s={...mknode(),events:ev,buffer:null,loop:false,playbackRate:mkparam(ev),starts:[],stops:[],start(...a){this.starts.push(a);},stop(t){this.stops.push(t);}};sources.push(s);return s;},
    async resume(){this.state='running';},async suspend(){this.state='suspended';},async close(){this.state='closed';}};
  const adapter={hostLimits:{fanOut:true},name:'transport-test-double',createContext(){return context;},setEnded(node,fn){node.onEnded=fn;},hostTime(frame,rate){events.push(['hostTime',frame,rate]);return frame/rate;}};
  const engine=new Engine({adapter});
  return {engine,context,events,oscs,sources};
}
const fakeTimers=t=>{t.timers={set:(fn,ms)=>{t.__timers.setCalls.push(ms);const h=t.__timers.next++;t.__timers.handles.set(h,fn);return h;},clear:h=>{t.__timers.clears++;t.__timers.handles.delete(h);}};t.__timers={handles:new Map(),next:1,setCalls:[],clears:0};return t.__timers;};
const spyPlay=target=>{const calls=[];const original=target.play.bind(target);target.play=(...args)=>{const handle=original(...args);calls.push({args,handle});return handle;};return calls;};
function setFrame(h,e,frame){h.context.currentTime=frame/48000;assert.equal(e.currentFrame,frame);}

test('TempoMap maps beats to frames across tempo changes without accumulation',()=>{
  const map=new TempoMap(0,0,120,48000);
  for(let k=0;k<=3000;k+=250) assert.equal(map.frameAtBeat(k/3),Math.round(k/3*24000));
  for(const b of [0,0.5,1,1.75,3.5,8]) assert.ok(close(map.beatAtFrame(map.frameAtBeat(b)),b));
  const odd=new TempoMap(0,0,113,48000);
  for(let k=0;k<=900;k+=60) assert.equal(odd.frameAtBeat(k/3),Math.round(k*(60*48000/113)/3));
  map.append(4,60);
  assert.equal(map.frameAtBeat(5),map.frameAtBeat(4)+48000);
  assert.equal(map.frameAtBeat(4),96000);
});

test('transport state machine: start needs a running engine; pause/stop keep semantics',async()=>{
  const h=host(),e=h.engine;const timers=fakeTimers(e.transport);
  assert.throws(()=>e.transport.start(),code('NOT_RUNNING'));
  await e.start();
  e.transport.start();
  assert.equal(e.transport.state,'running');
  assert.deepEqual(timers.setCalls,[25]);
  const anchor=Math.round(0.05*48000);
  setFrame(h,e,anchor);
  assert.ok(close(e.transport.position.beat,0));
  assert.throws(()=>e.transport.setMeter({beatsPerBar:3}),code('INVALID_VALUE'));
  e.transport.pause();
  assert.equal(e.transport.state,'paused');
  assert.equal(timers.clears,1);
  setFrame(h,e,anchor+24000); // beat 1 passes, but paused
  assert.equal(e.transport.position.beat,0);
  e.transport.stop();
  assert.equal(e.transport.state,'stopped');
  assert.deepEqual(e.transport.position,{beat:0,bar:0,beatInBar:0});
  e.transport.setMeter({beatsPerBar:3});
  assert.equal(e.transport.meter.beatsPerBar,3);
  await e.dispose();
});

test('the lookahead window schedules occurrences on absolute frames and never repeats them',async()=>{
  const h=host(),e=h.engine;const timers=fakeTimers(e.transport);
  const keys=e.instrument(softKeys);keys.connect(e.output);await e.start();
  const calls=spyPlay(keys);
  const pattern=e.pattern({length:{beats:2},events:[{beat:0,notes:'C4',duration:{beats:1}},{beat:1.5,notes:'E4',duration:{beats:0.5},velocity:0.5}]});
  e.transport.schedule(pattern,keys);
  e.transport.start();
  const anchor=Math.round(0.05*48000); // 2400
  assert.equal(calls.length,1,'only beat 0 inside the first horizon');
  assert.deepEqual(calls[0].args,['C4',{velocity:0.8,duration:{seconds:0.5},at:{frame:anchor}}]);
  setFrame(h,e,30000); // horizon 42000 reaches beat 1.5 (frame 38400)
  e.transport.tick();
  assert.equal(calls.length,2);
  assert.deepEqual(calls[1].args,['E4',{velocity:0.5,duration:{seconds:0.25},at:{frame:anchor+36000}}]);
  setFrame(h,e,40800); // horizon 52800 reaches loop iteration beat 2 (frame 50400)
  e.transport.tick();
  assert.equal(calls.length,3);
  assert.deepEqual(calls[2].args,['C4',{velocity:0.8,duration:{seconds:0.5},at:{frame:anchor+48000}}]);
  e.transport.tick();
  assert.equal(calls.length,3,'no event is scheduled twice');
  await e.dispose();
});

test('late occurrences clamp to now and finished occurrences are skipped',async()=>{
  const h=host(),e=h.engine;fakeTimers(e.transport);
  const keys=e.instrument(softKeys);keys.connect(e.output);await e.start();
  const calls=spyPlay(keys);
  const pattern=e.pattern({length:{beats:2},events:[{beat:0,notes:'C4',duration:{beats:1}},{beat:1.5,notes:'E4',duration:{beats:0.5}}]});
  e.transport.schedule(pattern,keys);
  e.transport.start();
  assert.equal(calls.length,1);
  setFrame(h,e,45000); // beat-1.5 occurrence (38400) is late but not finished
  e.transport.tick();
  let d=e.transport.diagnostics;
  assert.equal(d.lateEvents,1,'beat-1.5 occurrence started late');
  assert.ok(close(d.maxLatenessSeconds,(45000-38400)/48000),`lateness ${d.maxLatenessSeconds}`);
  const late=calls.find(c=>c.args[1].at.frame===45000);
  assert.ok(late,'late event scheduled at current frame');
  assert.ok(calls.some(c=>c.args[1].at.frame===50400),'next loop occurrence still lands on grid');
  setFrame(h,e,100000); // jump past the end of the iteration-1 E4 (ends 98400)
  e.transport.tick();
  d=e.transport.diagnostics;
  assert.equal(d.skippedEvents,1,'finished occurrence skipped, never scheduled');
  assert.equal(d.lateEvents,2,'iteration-2 C4 (98400) clamps to now');
  const e4s=calls.filter(c=>c.args[0]==='E4');
  assert.equal(e4s.length,1,'the skipped E4 occurrence was never scheduled');
  assert.equal(calls.length,4,'no occurrence scheduled twice');
  await e.dispose();
});

test('pause/resume never replays occurrences before the resume beat',async()=>{
  const h=host(),e=h.engine;fakeTimers(e.transport);
  const keys=e.instrument(softKeys);keys.connect(e.output);await e.start();
  const calls=spyPlay(keys);
  e.transport.schedule(e.pattern({length:{beats:2},events:[{beat:0,notes:'C4',duration:{beats:1}},{beat:1,notes:'D4',duration:{beats:1}}]}),keys);
  e.transport.start();
  setFrame(h,e,36000); // beat 1.4
  e.transport.tick();
  const seenBeforePause=calls.length;
  e.transport.pause();
  assert.equal(e.transport.state,'paused');
  setFrame(h,e,516000); // +10 s of paused time
  e.transport.start();
  assert.equal(e.transport.state,'running');
  e.transport.tick();
  setFrame(h,e,523200); // bring the resume occurrence (beat 2 → frame 532800) into the horizon
  e.transport.tick();
  const newCalls=calls.slice(seenBeforePause);
  assert.ok(newCalls.length>0);
  assert.ok(newCalls.every(c=>c.args[1].at.frame>=518400),'no occurrence before the resume beat');
  assert.equal(newCalls[0].args[1].at.frame,532800,'first resume occurrence lands on the rebased grid');
  // interruption: engine drops out under a running transport
  h.context.state='suspended';
  e.transport.tick();
  assert.equal(e.transport.state,'paused');
  assert.equal(e.transport.diagnostics.interruptions,1);
  h.context.state='running';
  await e.dispose();
});

test('bpm changes apply at the next bar while running and immediately when stopped',async()=>{
  const h=host(),e=h.engine;fakeTimers(e.transport);
  await e.start();
  e.transport.start();
  setFrame(h,e,7200); // beat 0.2 at 120 bpm
  const ack=e.transport.bpm.set(60);
  assert.deepEqual(ack,{effectiveBeat:4,appliedAt:'next-bar'});
  assert.equal(e.transport.bpm.value,120);
  assert.equal(e.transport.bpm.pending,60);
  assert.equal(e.transport.frameAtBeat(5),e.transport.frameAtBeat(4)+48000);
  e.transport.stop();
  const now=e.transport.bpm.set(90);
  assert.equal(now.appliedAt,'now');
  assert.equal(e.transport.bpm.value,90);
  assert.throws(()=>e.transport.bpm.set(10),code('INVALID_VALUE'));
  assert.throws(()=>e.transport.bpm.set(500),code('INVALID_VALUE'));
  await e.dispose();
});

test('part.replace swaps the pattern at the next bar and the latest pending wins',async()=>{
  const h=host(),e=h.engine;fakeTimers(e.transport);
  const keys=e.instrument(softKeys);keys.connect(e.output);await e.start();
  const calls=spyPlay(keys);
  const A=e.pattern({length:{beats:4},events:[{beat:0,notes:'C4',duration:{beats:1}},{beat:1,notes:'E4',duration:{beats:1}},{beat:2,notes:'G4',duration:{beats:1}},{beat:3,notes:'B4',duration:{beats:1}}]});
  const B=e.pattern({length:{beats:2},events:[{beat:0,notes:'A3',duration:{beats:1}}]});
  const C=e.pattern({length:{beats:2},events:[{beat:0,notes:'F3',duration:{beats:1}}]});
  const part=e.transport.schedule(A,keys);
  e.transport.start();
  setFrame(h,e,26400); // beat 1
  const ack=part.replace(B,{boundary:'next-bar'});
  assert.deepEqual(ack,{effectiveBeat:4});
  part.replace(C,{boundary:'next-bar'}); // supersedes B
  setFrame(h,e,43200); // beat 1.75 — horizon 55200 covers A's beat 2 (frame 50400)
  e.transport.tick();
  setFrame(h,e,64800); // beat 2.6 — horizon 76800 covers A's beat 3 (frame 74400)
  e.transport.tick();
  const notes=calls.map(c=>c.args[0]);
  assert.ok(notes.includes('G4')&&notes.includes('B4'),'A events between beat 1 and 4 still scheduled');
  assert.ok(!notes.includes('A3'));
  setFrame(h,e,91200); // horizon 103200 reaches beat 4 (frame 98400)
  e.transport.tick();
  const notes2=calls.map(c=>c.args[0]);
  assert.ok(notes2.includes('F3'),'latest pending pattern wins');
  assert.ok(!notes2.includes('A3'));
  const f3=calls.find(c=>c.args[0]==='F3');
  assert.equal(f3.args[1].at.frame,2400+4*24000,'new pattern iteration 0 starts at the bar');
  await e.dispose();
});

test('cancel, stop and dispose release voices and the interval',async()=>{
  const h=host(),e=h.engine;const timers=fakeTimers(e.transport);
  const keys=e.instrument(softKeys);keys.connect(e.output);await e.start();
  const calls=spyPlay(keys);
  const part=e.transport.schedule(e.pattern({length:{beats:1},events:[{beat:0,notes:['C4','E4','G4'],duration:{beats:0.5}}]}),keys);
  e.transport.start();
  assert.equal(calls.length,1);
  const handle=calls[0].handle;let stops=0;const stop=handle.stop.bind(handle);handle.stop=()=>{stops++;stop();};
  part.cancel();
  assert.equal(part.state,'cancelled');
  assert.equal(stops,1);
  const n=calls.length;
  setFrame(h,e,30000);e.transport.tick();e.transport.tick();
  assert.equal(calls.length,n,'cancelled part never schedules again');
  part.cancel(); // idempotent
  assert.equal(stops,1);
  // transport.stop releases everything — a part scheduled while running starts on the next bar ≥ horizon
  const part2=e.transport.schedule(e.pattern({length:{beats:1},events:[{beat:0,notes:'C4',duration:{beats:0.5}}]}),keys);
  setFrame(h,e,87000);e.transport.tick(); // horizon 99000 reaches part2's beat-4 start (frame 98400)
  assert.equal(calls.length,n+1);
  const handle2=calls.at(-1).handle;let stops2=0;const stop2=handle2.stop.bind(handle2);handle2.stop=()=>{stops2++;stop2();};
  e.transport.stop();
  assert.equal(stops2,1);
  assert.equal(e.transport.position.beat,0);
  // dispose clears the interval and cancels parts
  e.transport.start();
  const part3=e.transport.schedule(e.pattern({length:{beats:1},events:[{beat:0,notes:'C4',duration:{beats:0.5}}]}),keys);
  await e.dispose();
  assert.equal(part3.state,'cancelled');
  assert.ok(timers.clears>=1,'interval cleared on dispose');
});

test('kit parts pass hit names; validation is synchronous',async()=>{
  const h=host(),e=h.engine;fakeTimers(e.transport);
  const kit=e.kit(softDrums);kit.connect(e.output);await e.start();
  const calls=spyPlay(kit);
  const drums=e.pattern({length:{beats:1},events:[{beat:0,notes:'kick',duration:{beats:0.25}},{beat:0.5,notes:'hat',duration:{beats:0.25}}]});
  e.transport.schedule(drums,kit);
  e.transport.start();
  setFrame(h,e,4800);e.transport.tick(); // hat (frame 14400) enters the horizon
  assert.deepEqual(calls.map(c=>c.args[0]),['kick','hat']);
  assert.throws(()=>e.transport.schedule(e.pattern({length:{beats:1},events:[{beat:0,notes:'boom',duration:{beats:1}}]}),kit),code('INVALID_VALUE'));
  assert.throws(()=>e.transport.schedule(e.pattern({length:{beats:1},events:[{beat:0,notes:'H9z',duration:{beats:1}}]}),e.instrument(softKeys)),code('INVALID_VALUE'));
  const other=host().engine;
  assert.throws(()=>e.transport.schedule(drums,other.kit(softDrums)),code('CROSS_ENGINE'));
  assert.throws(()=>e.transport.schedule(drums,e.gain()),code('INVALID_VALUE'));
  assert.throws(()=>e.pattern({length:{beats:0},events:[]}),code('INVALID_VALUE'));
  assert.throws(()=>e.pattern({length:{beats:1},events:[{beat:1,notes:'C4',duration:{beats:1}}]}),code('INVALID_VALUE'));
  assert.throws(()=>e.pattern({length:{beats:1},events:[{beat:0,notes:'',duration:{beats:1}}]}),code('INVALID_VALUE'));
  assert.throws(()=>e.pattern({length:{beats:1},events:[{beat:0,notes:'C4',duration:{beats:0}}]}),code('INVALID_VALUE'));
  await e.dispose();await other.dispose();
});

test('the default interval driver ticks on the wall clock and stop clears it',async()=>{
  const h=host(),e=h.engine;
  await e.start();
  let ticks=0;const tick=e.transport.tick.bind(e.transport);e.transport.tick=()=>{ticks++;tick();};
  e.transport.start();
  assert.equal(ticks,1,'immediate tick');
  await new Promise(r=>setTimeout(r,80));
  assert.ok(ticks>=3,`expected >=3 ticks, got ${ticks}`);
  e.transport.stop();
  const done=ticks;
  await new Promise(r=>setTimeout(r,60));
  assert.equal(ticks,done,'no ticks after stop');
  await e.dispose();
});

test('a pending tempo change survives pause and resume',async()=>{
  const h=host(),e=h.engine;fakeTimers(e.transport);
  await e.start();
  e.transport.start();
  setFrame(h,e,7200); // beat 0.2 at 120 bpm
  const ack=e.transport.bpm.set(60);
  assert.deepEqual(ack,{effectiveBeat:4,appliedAt:'next-bar'});
  setFrame(h,e,26400); // beat 1
  e.transport.pause();
  setFrame(h,e,266400); // +5 s of paused time
  e.transport.start();
  assert.equal(e.transport.bpm.pending,60,'queued change still pending after resume');
  assert.equal(e.transport.frameAtBeat(5)-e.transport.frameAtBeat(4),48000);
  assert.equal(e.transport.frameAtBeat(2)-e.transport.frameAtBeat(1),24000);
  // second case: pause after the change already took effect
  setFrame(h,e,364800); // beat 4.5 on the rebased map (anchor 268800 + 3*24000 + 0.5*48000)
  assert.equal(e.transport.bpm.value,60);
  e.transport.pause();
  setFrame(h,e,460800); // +2 s paused
  e.transport.start();
  assert.equal(e.transport.bpm.value,60,'resumed map runs at the applied tempo');
  assert.equal(e.transport.bpm.pending,null);
  await e.dispose();
});
