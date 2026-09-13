import {test} from 'node:test';
import assert from 'node:assert/strict';
import * as fixtures from '../experiments/fixtures.js';
import {browserAdapter} from '../dist/adapters/browser.js';
import {nativeAdapter} from '../dist/adapters/native.js';

// Simulates React Native Audio API scheduling: start frame = static_cast<size_t>(seconds * sampleRate).
// Impulses render with the fixture's ramp gain at whichever frame the host selected.
function truncatingOffline({sampleRate,length}) {
  const starts=[];
  const node=()=>({connect(){},disconnect(){}});
  const param=()=>({setValueAtTime(){},linearRampToValueAtTime(){}});
  return {
    destination:node(),
    createBuffer(_channels,frames){const data=new Float32Array(frames);return {getChannelData:()=>data};},
    createBufferSource(){return {...node(),start(seconds){starts.push(Math.trunc(seconds*sampleRate));}};},
    createGain:()=>({...node(),gain:param()}),
    createBiquadFilter:()=>({...node(),frequency:param(),Q:param()}),
    createStereoPanner:()=>({...node(),pan:param()}),
    async startRendering(){
      const channels=[0,1].map(()=>new Float32Array(length));
      for(const frame of starts) for(const data of channels) data[frame]+=Math.fround(0.25+0.25*Math.min(frame/1024,1));
      return {getChannelData:index=>channels[index]};
    }
  };
}

function timingPCM(rate=48000,place=frame=>frame) {
  return [0,1].map(channel=>{
    const data=new Float32Array(rate);
    for(const frame of fixtures.impulseFrames) {
      const actual=place(frame,channel);
      if(actual!==null) data[actual]=0.25+0.25*Math.min(actual/1024,1);
    }
    return data;
  });
}

test('PCM comparison rejects mismatched lengths and nonfinite samples',()=>{
  assert.throws(()=>fixtures.maxError(new Float32Array(1),new Float32Array(2)),RangeError);
  assert.throws(()=>fixtures.maxError(new Float32Array(2),new Float32Array(1)),RangeError);
  for(const value of [NaN,Infinity,-Infinity]) {
    assert.throws(()=>fixtures.maxError([value],[0]),RangeError);
    assert.throws(()=>fixtures.maxError([0],[value]),RangeError);
  }
  assert.equal(fixtures.maxError([0,0.5],[0,0.25]),0.25);
});

test('exact stereo timing reports all onsets and zero frame and gain errors',()=>{
  for(const rate of [44100,48000]) {
    const result=fixtures.analyzeTimingFixture(timingPCM(rate));
    assert.equal(result.onsetStatus,'pass');
    assert.equal(result.toleranceFrames,1);
    assert.equal(result.channels.length,2);
    for(const channel of result.channels) {
      assert.equal(channel.expectedCount,fixtures.impulseFrames.length);
      assert.equal(channel.observedCount,fixtures.impulseFrames.length);
      assert.deepEqual(channel.observedOnsets.map(onset=>onset.frame),fixtures.impulseFrames);
      assert.deepEqual(channel.frameOffsets,fixtures.impulseFrames.map(()=>0));
      assert.equal(channel.maxOnsetErrorFrames,0);
      assert.equal(channel.gainErrorAtActualOnset,0);
    }
  }
});

test('one-frame shift is reported separately from strict buffer error',()=>{
  const expected=timingPCM(44100);
  const shifted=timingPCM(44100,frame=>frame===1023?1022:frame);
  const result=fixtures.analyzeTimingFixture(shifted);
  assert.equal(result.onsetStatus,'pass');
  for(const channel of result.channels) {
    assert.equal(channel.maxOnsetErrorFrames,1);
    assert.equal(channel.frameOffsets[5],-1);
    assert.equal(channel.gainErrorAtActualOnset,0);
  }
  assert.equal(fixtures.maxError(expected[0],shifted[0]),0.499755859375);
});

test('either channel exceeding one frame fails onset acceptance',()=>{
  const result=fixtures.analyzeTimingFixture(timingPCM(48000,(frame,channel)=>frame===8000&&channel===1?8002:frame));
  assert.equal(result.onsetStatus,'fail');
  assert.equal(result.channels[0].maxOnsetErrorFrames,0);
  assert.equal(result.channels[1].maxOnsetErrorFrames,2);
});

test('missing and extra impulses cannot receive a misleading frame-error score',()=>{
  const missing=timingPCM(48000,frame=>frame===8000?null:frame);
  const extra=timingPCM(); extra[0][8001]=0.5;
  for(const pcm of [missing,extra]) {
    const result=fixtures.analyzeTimingFixture(pcm);
    assert.equal(result.onsetStatus,'fail');
    assert.equal(result.channels[0].maxOnsetErrorFrames,null);
    assert.equal(result.channels[0].frameOffsets,null);
    assert.notEqual(result.channels[0].expectedCount,result.channels[0].observedCount);
  }
});

