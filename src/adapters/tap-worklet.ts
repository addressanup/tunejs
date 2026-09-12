// AudioWorkletProcessor source for PCM taps, loaded per context from a Blob URL. The processor
// accumulates render blocks into `chunkFrames` chunks, posts them with engine-frame timestamps,
// honours an in-flight bound (acks arrive as { ack: sequence } port messages), outputs silence so a
// muted destination path keeps it pulled, and flushes the pending drop count on close.
export const TAP_PROCESSOR_NAME = 'tunejs-tap';
export const TAP_PROCESSOR_SOURCE = `
class TuneJsTap extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const opts = (options && options.processorOptions) || {};
    this.chunkFrames = opts.chunkFrames || 1024;
    this.inFlightChunks = opts.inFlightChunks || 4;
    this.buffers = null;
    this.fill = 0;
    this.startFrame = 0;
    this.sequence = 0;
    this.inFlight = 0;
    this.dropped = 0;
    this.closing = false;
    this.port.onmessage = event => {
      const data = event.data || {};
      if (data.ack !== undefined) this.inFlight = Math.max(0, this.inFlight - 1);
      else if (data.close) this.closing = true;
    };
  }
  flush() {
    this.port.postMessage({ flush: true, sequence: this.sequence++, startFrame: this.startFrame, droppedFramesBefore: this.dropped });
    this.dropped = 0;
  }
  emit() {
    if (this.inFlight >= this.inFlightChunks) { this.dropped += this.fill; this.startFrame += this.fill; this.fill = 0; return; }
    const channels = this.buffers.map(buffer => buffer.slice(0, this.fill));
    this.port.postMessage({ sequence: this.sequence++, startFrame: this.startFrame, channels, droppedFramesBefore: this.dropped }, channels.map(channel => channel.buffer));
    this.dropped = 0;
    this.inFlight += 1;
    this.startFrame += this.fill;
    this.fill = 0;
  }
  process(inputs, outputs) {
    if (this.closing) { this.flush(); return false; }
    const input = inputs[0];
    const frames = (input && input[0] && input[0].length) || 128;
    if (!this.buffers) {
      const count = Math.min(2, Math.max(1, input ? input.length : 1));
      this.buffers = Array.from({ length: count }, () => new Float32Array(this.chunkFrames));
      this.startFrame = typeof currentFrame === 'number' ? currentFrame : 0; // engine frame clock, not frames-since-start
    }
    for (let channel = 0; channel < this.buffers.length; channel += 1) {
      const source = input && input[channel];
      if (source) this.buffers[channel].set(source.subarray(0, Math.min(frames, source.length)), this.fill);
    }
    this.fill += frames;
    if (this.fill >= this.chunkFrames) this.emit();
    const output = outputs[0];
    if (output) for (const channel of output) channel.fill(0);
    return true;
  }
}
registerProcessor('tunejs-tap', TuneJsTap);
`;
