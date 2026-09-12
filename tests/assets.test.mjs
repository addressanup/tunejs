import {test} from 'node:test';
import assert from 'node:assert/strict';
import {decodeWav, resample} from '../dist/assets.js';
import {TuneError} from '../dist/index.js';
import {wav} from './helpers/wav.mjs';

const code=expected=>error=>error instanceof TuneError && error.code===expected;

test('decodeWav maps integer PCM widths to the documented float ranges',()=>{
  const int16=[Int16Array.from([-32768,-1,0,1,32767,12345]),Int16Array.from([32767,0,-32768,5,-5,-12345])];
  const decoded=decodeWav(wav(int16,48000,'pcm16'));
  assert.equal(decoded.sampleRate,48000); assert.equal(decoded.channels.length,2); assert.equal(decoded.frames,6);
  assert.deepEqual([...decoded.channels[0]],[-1,-1/32768,0,1/32768,32767/32768,12345/32768].map(Math.fround));
  assert.deepEqual([...decoded.channels[1]],[32767/32768,0,-1,5/32768,-5/32768,-12345/32768].map(Math.fround));
  const int8=decodeWav(wav([Uint8Array.from([0,128,255,64])],8000,'pcm8'));
  assert.deepEqual([...int8.channels[0]],[-1,0,127/128,-0.5].map(Math.fround));
  const int24=decodeWav(wav([Int32Array.from([-8388608,0,8388607,-1])],44100,'pcm24'));
  assert.deepEqual([...int24.channels[0]],[-1,0,8388607/8388608,-1/8388608].map(Math.fround));
  const int32=decodeWav(wav([Int32Array.from([-2147483648,0,2147483647])],44100,'pcm32'));
  assert.deepEqual([...int32.channels[0]],[-1,0,2147483647/2147483648].map(Math.fround));
  const float=decodeWav(wav([Float32Array.from([0.25,-0.5,1.5])],96000,'float32'));
  assert.deepEqual([...float.channels[0]],[0.25,-0.5,1.5]);
  assert.equal(float.sampleRate,96000);
});

test('decodeWav accepts extensible headers, skips foreign chunks, and accepts views into larger buffers',()=>{
  const data=[Int16Array.from([100,-100,200]),Int16Array.from([-300,300,0])];
  const extensible=decodeWav(wav(data,44100,'pcm16',{extensible:true,leadingChunk:true}));
  assert.deepEqual([...extensible.channels[0]],[100/32768,-100/32768,200/32768].map(Math.fround));
  assert.deepEqual([...extensible.channels[1]],[-300/32768,300/32768,0].map(Math.fround));
  const floatExtensible=decodeWav(wav([Float32Array.from([0.5,-0.25])],48000,'float32',{extensible:true}));
  assert.deepEqual([...floatExtensible.channels[0]],[0.5,-0.25]);
  const raw=new Uint8Array(wav(data,44100,'pcm16'));
  const padded=new Uint8Array(raw.length+7); padded.set(raw,3);
  const view=decodeWav(new Uint8Array(padded.buffer,3,raw.length));
  assert.deepEqual([...view.channels[1]],[...extensible.channels[1]]);
});

