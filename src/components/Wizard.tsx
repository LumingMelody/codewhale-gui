import { useState } from 'react';
import { invoke } from '@tauri-apps/api/core';

export default function Wizard({ onDone }: { onDone: () => void }) {
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await invoke('set_api_key', { apiKey: key.trim() });
      const doctor = await invoke<{ api_key?: { source?: string } }>('run_doctor');
      if ((doctor.api_key?.source ?? 'missing') === 'missing') {
        throw new Error('key 已提交但 doctor 仍报 missing，请检查 key 是否有效');
      }
      onDone();
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="center-screen">
      <div className="wizard-card">
        <h2>首次配置</h2>
        <p>粘贴 DeepSeek API Key（仅写入本机 ~/.codewhale/config.toml）</p>
        <input
          type="password"
          value={key}
          onChange={(e) => setKey(e.target.value)}
          placeholder="sk-..."
          autoFocus
        />
        <button className="primary" disabled={busy || key.trim() === ''} onClick={submit}>
          {busy ? '验证中…' : '保存并继续'}
        </button>
        {error && <p className="error-text">{error}</p>}
      </div>
    </div>
  );
}
