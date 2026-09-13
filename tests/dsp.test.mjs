import {test} from 'node:test';
import assert from 'node:assert/strict';
import {fft,convolve,Timeline,oscillatorValue} from '../dist/dsp.js';

const close=(a,b,tol)=>assert.ok(Math.abs(a-b)<=tol,`${a} vs ${b} (tol ${tol})`);

test('fft inverse recovers the input within 1e-9',()=>{
  const n=256;const re=new Float64Array(n),im=new Float64Array(n);
  for(let i=0;i<n;i++){re[i]=Math.sin(i*0.7)+Math.cos(i*0.13)*0.5;im[i]=Math.sin(i*0.31)*0.25;}
  const origRe=[...re],origIm=[...im];
  fft(re,im);fft(re,im,true);
  for(let i=0;i<n;i++){close(re[i],origRe[i],1e-9);close(im[i],origIm[i],1e-9);}
});

test('fft convolution equals direct convolution within 1e-9',()=>{
  const signal=new Float64Array(512);for(let i=0;i<512;i++)signal[i]=Math.sin(i*0.11)*Math.exp(-i/300);
  const kernel=new Float64Array(300);for(let i=0;i<300;i++)kernel[i]=Math.cos(i*0.07)/(i+1);
  const viaFft=convolve(signal,kernel);
  for(let i=0;i<signal.length+kernel.length-1;i++){
    let direct=0;
    for(let j=Math.max(0,i-kernel.length+1);j<=Math.min(i,signal.length-1);j++)direct+=signal[j]*kernel[i-j];
    close(viaFft[i],direct,1e-9);
  }
});

test('Timeline valueAt follows set, ramp mid-point and cancel',()=>{
  const t=new Timeline();
  t.set(0.2,0);t.ramp(1,1);
  close(t.valueAt(0),0.2,1e-12);close(t.valueAt(0.5),0.6,1e-12);close(t.valueAt(1),1,1e-12);close(t.valueAt(2),1,1e-12);
  t.set(0.5,1.5);close(t.valueAt(1.6),0.5,1e-12);
  const t2=new Timeline();t2.set(0.4,0);t2.ramp(0.9,2);t2.cancel(1);
  close(t2.valueAt(1.5),0.4,1e-12,'cancel dropped the pending ramp');
});

test('oscillator wave table values at quarter phases',()=>{
  for(const wave of ['sine','triangle','square','sawtooth']){
    const f=p=>oscillatorValue(wave,p);
    if(wave==='sine'){close(f(0),0,1e-12);close(f(0.25),1,1e-12);close(f(0.5),0,1e-12);close(f(0.75),-1,1e-12);}
    if(wave==='square'){assert.equal(f(0),1);assert.equal(f(0.25),1);assert.equal(f(0.5),-1);assert.equal(f(0.75),-1);}
    if(wave==='sawtooth'){close(f(0),0,1e-12);close(f(0.25),0.5,1e-12);close(f(0.5),-1,1e-12);close(f(0.75),-0.5,1e-12);}
    if(wave==='triangle'){close(f(0),0,1e-12);close(f(0.25),1,1e-12);close(f(0.5),0,1e-12);close(f(0.75),-1,1e-12);}
  }
});

import {BLOCK,DelayEffect,ConvolverEffect,PartitionedConvolver,mulberry32,delayFramesFor} from '../dist/dsp.js';
import {DSP_PROCESSOR_SOURCE} from '../dist/adapters/dsp-worklet-source.js';
import {delayTapSeconds,delayTapCount,delayFixtureExpected,dspConvolverFixtureExpected,convolverSeeds,convolverSeconds,syntheticImpulseResponse} from '../experiments/fixtures.js';

const mix1=()=>{const t=new Timeline();t.set(1,0);return t;};
const drive=(effect,signal,rate)=>{
  const ins=[new Float64Array(BLOCK),new Float64Array(BLOCK)];
  const outs=[new Float64Array(BLOCK),new Float64Array(BLOCK)];
  const out=new Float64Array(signal.length);
  for(let b=0;b<signal.length/BLOCK;b++){
    ins[0].set(signal.subarray(b*BLOCK,b*BLOCK+BLOCK));ins[1].fill(0);
    outs[0].fill(0);outs[1].fill(0);
    effect.process(ins,outs,mix1(),b*BLOCK/rate,rate);
    out.set(outs[0],b*BLOCK);
  }
  return out;
};

test('DelayEffect matches the closed-form impulse expectation',()=>{
  const rate=48000,D=delayFramesFor(delayTapSeconds,rate);
  const signal=new Float64Array(rate);signal[0]=1;
  const out=drive(new DelayEffect(2,D,delayTapCount,0.5),signal,rate);
  const expected=delayFixtureExpected(rate);
  for(let i=0;i<rate;i++)close(out[i],expected[i],1e-9);
});

test('PartitionedConvolver matches convolve() across kernel lengths',()=>{
  const random=mulberry32(0xC0FFEE);
  for(const len of [1,127,128,129,2047,2048,2049,3072,5000,48000]){
    const kernel=new Float64Array(len);for(let i=0;i<len;i++)kernel[i]=random()*2-1;
    const signal=new Float64Array(80*BLOCK);for(let i=0;i<signal.length;i++)signal[i]=random()*2-1;
    const expected=convolve(signal,kernel);
    const convolver=new PartitionedConvolver(kernel);
    const input=new Float64Array(BLOCK),block=new Float64Array(BLOCK);
    let maxError=0;
    for(let b=0;b<80;b++){
      input.set(signal.subarray(b*BLOCK,b*BLOCK+BLOCK));
      block.fill(0);convolver.process(input,block);
      for(let i=0;i<BLOCK;i++)maxError=Math.max(maxError,Math.abs(block[i]-expected[b*BLOCK+i]));
    }
    assert.ok(maxError<=1e-9,`kernel ${len}: max abs error ${maxError}`);
  }
});