test('timing diagnostics reject malformed or nonfinite PCM',()=>{
  assert.throws(()=>fixtures.analyzeTimingFixture([]),RangeError);
  assert.throws(()=>fixtures.analyzeTimingFixture([new Float32Array(48000)]),RangeError);
  assert.throws(()=>fixtures.analyzeTimingFixture([new Float32Array(44100),new Float32Array(48000)]),RangeError);
  assert.throws(()=>fixtures.analyzeTimingFixture([new Float32Array(16),new Float32Array(16)]),RangeError);
  const invalid=timingPCM(); invalid[1][9000]=NaN;
  assert.throws(()=>fixtures.analyzeTimingFixture(invalid),RangeError);
});

test('fixture reports retain strict timing failures alongside onset diagnostics',async()=>{
  const createOffline=({sampleRate})=>{
    const param=()=>({setValueAtTime(){},linearRampToValueAtTime(){}});
    const node=()=>({connect(){},disconnect(){},start(){}});
    const channels=timingPCM(sampleRate,frame=>frame===1023?1022:frame);
    return {
      destination:node(),
      createBuffer(_channels,length){const data=new Float32Array(length);return {getChannelData:()=>data};},
      createBufferSource:node,
      createGain:()=>({...node(),gain:param()}),
      createBiquadFilter:()=>({...node(),frequency:param(),Q:param()}),
      createStereoPanner:()=>({...node(),pan:param()}),
      async startRendering(){return {getChannelData:index=>channels[index]};}
    };
  };
  const report=await fixtures.runFixtures(createOffline);
  assert.equal(report.fixtureVersion,7);
  assert.equal(report.scheduling,'raw-seconds');
  for(const kind of ['delay','convolver']) for(const result of report.results.filter(result=>result.kind===kind)) {
    assert.equal(result.status,'unavailable');
    assert.equal(result.reason,kind==='delay'?'DelayNode absent':'ConvolverNode absent');
  }
  for(const kind of fixtures.dspKinds) {
    const results=report.results.filter(result=>result.kind===kind);
    assert.equal(results.length,2);
    for(const result of results) { assert.equal(result.status,'unavailable'); assert.equal(result.reason,'TuneJS DSP path absent'); }
  }
  await assert.rejects(fixtures.runFixtures(createOffline,{dsp:{load(){}}}),TypeError);
  const unsupported=Object.assign(new Error('offline contexts do not sum inputs on this host'),{code:'UNSUPPORTED'});
  const limited=await fixtures.runFixtures(createOffline,{dsp:{async load(){throw unsupported;},createDelay(){throw new Error('unreachable');},createConvolver(){throw new Error('unreachable');}}});
  for(const result of limited.results.filter(result=>fixtures.dspKinds.includes(result.kind))) {
    assert.equal(result.status,'unavailable');
    assert.match(result.reason,/^TuneJS DSP path unsupported on this context: offline contexts do not sum/);
  }
  const failing=await fixtures.runFixtures(createOffline,{dsp:{async load(){throw new Error('boom');},createDelay(){},createConvolver(){}}});
  for(const result of failing.results.filter(result=>fixtures.dspKinds.includes(result.kind))) assert.equal(result.status,'error');
  const expected=fixtures.dspConvolverFixtureExpected(48000);
  assert.equal(expected.length,2);
  assert.equal(expected[0][0],Math.fround(fixtures.syntheticImpulseResponse(12000,1234)[0]+1));
  assert.equal(expected[1][1],fixtures.syntheticImpulseResponse(12000,5678)[1]);
  const timing=report.results.filter(result=>result.kind==='timing');
  assert.equal(timing.length,2);
  for(const result of timing) {
    assert.equal(result.status,'fail');
    assert.equal(result.arithmeticError,0.499755859375);
    assert.equal(result.timing.onsetStatus,'pass');
    assert.equal(result.timing.channels[0].maxOnsetErrorFrames,1);
    assert.equal(result.observedOnsets[5].frame,1022);
  }
});

