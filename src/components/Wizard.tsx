import { useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import type { RuntimeInfo } from '../lib/api';

export default function Wizard({ onDone }: { onDone: (info: RuntimeInfo) => void }) {
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
      // 引擎是在无 key 状态下启动的，provider 路由在引擎启动时构建，
      // 必须重启引擎让新 key 生效，否则首次对话报 "API key not found"
      const info = await invoke<RuntimeInfo>('restart_sidecar');
      onDone(info);
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
