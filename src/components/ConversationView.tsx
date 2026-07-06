import { useEffect, useReducer, useRef, useState } from 'react';
import type { ApiClient, RuntimeInfo } from '../lib/api';
import { subscribeThreadEvents } from '../lib/events';
import { initialThreadView, threadReducer } from '../state/threadReducer';
import ApprovalModal from './ApprovalModal';
import { ArrowUpIcon } from './Icons';
import ItemView from './ItemView';

export default function ConversationView({
  api,
  info,
  threadId,
  title,
  workspace,
}: {
  api: ApiClient;
  info: RuntimeInfo;
  threadId: string;
  title: string;
  workspace: string | null;
}) {
  const [state, dispatch] = useReducer(threadReducer, initialThreadView);
  const [draft, setDraft] = useState('');
  const [steering, setSteering] = useState(false);
  const [connState, setConnState] = useState<'open' | 'reconnecting'>('open');
  const [sendError, setSendError] = useState<string | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    ta.style.height = 'auto';
    ta.style.height = `${Math.min(ta.scrollHeight, 200)}px`;
  }, [draft]);

  useEffect(() => {
    return subscribeThreadEvents({
      baseUrl: info.base_url,
      token: info.token,
      threadId,
      sinceSeq: 0,
      onEvent: dispatch,
      onStatus: setConnState,
    });
  }, [info, threadId]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [state.items]);

  const send = async () => {
    const prompt = draft.trim();
    if (!prompt) return;
    setDraft('');
    setSendError(null);
    try {
      if (steering && state.activeTurnId) {
        await api.steerTurn(threadId, state.activeTurnId, prompt);
        setSteering(false);
      } else {
        await api.startTurn(threadId, prompt);
      }
    } catch (err) {
      setSendError(String(err));
      setDraft(prompt);
    }
  };

  return (
    <div className="conversation">
      <header className="conv-header">
        <div className="conv-title">{title}</div>
        {workspace && (
          <div className="conv-workspace" title={workspace}>
            {workspace.split('/').pop()}
          </div>
        )}
      </header>
      {connState === 'reconnecting' && (
        <div className="banner">连接中断，重连中…</div>
      )}
      <div className="items">
        <div className="items-inner">
          {state.items.map((item) => (
            <ItemView key={item.id} item={item} />
          ))}
          <div ref={bottomRef} />
        </div>
      </div>
      {state.approvals.length > 0 && <ApprovalModal approval={state.approvals[0]} api={api} />}
      <div className="composer-zone">
        {sendError && <p className="error-text composer-error">{sendError}</p>}
        {state.activeTurnId && (
          <div className="turn-controls">
            <span className="turn-spinner" /> agent 运行中
            <button className="ghost" onClick={() => api.interruptTurn(threadId, state.activeTurnId!)}>
              打断
            </button>
            <label className="steer-toggle">
              <input
                type="checkbox"
                checked={steering}
                onChange={(e) => setSteering(e.target.checked)}
              />
              追加指令
            </label>
          </div>
        )}
        <div className="composer-card">
          <textarea
            ref={textareaRef}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key !== 'Enter') return;
              // 中文输入法组词上屏的回车不发送
              if (e.nativeEvent.isComposing) return;
              // Shift+Enter 换行
              if (e.shiftKey) return;
              e.preventDefault();
              send();
            }}
            placeholder={steering ? '给运行中的 agent 追加指令…' : '输入消息…'}
            rows={1}
          />
          <div className="composer-row">
            <span className="composer-hint">⏎ 发送 · ⇧⏎ 换行</span>
            <button className="send-btn" onClick={send} disabled={!draft.trim()} title="发送">
              <ArrowUpIcon size={16} />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
