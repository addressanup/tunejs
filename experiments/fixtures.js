// Identical graph fixtures run against browser and RN OfflineAudioContext factories.
// Fixed pre-run tolerances: arithmetic 1e-5; onset <= 1 sample; repeatability 1e-7.
export const fixtureVersion = 2;
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
export async function renderFixture(createOffline, kind, rate=48000, pan=-0.75) {
  const length = rate;
  const context = createOffline({ numberOfChannels: 2, length, sampleRate: rate });
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
    for(const frame of impulseFrames) { const tick=context.createBufferSource();tick.buffer=impulse;tick.connect(gain);tick.start(frame/rate); }
  } else source.start(0);
  const start=performance.now(); const output=await context.startRendering();
  return { channels:[output.getChannelData(0),output.getChannelData(1)], renderMs:performance.now()-start };
}
export async function runFixtures(createOffline) {
  const results=[];
  for(const rate of [44100,48000]) for(const kind of ['timing','filter','pan','hrtf']) {
    try {
      const output=await renderFixture(createOffline,kind,rate);
      if(output.unavailable) { results.push({kind,rate,status:'unavailable',reason:output.unavailable}); continue; }
      const repeat=await renderFixture(createOffline,kind,rate);
      const stats=summarize(output.channels);
      const repeatError=Math.max(...output.channels.map((x,i)=>maxError(x,repeat.channels[i])));
      let arithmeticError=null, mirrorError=null, observedOnsets=null, timing=null;
      if(kind==='timing') {
        const expected=new Float32Array(rate);
        for(const frame of impulseFrames) expected[frame]=0.25+0.25*Math.min(frame/1024,1);
        arithmeticError=Math.max(...output.channels.map(x=>maxError(x,expected)));
        timing=analyzeTimingFixture(output.channels);
        observedOnsets=timing.channels[0].observedOnsets;
      }
      if(kind==='pan') {
        const mirror=await renderFixture(createOffline,kind,rate,0.75);
        mirrorError=maxError(output.channels[0],mirror.channels[1]);
        const angle=0.25*Math.PI/4;
        const expected=Float32Array.from({length:rate},(_,i)=>Math.fround(Math.sin(2*Math.PI*432*i/rate))*0.25*Math.cos(angle));
        arithmeticError=maxError(output.channels[0],expected);
      }
      const pass=stats.every(x=>x.nonfinite===0 && x.peak>0) && repeatError<=1e-7 && (arithmeticError===null || arithmeticError<=1e-5) && (mirrorError===null || mirrorError<=1e-5);
      results.push({kind,rate,status:pass?'pass':'fail',stats,repeatError,arithmeticError,mirrorError,observedOnsets,timing,renderMs:output.renderMs,
        scope:kind==='hrtf'?'finite/nonzero/repeated fixed pose only; NOT localization/reference acceptance':kind==='filter'?'finite/repeatable smoke; NOT cross-backend reference acceptance':'arithmetic fixture'});
    } catch(error) { results.push({kind,rate,status:'error',error:String(error)}); }
  }
  return {fixtureVersion,results};
}
