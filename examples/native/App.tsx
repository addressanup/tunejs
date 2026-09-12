import { useEffect, useState } from 'react';
import { AppState, Button, Platform, ScrollView, Text, View } from 'react-native';
import { AudioContext, OfflineAudioContext } from 'react-native-audio-api';
import { nativeAdapter } from 'tunejs/native';
import { firstSound } from './generated/first-sound';
import { runFixtures } from './generated/fixtures';

export default function App() {
  const adapter = nativeAdapter(() => new AudioContext());
  const [sound] = useState(() => firstSound(adapter));
  const [status, setStatus] = useState('Idle — tap Play to activate audio');
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
        const data = {date:new Date().toISOString(),platform:Platform.OS,version:Platform.Version,rn:Platform.constants.reactNativeVersion,scope:'release simulator offline PCM; no physical-device validation',...raw,adapterScheduled:scheduled};
        if(alive) setResults(JSON.stringify(data,null,2));
        const endpoint = Platform.OS === 'android' ? 'http://10.0.2.2:4173' : 'http://127.0.0.1:4173';
        await fetch(`${endpoint}/results/native`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data,null,2)});
      } catch(error) { if(alive) setResults(String(error)); }
    })();
    return () => { alive=false; subscription.remove(); void sound.dispose().catch(console.error); };
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
    <Text selectable>{status}</Text><View><Text selectable>{results}</Text></View>
  </ScrollView>;
}
