import { useCallback, useEffect, useState } from 'react';
import { open } from '@tauri-apps/plugin-dialog';
import type { ApiClient, ThreadSummary } from '../lib/api';

export default function ThreadList({
  api,
  selectedId,
  onSelect,
}: {
  api: ApiClient;
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  const [threads, setThreads] = useState<ThreadSummary[]>([]);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setThreads(await api.listThreadSummaries());
      setError(null);
    } catch (err) {
      setError(String(err));
    }
  }, [api]);

  useEffect(() => {
    refresh();
    const timer = setInterval(refresh, 5000);
    return () => clearInterval(timer);
  }, [refresh]);

  const createSession = async () => {
    const dir = await open({ directory: true, title: '选择工作目录' });
    if (typeof dir !== 'string') return;
    try {
      const { id } = await api.createThread(dir);
      await refresh();
      onSelect(id);
    } catch (err) {
      setError(String(err));
    }
  };

  return (
    <div className="sidebar">
      <button onClick={createSession}>＋ 新建会话</button>
      {error && <p className="error-text">{error}</p>}
      {threads.map((t) => (
        <div
          key={t.id}
          className={`thread-row${t.id === selectedId ? ' selected' : ''}`}
          onClick={() => onSelect(t.id)}
        >
          <div className="thread-title">{t.title || t.preview || t.id}</div>
          <div className="thread-meta">
            {t.workspace.split('/').pop()}
            {t.branch ? ` · ${t.branch}` : ''}
            {t.dirty ? ' · ●' : ''}
            {t.latest_turn_status ? ` · ${t.latest_turn_status}` : ''}
          </div>
        </div>
      ))}
    </div>
  );
}
