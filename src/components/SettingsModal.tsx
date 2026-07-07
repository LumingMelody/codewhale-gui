import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import type { RuntimeInfo } from '../lib/api';

export default function SettingsModal({
  onClose,
  onInfoChanged,
}: {
  onClose: () => void;
  onInfoChanged: (info: RuntimeInfo) => void;
}) {
  const [key, setKey] = useState('');
  const [configured, setConfigured] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    invoke<boolean>('vision_status').then(setConfigured).catch(() => {});
  }, []);

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      // 引擎会重启，返回新的 RuntimeInfo（port/token 变化）
      const info = await invoke<RuntimeInfo>('set_vision_key', { key: key.trim() });
      onInfoChanged(info);
      onClose();
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="wizard-card" onClick={(e) => e.stopPropagation()}>
        <h3>视觉模型（图片分析）</h3>
        <p>
          粘贴图片需要一个视觉模型。当前接入 GPT-5.4（经本机 shim 桥接 tabcode）。
          {configured ? '已配置，可重新粘贴 key 覆盖。' : '尚未配置，粘贴 key 后即可分析图片。'}
        </p>
        <input
          type="password"
          value={key}
          onChange={(e) => setKey(e.target.value)}
          placeholder="tabcode 视觉 key（sk-user-...）"
          autoFocus
        />
        {error && <p className="error-text">{error}</p>}
        <div className="approval-actions">
          <button onClick={onClose} disabled={busy}>
            取消
          </button>
          <button className="primary" onClick={save} disabled={busy || key.trim() === ''}>
            {busy ? '保存并重启引擎…' : '保存'}
          </button>
        </div>
      </div>
    </div>
  );
}
