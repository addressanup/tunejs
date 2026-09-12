// Synthetic graph tap feasibility only. Fixed 10 seconds, no microphone/device claims.
class CaptureFixture extends AudioWorkletProcessor {
  constructor() { super(); this.frames=0; this.chunk=new Float32Array(1024); this.fill=0; this.sequence=0; this.start=null; }
  process(inputs, outputs) {
    const out=outputs[0][0];
    for(let i=0;i<out.length && this.frames<sampleRate*10;i++) {
      if(this.start===null) this.start=currentFrame+i;
      const x=Math.sin(2*Math.PI*432*this.frames/sampleRate)*0.1;
      this.chunk[this.fill++]=x; this.frames++;
      if(this.fill===1024 || this.frames===sampleRate*10) {
        const data=this.chunk.slice(0,this.fill);
        this.port.postMessage({sequence:this.sequence++,startFrame:this.start,sampleRate,channels:[data],droppedFramesBefore:0},[data.buffer]);
        this.fill=0; this.start=null;
      }
    }
    // Synthetic source is deliberately not monitored.
    if(this.frames===sampleRate*10) { this.port.postMessage({done:true,frames:this.frames}); return false; }
    return true;
  }
}
registerProcessor('capture-fixture',CaptureFixture);
