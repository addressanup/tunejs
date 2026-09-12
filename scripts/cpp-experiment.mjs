import {execFileSync} from 'node:child_process';
import {readFile,writeFile,mkdir,stat} from 'node:fs/promises';
import {homedir} from 'node:os';
import {summarize,maxError,impulseFrames} from '../experiments/fixtures.js';
await mkdir('artifacts',{recursive:true});
const cpp='experiments/render.cpp';
execFileSync('clang++',['-O2','-std=c++17',cpp,'-o','artifacts/render-native']);
const ndk=process.env.TUNEJS_LLVM ?? `${homedir()}/Library/Android/sdk/ndk/27.1.12297006/toolchains/llvm/prebuilt/darwin-x86_64/bin`;
execFileSync(`${ndk}/clang++`,['--target=wasm32','-O2','-nostdlib','-Wl,--no-entry','-Wl,--export=render','-Wl,--export-memory','-Wl,--allow-undefined',cpp,'-o','artifacts/render.wasm']);
const bytes=await readFile('artifacts/render.wasm');
const {instance}=await WebAssembly.instantiate(bytes,{env:{sin:Math.sin,cos:Math.cos}});
const results=[];
for(const rate of [44100,48000])for(const [kind,name] of ['timing','filter','pan'].entries()) {
 const before=performance.now();const native=execFileSync('./artifacts/render-native',[String(kind),String(rate),'-0.75']);const processWallMs=performance.now()-before;
 const nativeFloats=new Float32Array(native.buffer,native.byteOffset,native.byteLength/4);
 const start=performance.now();const ptr=instance.exports.render(kind,rate,-0.75);const wasmMs=performance.now()-start;
 const wasm=new Float32Array(instance.exports.memory.buffer,ptr,rate*2).slice();
 const error=maxError(nativeFloats,wasm);
 let arithmeticError=null;
 if(kind===0) { const expected=new Float32Array(rate);for(const f of impulseFrames)expected[f]=.25+.25*Math.min(f/1024,1);arithmeticError=maxError(expected,wasm.subarray(0,rate)); }
 results.push({kind:name,rate,nativeWasmError:error,arithmeticError,status:error<=1e-5 && (arithmeticError===null||arithmeticError<=1e-5)?'pass':'fail',stats:summarize([wasm.subarray(0,rate),wasm.subarray(rate)]),nativeProcessWallMs:processWallMs,wasmRenderMs:wasmMs});
 await writeFile(`artifacts/cpp-${name}-${rate}.f32`,native);
}
const report={date:new Date().toISOString(),scope:'same C++ offline kernel compiled to macOS arm64 and WASM; no device callback, RN JSI, HRTF, capture or worklet runtime',nativeExecutableBytes:(await stat('artifacts/render-native')).size,wasmBytes:bytes.length,results};
await writeFile('artifacts/cpp-results.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
if(results.some(r=>r.status!=='pass'))process.exitCode=1;
