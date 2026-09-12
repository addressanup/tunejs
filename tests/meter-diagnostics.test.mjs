import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Engine} from '../dist/index.js';
import {softKeys} from '../dist/presets.js';

function host() {
  const taps=[];
  const param=()=>({value:1,setValueAtTime(){},linearRampToValueAtTime(){},cancelScheduledValues(){}});
  const mknode=()=>({connect(){},disconnect(){}});
  const context={state:'suspended',sampleRate:48000,currentTime:0,destination:mknode(),
    createGain:()=>({...mknode(),gain:param()}),createBiquadFilter:()=>({...mknode(),type:'lowpass',frequency:param(),Q:param()}),
    createOscillator:()=>({...mknode(),type:'sine',frequency:param(),start(){},stop(){}}),createStereoPanner:()=>({...mknode(),pan:param()}),
    createBuffer:(c,f,r)=>({sampleRate:r,length:f,numberOfChannels:c,copyToChannel(){}}),createBufferSource:()=>({...mknode(),playbackRate:param(),start(){},stop(){}}),
    async resume(){this.state='running';},async suspend(){this.state='suspended';},async close(){this.state='closed';}};
  const adapter={name:'meter-double',hostLimits:{fanOut:true},createContext:()=>context,setEnded(){},hostTime:(f,r)=>f/r,
    tapping:{async createTap(_c,{chunkFrames,inFlightChunks}){
      const tap={...mknode(),inFlight:0,dropped:0,sequence:0,nextFrame:0,callback:null,
        onChunk(cb){this.callback=cb;},acknowledge(){this.inFlight=Math.max(0,this.inFlight-1);},close(){this.callback=null;},
        emit(channels){const frames=channels[0].length;const startFrame=this.nextFrame;this.nextFrame+=frames;
          if(!this.callback)return;if(this.inFlight>=inFlightChunks){this.dropped+=frames;return;}
          this.inFlight++;const droppedFramesBefore=this.dropped;this.dropped=0;
          this.callback({sequence:this.sequence++,startFrame,channels:channels.map(c=>Float32Array.from(c)),droppedFramesBefore});}};
      taps.push(tap);return tap;}}};
  return {engine:new Engine({adapter}),taps};
}
const settle=()=>new Promise(r=>setTimeout(r,0));

test('meter.diagnostics exposes the underlying tap accounting',async()=>{
  const h=host(),e=h.engine;const keys=e.instrument(softKeys);keys.connect(e.output);await e.start();
  const meter=await e.meter({source:keys});
  assert.deepEqual(meter.diagnostics,{state:'active',delivered:0,droppedFrames:0,queuedFrames:0,peakQueuedFrames:0});
  h.taps[0].emit([Float32Array.from([0.1,0.2])]);await settle();
  assert.equal(meter.diagnostics.delivered,1);
  meter.dispose();
  assert.equal(meter.diagnostics.state,'cancelled');
  await e.dispose();
});
