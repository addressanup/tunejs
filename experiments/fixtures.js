// Identical graph fixtures run against browser and RN OfflineAudioContext factories.
// Fixed pre-run tolerances: arithmetic 1e-5; onset <= 1 sample; repeatability 1e-7.
// Version 3 adds an explicit scheduling conversion: `hostTime(frame, rate)` maps a target frame to the
// seconds value handed to the host. The default is raw `frame / rate`; adapters may supply their own.
// Version 4 adds the delay-chain and convolver-identity mixing fixtures (tolerance 1e-5, see below).
// Version 5 adds graph-topology probes (single delay, source fan-out, destination fan-in) and a convolver fit diagnostic.
export const fixtureVersion = 5;
export const rawSeconds = (frame, rate) => frame / rate;
export const impulseFrames = [0, 127, 128, 129, 511, 1023, 1024, 8000, 16000, 24000, 32000, 40000];
export function summarize(channels) {
  return channels.map(data => {
    let energy = 0, peak = 0, nonfinite = 0;
    for (const x of data) { if (!Number.isFinite(x)) nonfinite++; energy += x*x; peak = Math.max(peak, Math.abs(x)); }
    return { frames: data.length, rms: Math.sqrt(energy/data.length), peak, nonfinite };
  });
}
export function maxError(a,b) {
  if(a.length!==b.length) throw new RangeError('PCM buffers must have equal frame counts.');
  let error=0;
  for(let i=0;i<a.length;i++) {
    if(!Number.isFinite(a[i]) || !Number.isFinite(b[i])) throw new RangeError('PCM comparison requires finite samples.');
    error=Math.max(error,Math.abs(a[i]-b[i]));
  }
  return error;
}
export function analyzeTimingFixture(channels) {
  if(channels.length!==2 || !channels[0] || !channels[1] || channels[0].length!==channels[1].length || channels[0].length<=impulseFrames[impulseFrames.length-1]) {
    throw new RangeError('Timing fixtures require two equal-length channels containing the complete impulse range.');
  }
  const results=channels.map(data=>{
    const observedOnsets=[];
    let gainErrorAtActualOnset=0;
    for(let frame=0;frame<data.length;frame++) {
      const value=data[frame];
      if(!Number.isFinite(value)) throw new RangeError('Timing fixtures require finite PCM.');
      if(value!==0) {
        observedOnsets.push({frame,value});
        const expectedGain=Math.fround(0.25+0.25*Math.min(frame/1024,1));
        gainErrorAtActualOnset=Math.max(gainErrorAtActualOnset,Math.abs(value-expectedGain));
      }
    }
    const countMatches=observedOnsets.length===impulseFrames.length;
    const frameOffsets=countMatches?observedOnsets.map((onset,index)=>onset.frame-impulseFrames[index]):null;
    const maxOnsetErrorFrames=frameOffsets?frameOffsets.reduce((max,offset)=>Math.max(max,Math.abs(offset)),0):null;
    return {expectedCount:impulseFrames.length,observedCount:observedOnsets.length,observedOnsets,frameOffsets,maxOnsetErrorFrames,gainErrorAtActualOnset};
  });
  return {onsetStatus:results.every(result=>result.maxOnsetErrorFrames!==null && result.maxOnsetErrorFrames<=1)?'pass':'fail',toleranceFrames:1,channels:results};
}
// Version 4 mixing fixtures. Delay chain: one impulse through three chained 10 ms DelayNodes with tap gains
// 0.5^k plus the dry path; expected impulses at 0, D, 2D, 3D frames (D = 0.01 * rate, an integer at both rates).
export const delayTapSeconds = 0.01, delayTapCount = 3;
export function delayFixtureExpected(rate) {
  const D=Math.round(delayTapSeconds*rate);
  if(D!==delayTapSeconds*rate) throw new RangeError('Delay fixture needs an integer tap length at this sample rate.');
  const expected=new Float32Array(rate);
  for(let k=0;k<=delayTapCount;k++) expected[k*D]=Math.fround(0.5**k);
  return expected;
}
// Convolver identity: a single impulse through a ConvolverNode (normalize=false) must reproduce the stereo
// impulse response sample-for-sample. The response is seeded noise with a -60 dB exponential decay over 0.25 s.
export const convolverSeeds = [1234, 5678], convolverSeconds = 0.25;
export function mulberry32(seed) {
  let state=seed>>>0;
  return ()=>{ state=(state+0x6D2B79F5)>>>0; let t=state; t=Math.imul(t^(t>>>15),t|1); t^=t+Math.imul(t^(t>>>7),t|61); return ((t^(t>>>14))>>>0)/4294967296; };
}
export function syntheticImpulseResponse(frames, seed) {
  if(!Number.isSafeInteger(frames) || frames<=0 || !Number.isSafeInteger(seed)) throw new RangeError('Impulse response needs a positive integer length and an integer seed.');
  const random=mulberry32(seed), data=new Float32Array(frames);
  for(let i=0;i<frames;i++) data[i]=(random()*2-1)*Math.exp(-3*Math.LN10*i/frames);
  return data;
}
export function convolverFixtureExpected(rate) {
  const frames=Math.round(convolverSeconds*rate);
  return convolverSeeds.map(seed=>{ const expected=new Float32Array(rate); expected.set(syntheticImpulseResponse(frames,seed)); return expected; });
}
// Version 5 topology probes isolate the native delay-chain failure: one DelayNode alone (impulse at D, value 1),
// source fan-out to two gains (1 + 0.5 at frame 0), and two sources fanning directly into the destination (2 at frame 0).
export const topologyKinds = ['delayonly','fanout','fanin'];
export function topologyFixtureExpected(kind, rate) {
  const expected=new Float32Array(rate);
  if(kind==='delayonly') expected[Math.round(delayTapSeconds*rate)]=1;
  else if(kind==='fanout') expected[0]=1.5;
  else if(kind==='fanin') expected[0]=2;
  else throw new RangeError(`Unknown topology fixture ${kind}.`);
  return expected;
}
// Convolver fit: best scale and integer lag (±8 frames) between output and the supplied response, plus the residual
// after removing them. Diagnostic only; the strict identity comparison decides the status.
export function convolverFit(output, expected) {
  let best=null;
  for(let lag=-8;lag<=8;lag++) {
    let dot=0, energy=0;
    for(let i=0;i<expected.length;i++) { const j=i+lag; if(j<0||j>=output.length) continue; dot+=output[j]*expected[i]; energy+=expected[i]*expected[i]; }
    const scale=energy?dot/energy:0;
    let residual=0;
    for(let i=0;i<expected.length;i++) { const j=i+lag; const value=j<0||j>=output.length?0:output[j]; residual=Math.max(residual,Math.abs(value-scale*expected[i])); }
    if(!best || residual<best.residual) best={lagFrames:lag,scale,residual};
  }
  return best;
}
async function renderMixing(context, kind, rate, hostTime) {
  const impulse=context.createBuffer(1,1,rate); impulse.getChannelData(0)[0]=1;
  const source=context.createBufferSource(); source.buffer=impulse;
  if(kind==='delayonly') {
    if(typeof context.createDelay!=='function') return { unavailable:'DelayNode absent' };
    const D=Math.round(delayTapSeconds*rate);
    const delay=context.createDelay(delayTapSeconds); delay.delayTime.setValueAtTime(D/rate,0);
    source.connect(delay); delay.connect(context.destination);
  } else if(kind==='fanout') {
    const a=context.createGain(); a.gain.setValueAtTime(1,0); const b=context.createGain(); b.gain.setValueAtTime(0.5,0);
    source.connect(a); source.connect(b); a.connect(context.destination); b.connect(context.destination);
  } else if(kind==='fanin') {
    const second=context.createBufferSource(); second.buffer=impulse;
    source.connect(context.destination); second.connect(context.destination);
    second.start(hostTime(0,rate));
  } else if(kind==='delay') {
    if(typeof context.createDelay!=='function') return { unavailable:'DelayNode absent' };
    const D=Math.round(delayTapSeconds*rate);
    const dry=context.createGain(); dry.gain.setValueAtTime(1,0); source.connect(dry); dry.connect(context.destination);
    let previous=source;
    for(let k=1;k<=delayTapCount;k++) {
      const delay=context.createDelay(delayTapSeconds); delay.delayTime.setValueAtTime(D/rate,0);
      const tap=context.createGain(); tap.gain.setValueAtTime(0.5**k,0);
      previous.connect(delay); delay.connect(tap); tap.connect(context.destination); previous=delay;
    }
  } else {
    if(typeof context.createConvolver!=='function') return { unavailable:'ConvolverNode absent' };
    const frames=Math.round(convolverSeconds*rate);
    const response=context.createBuffer(2,frames,rate);
    convolverSeeds.forEach((seed,channel)=>response.getChannelData(channel).set(syntheticImpulseResponse(frames,seed)));
    const convolver=context.createConvolver(); convolver.normalize=false; convolver.buffer=response;
    source.connect(convolver); convolver.connect(context.destination);
  }
  source.start(hostTime(0,rate));
  const start=performance.now(); const output=await context.startRendering();
  return { channels:[output.getChannelData(0),output.getChannelData(1)], renderMs:performance.now()-start };
}
export async function renderFixture(createOffline, kind, rate=48000, pan=-0.75, hostTime=rawSeconds) {
  if(typeof hostTime !== 'function') throw new TypeError('hostTime must be a function (frame, rate) => seconds.');
  const length = rate;
  const context = createOffline({ numberOfChannels: 2, length, sampleRate: rate });
  if(kind === 'delay' || kind === 'convolver' || topologyKinds.includes(kind)) return renderMixing(context, kind, rate, hostTime);
  const buffer = context.createBuffer(1, length, rate);
  const samples = buffer.getChannelData(0);
  if(kind === 'timing') { for(const frame of impulseFrames) samples[frame]=1; }
  else for(let i=0;i<length;i++) samples[i]=Math.sin(2*Math.PI*432*i/rate);
  const source = context.createBufferSource(); source.buffer=buffer;
  const gain = context.createGain(); gain.gain.setValueAtTime(0.25,0);
  if(kind === 'timing') gain.gain.linearRampToValueAtTime(0.5,1024/rate);
  source.connect(gain); let tail=gain;
  if(kind === 'filter') { const filter=context.createBiquadFilter(); filter.type='lowpass'; filter.frequency.setValueAtTime(1200,0); filter.Q.setValueAtTime(0,0); tail.connect(filter); tail=filter; }
  if(kind === 'pan') { const panner=context.createStereoPanner(); panner.pan.setValueAtTime(pan,0); tail.connect(panner); tail=panner; }
  if(kind === 'hrtf') {
    if(typeof context.createPanner !== 'function') return { unavailable:'PannerNode/AudioListener absent' };
    const panner=context.createPanner(); panner.panningModel='HRTF'; panner.setPosition(pan,0,-1); tail.connect(panner); tail=panner;
  }
  tail.connect(context.destination);
  if(kind === 'timing') {
    source.disconnect();
    const impulse=context.createBuffer(1,1,rate); impulse.getChannelData(0)[0]=1;
    for(const frame of impulseFrames) { const tick=context.createBufferSource();tick.buffer=impulse;tick.connect(gain);tick.start(hostTime(frame,rate)); }
  } else source.start(hostTime(0,rate));
  const start=performance.now(); const output=await context.startRendering();
  return { channels:[output.getChannelData(0),output.getChannelData(1)], renderMs:performance.now()-start };
}
export async function runFixtures(createOffline, options={}) {
  const hostTime=options.hostTime ?? rawSeconds;
  const scheduling=options.scheduling ?? (options.hostTime ? 'custom' : 'raw-seconds');
  if(typeof hostTime !== 'function' || typeof scheduling !== 'string' || !scheduling) throw new TypeError('runFixtures options require a hostTime function and a nonempty scheduling label.');
  const results=[];
  for(const rate of [44100,48000]) for(const kind of ['timing','filter','pan','hrtf','delay','convolver',...topologyKinds]) {
    try {
      const output=await renderFixture(createOffline,kind,rate,-0.75,hostTime);
      if(output.unavailable) { results.push({kind,rate,status:'unavailable',reason:output.unavailable}); continue; }
      const repeat=await renderFixture(createOffline,kind,rate,-0.75,hostTime);
      const stats=summarize(output.channels);
      const repeatError=Math.max(...output.channels.map((x,i)=>maxError(x,repeat.channels[i])));
      let arithmeticError=null, mirrorError=null, observedOnsets=null, timing=null, fit=null;
      if(kind==='timing') {
        const expected=new Float32Array(rate);
        for(const frame of impulseFrames) expected[frame]=0.25+0.25*Math.min(frame/1024,1);
        arithmeticError=Math.max(...output.channels.map(x=>maxError(x,expected)));
        timing=analyzeTimingFixture(output.channels);
        observedOnsets=timing.channels[0].observedOnsets;
      }
      if(kind==='pan') {
        const mirror=await renderFixture(createOffline,kind,rate,0.75,hostTime);
        mirrorError=maxError(output.channels[0],mirror.channels[1]);
        const angle=0.25*Math.PI/4;
        const expected=Float32Array.from({length:rate},(_,i)=>Math.fround(Math.sin(2*Math.PI*432*i/rate))*0.25*Math.cos(angle));
        arithmeticError=maxError(output.channels[0],expected);
      }
      if(kind==='delay') {
        const expected=delayFixtureExpected(rate);
        arithmeticError=Math.max(...output.channels.map(x=>maxError(x,expected)));
        observedOnsets=[];
        for(let frame=0;frame<output.channels[0].length && observedOnsets.length<8;frame++) if(output.channels[0][frame]!==0) observedOnsets.push({frame,value:output.channels[0][frame]});
      }
      if(kind==='convolver') {
        const expected=convolverFixtureExpected(rate);
        arithmeticError=Math.max(...output.channels.map((x,i)=>maxError(x,expected[i])));
        fit=output.channels.map((x,i)=>convolverFit(x,expected[i].subarray(0,Math.round(convolverSeconds*rate))));
      }
      if(topologyKinds.includes(kind)) {
        const expected=topologyFixtureExpected(kind,rate);
        arithmeticError=Math.max(...output.channels.map(x=>maxError(x,expected)));
        observedOnsets=[];
        for(let frame=0;frame<output.channels[0].length && observedOnsets.length<8;frame++) if(output.channels[0][frame]!==0) observedOnsets.push({frame,value:output.channels[0][frame]});
      }
      const pass=stats.every(x=>x.nonfinite===0 && x.peak>0) && repeatError<=1e-7 && (arithmeticError===null || arithmeticError<=1e-5) && (mirrorError===null || mirrorError<=1e-5);
      results.push({kind,rate,status:pass?'pass':'fail',stats,repeatError,arithmeticError,mirrorError,observedOnsets,timing,fit,renderMs:output.renderMs,
        scope:kind==='hrtf'?'finite/nonzero/repeated fixed pose only; NOT localization/reference acceptance':kind==='filter'?'finite/repeatable smoke; NOT cross-backend reference acceptance':kind==='convolver'?'impulse-response identity through the host convolver; NOT a reverb quality judgement':topologyKinds.includes(kind)?'graph topology probe':'arithmetic fixture'});
    } catch(error) { results.push({kind,rate,status:'error',error:String(error)}); }
  }
  return {fixtureVersion,scheduling,results};
}
