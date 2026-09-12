import type { Adapter } from '../backend.js';
import { TuneError } from '../errors.js';
/** Does not construct an AudioContext until Engine.start() is called. */
export function browserAdapter(): Adapter {
  return {
    name: 'web-audio',
    createContext() {
      if (typeof globalThis.AudioContext !== 'function') {
        throw new TuneError('UNSUPPORTED', 'Web Audio is unavailable.', 'Use a browser with AudioContext support.');
      }
      return new AudioContext({ latencyHint: 'interactive' });
    },
    setEnded(node, callback) { Reflect.set(node, 'onended', callback); },
  };
}
