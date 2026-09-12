import { useEffect, useRef, useState } from 'react';
import { AppState, Button, Platform, ScrollView, Text, View } from 'react-native';
import { AudioContext, OfflineAudioContext } from 'react-native-audio-api';
import { nativeAdapter } from 'tunejs/native';
import { firstSound } from './generated/first-sound';
import { livingLoop } from './generated/living-loop';
import { spatialPlayground } from './generated/spatial-playground';
import { runFixtures } from './generated/fixtures';
import { runLiveProbes } from './generated/live-probes';

export default function App() {
  const adapter = nativeAdapter(() => new AudioContext());
  const [sound] = useState(() => firstSound(adapter));
  const [loop] = useState(() => livingLoop(adapter));
  const [scene] = useState(() => spatialPlayground(adapter));
  const [status, setStatus] = useState('Idle — tap Play to activate audio');
  const yaw = useRef(0);
  const [results, setResults] = useState('Offline fixtures running');
  const act = async (action: () => unknown) => { try { await action(); setStatus(JSON.stringify(sound.engine.diagnostics)); } catch(error) { setStatus(String(error)); } };
  useEffect(() => {
    let alive = true;
    const subscription = AppState.addEventListener('change', state => {
      if(state !== 'active') void act(() => sound.engine.suspend());
    });
    void (async () => {
      try {
        const createOffline = (o: {numberOfChannels:number;length:number;sampleRate:number}) => new OfflineAudioContext(o);
        const raw = await runFixtures(createOffline);
        const scheduled = await runFixtures(createOffline, {hostTime: adapter.hostTime, scheduling: 'native-adapter-frames'});
        let live;
        try { live = await runLiveProbes(() => new AudioContext(), { settleMs: 600 }); } catch(error) { live = { status: 'error', error: String(error) }; }
        const constants = Platform.constants as { Model?: string; Brand?: string; Manufacturer?: string; systemName?: string };
        const device = { model: constants.Model ?? null, brand: constants.Brand ?? null, manufacturer: constants.Manufacturer ?? null, systemName: constants.systemName ?? null };
        const data = {date:new Date().toISOString(),platform:Platform.OS,version:Platform.Version,rn:Platform.constants.reactNativeVersion,device,scope:'offline PCM + live graph probes on the running host; not a listening or latency measurement',...raw,adapterScheduled:scheduled,live};
        if(alive) setResults(JSON.stringify(data,null,2));
        const endpoints = Platform.OS === 'android' ? ['http://10.0.2.2:4173','http://127.0.0.1:4173'] : ['http://127.0.0.1:4173'];
        let posted = false; let attempts = 0; let lastError: unknown;
        for (const endpoint of endpoints) {
          attempts += 1;
          const control = new AbortController();
          const timer = setTimeout(() => control.abort(), 3000);
          try {
            await fetch(`${endpoint}/results/native`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data,null,2),signal:control.signal});
            posted = true;
            if(alive) setStatus(`posted ${endpoint} (attempt ${attempts})`);
            break;
          } catch(error) { lastError = error; }
          finally { clearTimeout(timer); }
        }
        if (!posted) throw lastError;
      } catch(error) { if(alive) setResults(String(error)); }
    })();
    return () => { alive=false; subscription.remove(); void scene.dispose().catch(console.error); void loop.dispose().catch(console.error); void sound.dispose().catch(console.error); };
  }, [sound]);
  return <ScrollView contentContainerStyle={{padding:28,paddingTop:70,gap:16}}>
    <Text style={{fontSize:36,fontWeight:'600'}}>TuneJS · First sound</Text>
    <Text>Experimental native adapter. A running state does not prove audible output.</Text>
    <Button title="Play chord" onPress={() => void act(sound.play)} />
    <Button title="Stop" onPress={() => void act(sound.stop)} />
    <Button title="Warm filter · 800 Hz" onPress={() => void act(() => sound.keys.filterHz.rampTo(800,{seconds:0.2}))} />
    <Button title="Bright filter · 4000 Hz" onPress={() => void act(() => sound.keys.filterHz.rampTo(4000,{seconds:0.2}))} />
    <Button title="Long release · 1.2 s" onPress={() => void act(() => sound.keys.setEnvelope({release:1.2}))} />
    <Button title="Short release · 0.1 s" onPress={() => void act(() => sound.keys.setEnvelope({release:0.1}))} />
    <Button title="Suspend" onPress={() => void act(() => sound.engine.suspend())} />
    <Button title="Dispose" onPress={() => void act(sound.dispose)} />
    <Text style={{fontSize:18,fontWeight:'600'}}>Living loop</Text>
    <Button title="Start loop" onPress={() => void act(loop.start)} />
    <Button title="Stop loop" onPress={() => void act(loop.stop)} />
    <Button title="Replace phrase" onPress={() => void act(() => loop.replacePhrase())} />
    <Button title="Tempo 124" onPress={() => void act(() => loop.setTempo(124))} />
    <Text style={{fontSize:18,fontWeight:'600'}}>Spatial playground</Text>
    <Button title="Start scene" onPress={() => void act(scene.start)} />
    <Button title="Stop scene" onPress={() => void act(scene.stop)} />
    <Button title="Rotate listener" onPress={() => void act(() => { yaw.current += 0.5; scene.rotateListener(yaw.current); })} />
    <Text selectable>{status}</Text>
    <Text selectable>{`capture capability: ${sound.engine.capabilities.capture}`}</Text><View><Text selectable>{results}</Text></View>
  </ScrollView>;
}
