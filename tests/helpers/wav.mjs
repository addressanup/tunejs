// Minimal RIFF/WAVE writer for fixtures. `format` is 'pcm8' | 'pcm16' | 'pcm24' | 'pcm32' | 'float32';
// `extensible` wraps the fmt chunk as WAVE_FORMAT_EXTENSIBLE (tag 0xFFFE with a PCM/float sub-format GUID).
export function wav(channels, sampleRate, format, {extensible=false, leadingChunk=false, truncateData=0, dataSizeOverride=null}={}) {
  const bits={pcm8:8,pcm16:16,pcm24:24,pcm32:32,float32:32}[format];
  const isFloat=format==='float32';
  const frames=channels[0].length, block=channels.length*bits/8;
  const fmtSize=extensible?40:16;
  const dataBytes=frames*block;
  const extra=leadingChunk?8+4:0;
  const total=12+8+fmtSize+extra+8+dataBytes-truncateData;
  const buffer=new ArrayBuffer(total), view=new DataView(buffer), bytes=new Uint8Array(buffer);
  const ascii=(offset,text)=>{for(let i=0;i<text.length;i++) bytes[offset+i]=text.charCodeAt(i);};
  let o=0;
  ascii(o,'RIFF'); view.setUint32(o+4,total-8,true); ascii(o+8,'WAVE'); o+=12;
  if(leadingChunk) { ascii(o,'LIST'); view.setUint32(o+4,4,true); ascii(o+8,'INFO'); o+=12; }
  ascii(o,'fmt '); view.setUint32(o+4,fmtSize,true);
  view.setUint16(o+8,extensible?0xFFFE:(isFloat?3:1),true);
  view.setUint16(o+10,channels.length,true);
  view.setUint32(o+12,sampleRate,true);
  view.setUint32(o+16,sampleRate*block,true);
  view.setUint16(o+20,block,true);
  view.setUint16(o+22,bits,true);
  if(extensible) {
    view.setUint16(o+24,22,true); view.setUint16(o+26,bits,true); view.setUint32(o+28,0,true);
    // KSDATAFORMAT_SUBTYPE_PCM / IEEE_FLOAT: first two bytes are the format tag, remainder is the fixed GUID tail.
    view.setUint16(o+32,isFloat?3:1,true); view.setUint16(o+34,0,true);
    bytes.set([0x00,0x00,0x10,0x00,0x80,0x00,0x00,0xAA,0x00,0x38,0x9B,0x71],o+36);
  }
  o+=8+fmtSize;
  ascii(o,'data'); view.setUint32(o+4,dataSizeOverride??dataBytes,true); o+=8;
  for(let frame=0;frame<frames;frame++) for(const data of channels) {
    if(o+bits/8>total) break;
    const x=data[frame];
    if(format==='pcm8') view.setUint8(o,x);
    else if(format==='pcm16') view.setInt16(o,x,true);
    else if(format==='pcm24') { const v=x<0?x+0x1000000:x; bytes[o]=v&255; bytes[o+1]=(v>>8)&255; bytes[o+2]=(v>>16)&255; }
    else if(format==='pcm32') view.setInt32(o,x,true);
    else view.setFloat32(o,x,true);
    o+=bits/8;
  }
  return buffer;
}
