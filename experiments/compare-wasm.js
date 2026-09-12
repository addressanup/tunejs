import {renderFixture,maxError} from './fixtures.js';
export async function compareWasm() {
  const response=await fetch('/artifacts/render.wasm');
  if(!response.ok) throw new Error('Run npm run experiment:cpp before the WASM comparison.');
  const bytes=await response.arrayBuffer();
  const {instance}=await WebAssembly.instantiate(bytes,{env:{sin:Math.sin,cos:Math.cos}});
  const results=[];
  for(const rate of [44100,48000]) for(const [index,kind] of ['timing','filter','pan'].entries()) {
    const browser=await renderFixture(options=>new OfflineAudioContext(options),kind,rate);
    const ptr=instance.exports.render(index,rate,-0.75);
    const wasm=new Float32Array(instance.exports.memory.buffer,ptr,rate*2).slice();
    const nativeResponse=await fetch(`/artifacts/cpp-${kind}-${rate}.f32`);
    if(!nativeResponse.ok)throw new Error('Native PCM fixture is missing.');
    const native=new Float32Array(await nativeResponse.arrayBuffer());
    const browserWasmError=Math.max(...browser.channels.map((data,i)=>maxError(data,wasm.subarray(i*rate,(i+1)*rate))));
    const nativeWasmError=maxError(native,wasm);
    // 1e-5 was fixed before this comparison. This is arithmetic/one biquad only.
    results.push({kind,rate,browserWasmError,nativeWasmError,status:browserWasmError<=1e-5 && nativeWasmError<=1e-5?'pass':'fail'});
  }
  return {scope:'same PCM fixtures: browser built-ins, C++ macOS executable, C++ WASM loaded in browser; no audio-device or worklet DSP claim',moduleBytes:bytes.byteLength,results};
}
