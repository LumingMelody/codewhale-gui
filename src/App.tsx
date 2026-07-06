import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import type { RuntimeInfo } from './lib/api';
import Wizard from './components/Wizard';
import CrashScreen from './components/CrashScreen';
import MainScreen from './components/MainScreen';
import './App.css';

type Phase =
  | { name: 'booting'; note: string }
  | { name: 'wizard'; info: RuntimeInfo }
  | { name: 'main'; info: RuntimeInfo }
  | { name: 'crashed'; message: string };

async function waitRuntimeInfo(): Promise<RuntimeInfo> {
  for (let i = 0; i < 60; i++) {
    const info = await invoke<RuntimeInfo | null>('get_runtime_info');
    if (info) return info;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('engine 启动超时（30s）');
}

async function keyMissing(): Promise<boolean> {
  const doctor = await invoke<{ api_key?: { source?: string } }>('run_doctor');
  return (doctor.api_key?.source ?? 'missing') === 'missing';
}

export default function App() {
  const [phase, setPhase] = useState<Phase>({ name: 'booting', note: '正在启动引擎…' });

  useEffect(() => {
    const unlisten = listen<string>('sidecar-crashed', (e) => {
      setPhase({ name: 'crashed', message: e.payload });
    });
    (async () => {
      try {
        const info = await waitRuntimeInfo();
        setPhase((await keyMissing()) ? { name: 'wizard', info } : { name: 'main', info });
      } catch (err) {
        setPhase({ name: 'crashed', message: String(err) });
      }
    })();
    return () => {
      unlisten.then((fn) => fn());
    };
  }, []);

  switch (phase.name) {
    case 'booting':
      return <div className="center-screen">{phase.note}</div>;
    case 'wizard':
      return <Wizard onDone={() => setPhase({ name: 'main', info: phase.info })} />;
    case 'crashed':
      return (
        <CrashScreen
          message={phase.message}
          onRestarted={async (info) => {
            setPhase((await keyMissing()) ? { name: 'wizard', info } : { name: 'main', info });
          }}
        />
      );
    case 'main':
      return <MainScreen info={phase.info} />;
  }
}