test('raw seconds shift frame 1023 on a truncating host at 44.1 kHz; adapter frame scheduling lands exactly',async()=>{
  const native=nativeAdapter(()=>{throw new Error('offline fixture only');});
  const browser=browserAdapter();
  for(const rate of [44100,48000]) {
    const raw=fixtures.analyzeTimingFixture((await fixtures.renderFixture(truncatingOffline,'timing',rate)).channels);
    const scheduled=fixtures.analyzeTimingFixture((await fixtures.renderFixture(truncatingOffline,'timing',rate,-0.75,native.hostTime)).channels);
    for(const channel of raw.channels) {
      assert.equal(channel.observedCount,fixtures.impulseFrames.length);
      assert.equal(channel.maxOnsetErrorFrames,rate===44100?1:0);
      if(rate===44100) assert.equal(channel.frameOffsets[5],-1);
    }
    assert.equal(scheduled.onsetStatus,'pass');
    for(const channel of scheduled.channels) {
      assert.deepEqual(channel.observedOnsets.map(onset=>onset.frame),fixtures.impulseFrames);
      assert.equal(channel.maxOnsetErrorFrames,0);
      assert.equal(channel.gainErrorAtActualOnset,0);
    }
    for(const frame of fixtures.impulseFrames) {
      assert.equal(browser.hostTime(frame,rate),frame/rate);
      const scheduledSeconds=native.hostTime(frame,rate);
      assert.equal(Math.trunc(scheduledSeconds*rate),frame);
      assert.equal(Math.round(scheduledSeconds*rate),frame);
    }
  }
});

test('fixture reports label the scheduling conversion and reject malformed options',async()=>{
  const native=nativeAdapter(()=>{throw new Error('offline fixture only');});
  const report=await fixtures.runFixtures(truncatingOffline,{hostTime:native.hostTime,scheduling:'native-adapter-frames'});
  assert.equal(report.fixtureVersion,7);
  assert.equal(report.scheduling,'native-adapter-frames');
  for(const result of report.results.filter(result=>result.kind==='timing')) {
    assert.equal(result.status,'pass');
    assert.equal(result.arithmeticError,0);
    assert.equal(result.timing.onsetStatus,'pass');
  }
  const unlabeled=await fixtures.runFixtures(truncatingOffline,{hostTime:native.hostTime});
  assert.equal(unlabeled.scheduling,'custom');
  await assert.rejects(fixtures.runFixtures(truncatingOffline,{hostTime:'frames'}),TypeError);
  await assert.rejects(fixtures.runFixtures(truncatingOffline,{scheduling:''}),TypeError);
  await assert.rejects(fixtures.renderFixture(truncatingOffline,'timing',48000,-0.75,null),TypeError);
});

// Ideal sparse-signal host: gains scale, delays shift by whole frames, convolvers add the shifted response for
// every nonzero input sample, and a mono signal reaching the stereo destination feeds both channels.
function idealMixingOffline({sampleRate,length}) {
  const node=(kind,extra={})=>({kind,targets:[],connect(t){this.targets.push(t);},disconnect(){},...extra});
  const param=()=>({value:0,setValueAtTime(v){this.value=v;},linearRampToValueAtTime(){}});
  const sources=[];
  const context={
    destination:node('destination'),
    createBuffer(channels,frames){const data=Array.from({length:channels},()=>new Float32Array(frames));return {numberOfChannels:channels,length:frames,getChannelData:i=>data[i],copyToChannel(src,i){data[i].set(src);}};},
    createBufferSource(){const s=node('source',{buffer:null,start(){}});sources.push(s);return s;},
    createGain:()=>node('gain',{gain:param()}),
    createDelay:()=>node('delay',{delayTime:param()}),
    createConvolver:()=>node('convolver',{buffer:null,normalize:true}),
    createBiquadFilter:()=>node('filter',{frequency:param(),Q:param()}),
    createStereoPanner:()=>node('pan',{pan:param()}),
    async startRendering(){
      const out=[new Float32Array(length),new Float32Array(length)];
      const propagate=(target,signal)=>{
        if(target.kind==='destination') { signal.forEach((data,c)=>{for(let i=0;i<length;i++) out[c][i]+=data[i];}); if(signal.length===1) for(let i=0;i<length;i++) out[1][i]+=signal[0][i]; return; }
        let next=signal;
        if(target.kind==='gain') next=signal.map(data=>data.map(x=>x*target.gain.value));
        if(target.kind==='delay') { const D=Math.round(target.delayTime.value*sampleRate); next=signal.map(data=>{const shifted=new Float32Array(length); for(let i=0;i+D<length;i++) shifted[i+D]=data[i]; return shifted;}); }
        if(target.kind==='convolver') {
          const ir=target.buffer; next=Array.from({length:ir.numberOfChannels},()=>new Float32Array(length));
          for(let c=0;c<ir.numberOfChannels;c++) { const response=ir.getChannelData(c); const input=signal[Math.min(c,signal.length-1)];
            for(let i=0;i<length;i++) if(input[i]!==0) for(let j=0;j<response.length && i+j<length;j++) next[c][i+j]+=input[i]*response[j]; }
        }
        for(const t of target.targets) propagate(t,next);
      };
      for(const s of sources) { const data=new Float32Array(length); data.set(s.buffer.getChannelData(0).subarray(0,length)); for(const t of s.targets) propagate(t,[data]); }
      return {getChannelData:i=>out[i]};
    }
  };
  return context;
}

