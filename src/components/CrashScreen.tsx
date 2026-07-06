import { useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import type { RuntimeInfo } from '../lib/api';

export default function CrashScreen({
  message,
  onRestarted,
}: {
  message: string;
  onRestarted: (info: RuntimeInfo) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const restart = async () => {
    setBusy(true);
    setError(null);
    try {
      onRestarted(await invoke<RuntimeInfo>('restart_sidecar'));
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="center-screen">
      <div className="wizard-card">
        <h2>引擎已停止</h2>
        <pre className="error-text">{message}</pre>
        {error && <pre className="error-text">{error}</pre>}
        <button className="primary" disabled={busy} onClick={restart}>
          {busy ? '重启中…' : '重启引擎'}
        </button>
      </div>
    </div>
  );
}
