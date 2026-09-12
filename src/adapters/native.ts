import type { Adapter, HostContext } from '../backend.js';
/** Experimental React Native Audio API 0.13.3 boundary. Import that package only in the host app. */
export function nativeAdapter(createContext: () => HostContext): Adapter {
  return {
    name: 'react-native-audio-api/0.13.3-experimental',
    createContext,
    // RN uses onEnded; browsers use onended. Do not silently lose voice cleanup.
    setEnded(node, callback) { Reflect.set(node, 'onEnded', callback); },
  };
}
