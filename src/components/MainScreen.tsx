import { useCallback, useEffect, useMemo, useState } from 'react';
import { open } from '@tauri-apps/plugin-dialog';
import { ApiClient, type RuntimeInfo, type ThreadSummary } from '../lib/api';
import ThreadList from './ThreadList';
import ConversationView from './ConversationView';

export default function MainScreen({ info }: { info: RuntimeInfo }) {
  const api = useMemo(() => new ApiClient(info.base_url, info.token), [info]);
  const [threads, setThreads] = useState<ThreadSummary[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
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
      setSelectedId(id);
    } catch (err) {
      setError(String(err));
    }
  };

  const selected = threads.find((t) => t.id === selectedId) ?? null;

  return (
    <div className="app-layout">
      <ThreadList
        threads={threads}
        selectedId={selectedId}
        onSelect={setSelectedId}
        onCreate={createSession}
        error={error}
        enginePort={info.port}
      />
      {selectedId ? (
        <ConversationView
          key={selectedId}
          api={api}
          info={info}
          threadId={selectedId}
          title={selected?.title || selected?.preview || selectedId}
          workspace={selected?.workspace ?? null}
        />
      ) : (
        <div className="conversation">
          <div className="empty-state">
            <div className="empty-mark">◍</div>
            <h1>开始新的对话</h1>
            <p>从左侧选择一个会话，或新建会话并选择工作目录</p>
          </div>
        </div>
      )}
    </div>
  );
}