test('mixing fixture references are deterministic and internally consistent',()=>{
  const expected48=fixtures.delayFixtureExpected(48000), expected44=fixtures.delayFixtureExpected(44100);
  assert.deepEqual([...expected48.entries()].filter(([,v])=>v!==0),[[0,1],[480,0.5],[960,0.25],[1440,0.125]]);
  assert.deepEqual([...expected44.entries()].filter(([,v])=>v!==0),[[0,1],[441,0.5],[882,0.25],[1323,0.125]]);
  assert.throws(()=>fixtures.delayFixtureExpected(22050),RangeError);
  const a=fixtures.syntheticImpulseResponse(12000,1234), b=fixtures.syntheticImpulseResponse(12000,1234), other=fixtures.syntheticImpulseResponse(12000,5678);
  assert.deepEqual([...a],[...b]);
  assert.ok(a.some((x,i)=>x!==other[i]));
  assert.ok(a.every(x=>Number.isFinite(x) && Math.abs(x)<=1));
  assert.ok(a.subarray(11000).every(x=>Math.abs(x)<=2e-3));
  assert.ok(Math.max(...a.subarray(0,100).map(Math.abs))>0.5);
  const convolver=fixtures.convolverFixtureExpected(48000);
  assert.equal(convolver.length,2); assert.equal(convolver[0].length,48000);
  assert.deepEqual([...convolver[1].subarray(0,12000)],[...other]);
  assert.ok(convolver[0].subarray(12000).every(x=>x===0));
  assert.throws(()=>fixtures.syntheticImpulseResponse(0,1),RangeError);
});

test('an ideal host passes the delay-chain and convolver-identity fixtures at both rates',async()=>{
  const report=await fixtures.runFixtures(idealMixingOffline);
  for(const kind of ['delay','convolver']) {
    const results=report.results.filter(result=>result.kind===kind);
    assert.equal(results.length,2);
    for(const result of results) {
      assert.equal(result.status,'pass',JSON.stringify(result));
      assert.ok(result.arithmeticError<=1e-5);
      assert.equal(result.repeatError,0);
    }
  }
  const delay48=report.results.find(result=>result.kind==='delay'&&result.rate===48000);
  assert.deepEqual(delay48.observedOnsets.map(onset=>onset.frame),[0,480,960,1440]);
});

test('topology probes and convolver fit diagnostics behave on an ideal host',async()=>{
  const report=await fixtures.runFixtures(idealMixingOffline);
  assert.equal(report.fixtureVersion,7);
  for(const kind of fixtures.topologyKinds) for(const result of report.results.filter(result=>result.kind===kind)) {
    assert.equal(result.status,'pass',JSON.stringify(result));
    assert.equal(result.arithmeticError,0);
  }
  const delayOnly=report.results.find(result=>result.kind==='delayonly'&&result.rate===44100);
  assert.deepEqual(delayOnly.observedOnsets,[{frame:441,value:1}]);
  assert.deepEqual(report.results.find(result=>result.kind==='fanout'&&result.rate===48000).observedOnsets,[{frame:0,value:1.5}]);
  assert.deepEqual(report.results.find(result=>result.kind==='fanin'&&result.rate===48000).observedOnsets,[{frame:0,value:2}]);
  assert.deepEqual(report.results.find(result=>result.kind==='fanout-gain'&&result.rate===44100).observedOnsets,[{frame:0,value:1.5}]);
  assert.deepEqual(report.results.find(result=>result.kind==='fanin-gain'&&result.rate===44100).observedOnsets,[{frame:0,value:2}]);
  assert.equal(report.results.length,26);
  assert.equal(report.results.filter(result=>fixtures.dspKinds.includes(result.kind)).every(result=>result.status==='unavailable'),true);
  const convolver=report.results.find(result=>result.kind==='convolver'&&result.rate===48000);
  assert.equal(convolver.fit.length,2);
  for(const fit of convolver.fit) { assert.equal(fit.lagFrames,0); assert.ok(Math.abs(fit.scale-1)<=1e-6); assert.ok(fit.residual<=1e-6); }
  assert.throws(()=>fixtures.topologyFixtureExpected('nope',48000),RangeError);
  const response=fixtures.syntheticImpulseResponse(1200,1234);
  const shifted=new Float32Array(1300); for(let i=0;i<1200;i++) shifted[i+3]=response[i]*0.8;
  const fit=fixtures.convolverFit(shifted,response);
  assert.equal(fit.lagFrames,3); assert.ok(Math.abs(fit.scale-0.8)<=1e-6); assert.ok(fit.residual<=1e-6);
});
