import epMark from '../assets/ep-mark.png';
import epWordmark from '../assets/ep-wordmark.png';
import type { ThreadSummary } from '../lib/api';
import type { UpdateBanner } from './MainScreen';
import { DownloadIcon, PlusIcon, TrashIcon } from './Icons';

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(diff) || diff < 0) return '';
  const m = Math.floor(diff / 60000);
  if (m < 1) return '刚刚';
  if (m < 60) return `${m} 分钟前`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} 小时前`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d} 天前`;
  return new Date(iso).toLocaleDateString();
}

export default function ThreadList({
  threads,
  selectedId,
  onSelect,
  onCreate,
  onArchive,
  update,
  onApplyUpdate,
  appVersion,
  error,
  enginePort,
}: {
  threads: ThreadSummary[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onCreate: () => void;
  onArchive: (id: string) => void;
  update: UpdateBanner | null;
  onApplyUpdate: () => void;
  appVersion: string;
  error: string | null;
  enginePort: number;
}) {
  return (
    <div className="sidebar">
      <div className="sidebar-brand">
        <img className="brand-mark" src={epMark} alt="" />
        <img className="brand-wordmark" src={epWordmark} alt="Ever Pretty" />
      </div>
      <button className="new-chat" onClick={onCreate}>
        <span className="new-chat-icon">
          <PlusIcon size={12} />
        </span>
        新建会话
      </button>
      <div className="section-label">会话</div>
      <div className="thread-scroll">
        {error && <p className="error-text sidebar-error">{error}</p>}
        {threads.map((t) => {
          const when = timeAgo(t.updated_at);
          return (
            <div
              key={t.id}
              role="button"
              tabIndex={0}
              className={`thread-row${t.id === selectedId ? ' selected' : ''}`}
              onClick={() => onSelect(t.id)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  onSelect(t.id);
                }
              }}
            >
              <div className="thread-title">{t.title || t.preview || t.id}</div>
              <div className="thread-meta">
                {t.workspace.split('/').pop()}
                {t.branch ? ` · ${t.branch}` : ''}
                {t.dirty ? ' ●' : ''}
                {t.latest_turn_status === 'in_progress' ? ' · 运行中' : ''}
                {when ? ` · ${when}` : ''}
              </div>
              <button
                className="thread-archive"
                title="删除会话"
                onClick={(e) => {
                  e.stopPropagation();
                  onArchive(t.id);
                }}
              >
                <TrashIcon size={14} />
              </button>
            </div>
          );
        })}
      </div>
      {update && (
        <button
          className="update-banner"
          title="自动下载并安装更新"
          disabled={update.busy !== null}
          onClick={onApplyUpdate}
        >
          <DownloadIcon size={13} /> {update.busy ?? `新版本 v${update.version} · 点击更新`}
        </button>
      )}
      <div className="sidebar-footer">
        <span className="status-dot" /> 引擎已连接 · :{enginePort}
        {appVersion && ` · v${appVersion}`}
      </div>
    </div>
  );
}
