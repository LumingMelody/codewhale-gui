import { useCallback, useEffect, useMemo, useState } from 'react';
import { getVersion } from '@tauri-apps/api/app';
import { invoke } from '@tauri-apps/api/core';
import { confirm, open } from '@tauri-apps/plugin-dialog';
import epMark from '../assets/ep-mark.png';
import { ApiClient, type RuntimeInfo, type ThreadSummary } from '../lib/api';
import { isNewerVersion } from '../lib/version';

export interface LatestRelease {
  tag: string;
  url: string;
}

function greeting(): string {
  const h = new Date().getHours();
  if (h >= 5 && h < 11) return '早上好';
  if (h >= 11 && h < 13) return '中午好';
  if (h >= 13 && h < 18) return '下午好';
  return '晚上好';
}
import ThreadList from './ThreadList';
import ConversationView from './ConversationView';

export default function MainScreen({ info }: { info: RuntimeInfo }) {
  const api = useMemo(() => new ApiClient(info.base_url, info.token), [info]);
  const [threads, setThreads] = useState<ThreadSummary[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [update, setUpdate] = useState<LatestRelease | null>(null);

  useEffect(() => {
    let cancelled = false;
    const check = async () => {
      try {
        const [current, latest] = await Promise.all([
          getVersion(),
          invoke<LatestRelease>('check_latest_release'),
        ]);
        if (!cancelled && isNewerVersion(current, latest.tag)) setUpdate(latest);
      } catch {
        // 网络不可达/API 限流时静默，不打扰
      }
    };
    check();
    const timer = setInterval(check, 6 * 60 * 60 * 1000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

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

  const archiveSession = async (id: string) => {
    const t = threads.find((x) => x.id === id);
    const ok = await confirm(`删除会话「${t?.title || t?.preview || id}」？`, {
      title: '删除会话',
      kind: 'warning',
    });
    if (!ok) return;
    try {
      await api.archiveThread(id);
      if (selectedId === id) setSelectedId(null);
      await refresh();
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
        onArchive={archiveSession}
        update={update}
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
            <img className="empty-mark" src={epMark} alt="" />
            <h1>{greeting()}，欢迎回到 Ever Pretty</h1>
            <p>从左侧选择一个会话，或新建会话开始今天的工作</p>
          </div>
        </div>
      )}
    </div>
  );
}
