import {test} from 'node:test';
import assert from 'node:assert/strict';
import * as probes from '../experiments/live-probes.js';

// Ideal live host: sums inputs, delays by whole frames, and lets the analyser observe the last window.
// `mode` controls simultaneous-input combination ('sum' | 'single' | 'double'); `fanout` = 'all' | 'last' controls
// whether a node with several outgoing edges feeds all of them or only the last one; `delayWorks` toggles DelayNode.
function liveHost({sampleRate=48000,mode='sum',fanout='all',delayWorks=true}={}) {
  const nodes=[];
  const node=(kind,extra={})=>{const n={kind,inputs:[],targets:[],connect(t){this.targets.push(t);t.inputs.push(this);},disconnect(){for(const t of this.targets) t.inputs=t.inputs.filter(i=>i!==this);this.targets=[];},...extra};nodes.push(n);return n;};
  const param=value=>({value,setValueAtTime(v){this.value=v;}});
  const destination=node('destination');
  const render=(n,frames,offset)=>{
    if(n.kind==='constant') return n.started?new Float32Array(frames).fill(n.offset.value):new Float32Array(frames);
    if(n.kind==='source') { const out=new Float32Array(frames); if(n.started) for(let i=0;i<frames;i++) out[i]=n.buffer.data[(offset+i)%n.buffer.data.length]; return out; }
    const live=n.inputs.filter(input=>fanout==='all' || input.targets[input.targets.length-1]===n);
    const inputs=live.map(input=>render(input,frames,offset));
    const combined=new Float32Array(frames);
    if(inputs.length) {
      // Defective modes only differ when a node has several simultaneous inputs.
      if(mode==='sum' || inputs.length===1) for(const input of inputs) for(let i=0;i<frames;i++) combined[i]+=input[i];
      else if(mode==='single') combined.set(inputs[inputs.length-1]);
      else { combined.set(inputs[0]); for(const input of inputs) for(let i=0;i<frames;i++) combined[i]+=input[i]; }
    }
    if(n.kind==='gain') return combined.map(x=>x*n.gain.value);
    if(n.kind==='delay') { const D=delayWorks?Math.round(n.delayTime.value*sampleRate):0; const out=new Float32Array(frames); for(let i=0;i+D<frames;i++) out[i+D]=combined[i]; return out; }
    return combined;
  };
  const context={
    sampleRate,state:'suspended',destination,currentTime:0,
    async resume(){this.state='running';},
    async close(){this.state='closed';},
    createGain:()=>node('gain',{gain:param(1)}),
    createConstantSource:()=>node('constant',{offset:param(1),started:false,start(){this.started=true;},stop(){this.started=false;}}),
    createDelay:()=>node('delay',{delayTime:param(0)}),
    createBuffer(_c,frames){const data=new Float32Array(frames);return {data,getChannelData:()=>data};},
    createBufferSource:()=>node('source',{buffer:null,loop:false,started:false,start(){this.started=true;},stop(){this.started=false;}}),
    createAnalyser:()=>node('analyser',{fftSize:2048,smoothingTimeConstant:0.8,getFloatTimeDomainData(array){ const frames=array.length; array.set(render(this,frames+64,0).subarray(64)); }}),
  };
  return context;
}
const byProbe=(report,name)=>report.results.find(result=>result.probe===name);

test('live probes pass on a summing, fanning-out, delaying host',async()=>{
  const report=await probes.runLiveProbes(()=>liveHost(),{settleMs:1});
  assert.equal(report.liveProbeVersion,2);
  assert.equal(report.sampleRate,48000);
  assert.deepEqual(report.results.map(result=>result.probe),['fanin-live','fanout-live','fanout-gain-live','delay-live']);
  assert.deepEqual(report.results.map(result=>result.status),['pass','pass','pass','pass']);
  assert.equal(byProbe(report,'fanin-live').median,0.5);
  assert.equal(byProbe(report,'fanout-live').median,0.375);
  assert.equal(byProbe(report,'fanout-gain-live').median,0.375);
  const delay=byProbe(report,'delay-live');
  assert.equal(delay.expectedGapFrames,480); assert.ok(delay.pairSpacing>=1); assert.ok(delay.values.includes(1)&&delay.values.includes(0.5));
});

test('live probes fail on hosts that keep one input, keep one outgoing edge, or ignore delay',async()=>{
  const single=await probes.runLiveProbes(()=>liveHost({mode:'single'}),{settleMs:1});
  assert.equal(byProbe(single,'fanin-live').status,'fail'); assert.equal(byProbe(single,'fanin-live').median,0.25);
  const doubled=await probes.runLiveProbes(()=>liveHost({mode:'double'}),{settleMs:1});
  assert.equal(byProbe(doubled,'fanin-live').median,0.75);
  const lastEdge=await probes.runLiveProbes(()=>liveHost({fanout:'last'}),{settleMs:1});
  assert.equal(byProbe(lastEdge,'fanin-live').status,'pass');
  assert.equal(byProbe(lastEdge,'fanout-live').status,'fail'); assert.equal(byProbe(lastEdge,'fanout-live').median,0.125);
  assert.equal(byProbe(lastEdge,'fanout-gain-live').status,'fail'); assert.equal(byProbe(lastEdge,'fanout-gain-live').median,0.125);
  assert.equal(byProbe(lastEdge,'delay-live').status,'pass');
  const noDelay=await probes.runLiveProbes(()=>liveHost({delayWorks:false}),{settleMs:1});
  const delay=byProbe(noDelay,'delay-live');
  assert.equal(delay.status,'fail'); assert.equal(delay.pairSpacing,0); assert.ok(delay.values.includes(1.5));
});

test('live probes report unavailable primitives and reject a non-function factory',async()=>{
  const host=liveHost(); delete host.createConstantSource; delete host.createDelay;
  const report=await probes.runLiveProbes(()=>host,{settleMs:1});
  assert.deepEqual(report.results.map(result=>result.status),['unavailable','unavailable','unavailable','unavailable']);
  await assert.rejects(probes.runLiveProbes(null),TypeError);
});
