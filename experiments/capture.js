export class BoundedChunks {
  constructor(maxFrames) { this.maxFrames=maxFrames; this.frames=0; this.queue=[]; this.dropped=0; this.peak=0; }
  push(chunk) {
    const size=chunk.channels[0].length;
    if(size>this.maxFrames) throw new Error('chunk exceeds queue capacity');
    while(this.frames+size>this.maxFrames) { const old=this.queue.shift(); this.frames-=old.channels[0].length; this.dropped+=old.channels[0].length; }
    this.queue.push(chunk); this.frames+=size; this.peak=Math.max(this.peak,this.frames);
  }
  shift() {
    const chunk=this.queue.shift(); if(!chunk) return;
    this.frames-=chunk.channels[0].length; const result={...chunk,droppedFramesBefore:chunk.droppedFramesBefore+this.dropped}; this.dropped=0; return result;
  }
}
export async function captureFixture() {
  const context=new AudioContext({sampleRate:48000});
  const activation=context.resume();
  try {
    await activation; await context.audioWorklet.addModule('/experiments/capture-worklet.js');
    const node=new AudioWorkletNode(context,'capture-fixture'); node.connect(context.destination);
    const queue=new BoundedChunks(4096); let frames=0,lastEnd=null,chunks=0,gaps=0,gapDetails=[];
    return await new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{node.disconnect();reject(new Error('capture timeout'));},15000);
      node.port.onmessage=({data})=>{
        if(data.done) {
          clearTimeout(timer); node.disconnect(); node.port.close();
          const retained=queue.frames; const next=queue.shift();
          resolve({status:frames===480000 && gaps===0 && next.droppedFramesBefore+retained===480000?'pass':'fail',frames,chunks,gaps,gapDetails,queuedPeak:queue.peak,forcedSlowConsumerDropped:next.droppedFramesBefore,scope:'synthetic AudioWorklet PCM; no physical microphone, no live TuneJS tap API'}); return;
        }
        if(lastEnd!==null && data.startFrame!==lastEnd) { gaps++; gapDetails.push({sequence:data.sequence,expected:lastEnd,received:data.startFrame}); }
        lastEnd=data.startFrame+data.channels[0].length; frames+=data.channels[0].length; chunks++;
        queue.push(data);
      };
    });
  } finally { await context.close(); }
}
