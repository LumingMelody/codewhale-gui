import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { confirm, open } from '@tauri-apps/plugin-dialog';
import { relaunch } from '@tauri-apps/plugin-process';
import { check, type Update } from '@tauri-apps/plugin-updater';
import epMark from '../assets/ep-mark.png';
import { ApiClient, type RuntimeInfo, type ThreadSummary } from '../lib/api';

export interface UpdateBanner {
  version: string;
  busy: string | null;
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
  const updateRef = useRef<Update | null>(null);
  const [update, setUpdate] = useState<UpdateBanner | null>(null);

  useEffect(() => {
    let cancelled = false;
    const poll = async () => {
      try {
        const u = await check();
        if (!cancelled && u) {
          updateRef.current = u;
          setUpdate({ version: u.version, busy: null });
        }
      } catch {
        // 网络不可达/清单缺失时静默，不打扰
      }
    };
    poll();
    const timer = setInterval(poll, 6 * 60 * 60 * 1000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  const applyUpdate = async () => {
    const u = updateRef.current;
    if (!u) return;
    try {
      let total = 0;
      let got = 0;
      setUpdate({ version: u.version, busy: '准备下载…' });
      await u.downloadAndInstall((e) => {
        if (e.event === 'Started') {
          total = e.data.contentLength ?? 0;
        } else if (e.event === 'Progress') {
          got += e.data.chunkLength;
          if (total > 0) {
            setUpdate({ version: u.version, busy: `下载中 ${Math.round((got / total) * 100)}%` });
          }
        } else if (e.event === 'Finished') {
          setUpdate({ version: u.version, busy: '安装中，即将重启…' });
        }
      });
      await relaunch();
    } catch (err) {
      setUpdate({ version: u.version, busy: null });
      setError(`自动更新失败: ${String(err)}`);
    }
  };

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
        onApplyUpdate={applyUpdate}
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