test('decodeWav rejects malformed or unsupported files with ASSET_FAILED and never returns partial data',()=>{
  const good=wav([Int16Array.from([1,2,3,4])],48000,'pcm16');
  const corrupt=(mutate)=>{const copy=new Uint8Array(good.slice(0)); mutate(copy,new DataView(copy.buffer)); return copy;};
  assert.throws(()=>decodeWav(corrupt(bytes=>{bytes[0]=0x58;})),code('ASSET_FAILED'));                 // not RIFF
  assert.throws(()=>decodeWav(corrupt(bytes=>{bytes[8]=0x58;})),code('ASSET_FAILED'));                 // not WAVE
  assert.throws(()=>decodeWav(corrupt((_,view)=>{view.setUint16(20,7,true);})),code('ASSET_FAILED'));   // mu-law
  assert.throws(()=>decodeWav(corrupt((_,view)=>{view.setUint16(22,0,true);})),code('ASSET_FAILED'));   // zero channels
  assert.throws(()=>decodeWav(corrupt((_,view)=>{view.setUint32(24,0,true);})),code('ASSET_FAILED'));   // zero sample rate
  assert.throws(()=>decodeWav(corrupt((_,view)=>{view.setUint16(34,12,true);})),code('ASSET_FAILED'));  // unsupported bit depth
  assert.throws(()=>decodeWav(corrupt(bytes=>{bytes[36]=0x78;})),code('ASSET_FAILED'));                // no data chunk
  assert.throws(()=>decodeWav(wav([Int16Array.from([1,2,3,4])],48000,'pcm16',{truncateData:3})),code('ASSET_FAILED'));
  assert.throws(()=>decodeWav(wav([Int16Array.from([1,2,3,4])],48000,'pcm16',{dataSizeOverride:0xFFFFFFFF})),code('ASSET_FAILED'));
  assert.throws(()=>decodeWav(new Uint8Array(11)),code('ASSET_FAILED'));
  assert.throws(()=>decodeWav('not bytes'),code('INVALID_VALUE'));
  const empty=decodeWav(wav([Int16Array.from([])],48000,'pcm16'));
  assert.equal(empty.frames,0); assert.equal(empty.channels[0].length,0);
});

// Interior tolerance 1e-5 matches the specification's shared arithmetic tolerance; the first/last 32
// output samples are edge-clamped and excluded. Both directions of the 44.1/48 kHz pair are checked.
test('resample is deterministic, preserves constants, and reproduces tones within 1e-5 in both directions',()=>{
  const frames=44100;
  const tone=Float32Array.from({length:frames},(_,i)=>Math.sin(2*Math.PI*432*i/44100));
  const same=resample([tone],44100,44100);
  assert.notEqual(same[0],tone); assert.deepEqual([...same[0]],[...tone]);
  const up=resample([tone,tone],44100,48000);
  assert.equal(up.length,2); assert.equal(up[0].length,48000);
  let error=0;
  for(let n=32;n<48000-32;n++) error=Math.max(error,Math.abs(up[0][n]-Math.sin(2*Math.PI*432*n/48000)));
  assert.ok(error<=1e-5,`interior 432 Hz upsample error ${error}`);
  assert.deepEqual([...up[1]],[...up[0]]);
  const again=resample([tone],44100,48000);
  assert.deepEqual([...again[0]],[...up[0]]);
  const high=Float32Array.from({length:48000},(_,i)=>Math.sin(2*Math.PI*5000*i/48000));
  const downHigh=resample([high],48000,44100);
  assert.equal(downHigh[0].length,44100);
  error=0;
  for(let n=32;n<44100-32;n++) error=Math.max(error,Math.abs(downHigh[0][n]-Math.sin(2*Math.PI*5000*n/44100)));
  assert.ok(error<=1e-5,`interior 5 kHz downsample error ${error}`);
  const down=resample([tone],44100,22050);
  assert.equal(down[0].length,22050);
  const constant=resample([new Float32Array(1000).fill(0.5)],48000,44100);
  assert.equal(constant[0].length,Math.round(1000*44100/48000));
  for(const x of constant[0]) assert.ok(Math.abs(x-0.5)<=1e-6);
  const silence=resample([new Float32Array(500)],48000,96000);
  assert.ok(silence[0].every(x=>x===0)); assert.equal(silence[0].length,1000);
  assert.throws(()=>resample([tone],0,48000),code('INVALID_VALUE'));
  assert.throws(()=>resample([],44100,48000),code('INVALID_VALUE'));
  assert.throws(()=>resample([tone,new Float32Array(10)],44100,48000),code('INVALID_VALUE'));
});
