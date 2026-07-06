import type { ThreadSummary } from '../lib/api';

export default function ThreadList({
  threads,
  selectedId,
  onSelect,
  onCreate,
  error,
  enginePort,
}: {
  threads: ThreadSummary[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onCreate: () => void;
  error: string | null;
  enginePort: number;
}) {
  return (
    <div className="sidebar">
      <div className="sidebar-brand">CodeWhale</div>
      <button className="new-chat" onClick={onCreate}>
        <span className="new-chat-icon">＋</span> 新建会话
      </button>
      <div className="section-label">会话</div>
      <div className="thread-scroll">
        {error && <p className="error-text sidebar-error">{error}</p>}
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
              {t.dirty ? ' ●' : ''}
              {t.latest_turn_status === 'in_progress' ? ' · 运行中' : ''}
            </div>
          </div>
        ))}
      </div>
      <div className="sidebar-footer">
        <span className="status-dot" /> 引擎已连接 · :{enginePort}
      </div>
    </div>
  );
}
