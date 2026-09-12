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
