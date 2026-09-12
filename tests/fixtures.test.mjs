import {test} from 'node:test';
import assert from 'node:assert/strict';
import * as fixtures from '../experiments/fixtures.js';

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
  assert.equal(report.fixtureVersion,2);
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
