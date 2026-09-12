import type { Adapter, HostContext } from '../backend.js';
import { integerFrame } from '../errors.js';
/** Experimental React Native Audio API 0.13.3 boundary. Import that package only in the host app. */
export function nativeAdapter(createContext: () => HostContext): Adapter {
  return {
    name: 'react-native-audio-api/0.13.3-experimental',
    createContext,
    // RN uses onEnded; browsers use onended. Do not silently lose voice cleanup.
    setEnded(node, callback) { Reflect.set(node, 'onEnded', callback); },
    // RN Audio API `AudioUtils.hpp timeToSampleFrame` truncates `time * sampleRate`; a quarter-frame bias keeps both truncation and nearest-rounding on the target frame (e.g. 1023/44100*44100 = 1022.9999999999999 → 1022 raw).
    hostTime(frame, sampleRate) { return (integerFrame(frame, 'frame') + 0.25) / sampleRate; },
  };
}