test('ConvolverEffect dry+wet: unit-impulse response passes dry through',()=>{
  const rate=48000;
  const signal=new Float64Array(rate);signal[0]=1;
  const impulse=new Float64Array(BLOCK);impulse[0]=0.5;
  const out=drive(new ConvolverEffect([impulse]),signal,rate);
  close(out[0],1+0.5,1e-9);
  for(let i=1;i<rate;i++)close(out[i],0,1e-9);
});

test('mix ramp is applied per sample to the wet path',()=>{
  const rate=48000,D=delayFramesFor(delayTapSeconds,rate);
  const signal=new Float64Array(rate);signal[0]=1;
  const mix=new Timeline();mix.set(0,0);mix.ramp(1,1);
  const ins=[new Float64Array(BLOCK),new Float64Array(BLOCK)];
  const outs=[new Float64Array(BLOCK),new Float64Array(BLOCK)];
  const out=new Float64Array(rate);
  for(let b=0;b<rate/BLOCK;b++){
    ins[0].set(signal.subarray(b*BLOCK,b*BLOCK+BLOCK));ins[1].fill(0);
    outs[0].fill(0);outs[1].fill(0);
    new DelayEffect(2,D,1,1).process(ins,outs,mix,b*BLOCK/rate,rate); // fresh rings would break continuity
  }
  // Re-drive with one persistent effect:
  const effect=new DelayEffect(2,D,1,1);
  for(let b=0;b<rate/BLOCK;b++){
    ins[0].set(signal.subarray(b*BLOCK,b*BLOCK+BLOCK));ins[1].fill(0);
    outs[0].fill(0);outs[1].fill(0);
    effect.process(ins,outs,mix,b*BLOCK/rate,rate);
    out.set(outs[0],b*BLOCK);
  }
  close(out[0],1,1e-9);            // dry unity at t=0 where mix=0
  close(out[D],mix.valueAt(D/rate),1e-9); // echo scaled by ramped mix
});

// Simulate the bundled worklet processor in Node: stub the AudioWorkletGlobalScope names,
// evaluate DSP_PROCESSOR_SOURCE, then drive the registered processor class per block.
function simulateWorklet(processorOptions,rate){
  const scope={};
  scope.AudioWorkletProcessor=class{constructor(options){this.options=options;this.port={postMessage(){},onmessage:null};}};
  scope.registerProcessor=(name,ctor)=>{scope.__ctor=ctor;scope.__name=name;};
  scope.currentTime=0;scope.sampleRate=rate;
  new Function('scope',`with(scope){${DSP_PROCESSOR_SOURCE}}`)(scope);
  assert.equal(scope.__name,'tunejs-dsp');
  return {proc:new scope.__ctor({processorOptions}),scope,mixValues:new Float32Array(BLOCK).fill(1)};
}
function runProcessor(sim,rate,seconds=1){
  const frames=rate*seconds;
  const out=[new Float32Array(frames),new Float32Array(frames)];
  const impulse=new Float32Array(BLOCK);impulse[0]=1;
  for(let b=0;b<Math.ceil(frames/BLOCK);b++){
    sim.scope.currentTime=b*BLOCK/rate;
    const ins=[[b===0?impulse.slice():new Float32Array(BLOCK)]];
    const outs=[[new Float32Array(BLOCK),new Float32Array(BLOCK)]];
    const parameters={mix:sim.mixValues};
    assert.equal(sim.proc.process(ins,outs,parameters),true);
    const n=Math.min(BLOCK,frames-b*BLOCK);
    out[0].set(outs[0][0].subarray(0,n),b*BLOCK);out[1].set(outs[0][1].subarray(0,n),b*BLOCK);
  }
  return out;
}

for(const rate of [48000,44100]){
  test(`bundled tunejs-dsp delay processor matches the fixture expectation at ${rate}`,()=>{
    const sim=simulateWorklet({kind:'delay',delayFrames:Math.round(delayTapSeconds*rate),taps:delayTapCount,feedback:0.5,mix:0},rate);
    const out=runProcessor(sim,rate);
    const expected=delayFixtureExpected(rate);
    for(let c=0;c<2;c++)for(let i=0;i<rate;i++)close(out[c][i],expected[i],1e-5);
  });
  test(`bundled tunejs-dsp convolver processor matches the fixture expectation at ${rate}`,()=>{
    const frames=Math.round(convolverSeconds*rate);
    const response=convolverSeeds.map(seed=>syntheticImpulseResponse(frames,seed));
    const sim=simulateWorklet({kind:'convolver',response,mix:0},rate);
    const out=runProcessor(sim,rate);
    const expected=dspConvolverFixtureExpected(rate);
    for(let c=0;c<2;c++)for(let i=0;i<rate;i++)close(out[c][i],expected[c][i],1e-5);
  });
}

test('worklet processor returns false after close',()=>{
  const sim=simulateWorklet({kind:'delay',delayFrames:16,taps:1,feedback:0.5,mix:1},48000);
  sim.proc.port.onmessage({data:{close:true}});
  const ins=[[new Float32Array(BLOCK)]];
  const outs=[[new Float32Array(BLOCK),new Float32Array(BLOCK)]];
  assert.equal(sim.proc.process(ins,outs,{mix:[1]}),false);
});
