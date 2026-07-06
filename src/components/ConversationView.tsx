import { useEffect, useReducer, useRef, useState } from 'react';
import type { ApiClient, RuntimeInfo } from '../lib/api';
import { subscribeThreadEvents } from '../lib/events';
import { initialThreadView, threadReducer } from '../state/threadReducer';
import ApprovalModal from './ApprovalModal';
import ItemView from './ItemView';

export default function ConversationView({
  api,
  info,
  threadId,
}: {
  api: ApiClient;
  info: RuntimeInfo;
  threadId: string;
}) {
  const [state, dispatch] = useReducer(threadReducer, initialThreadView);
  const [draft, setDraft] = useState('');
  const [steering, setSteering] = useState(false);
  const [connState, setConnState] = useState<'open' | 'reconnecting'>('open');
  const [sendError, setSendError] = useState<string | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

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
      {connState === 'reconnecting' && <div className="banner">连接中断，重连中…</div>}
      <div className="items">
        {state.items.map((item) => (
          <ItemView key={item.id} item={item} />
        ))}
        <div ref={bottomRef} />
      </div>
      {state.approvals.length > 0 && <ApprovalModal approval={state.approvals[0]} api={api} />}
      <div className="composer">
        {sendError && <p className="error-text">{sendError}</p>}
        {state.activeTurnId && (
          <div className="turn-controls">
            <span>agent 运行中…</span>
            <button onClick={() => api.interruptTurn(threadId, state.activeTurnId!)}>打断</button>
            <label>
              <input
                type="checkbox"
                checked={steering}
                onChange={(e) => setSteering(e.target.checked)}
              />
              追加指令（steer）
            </label>
          </div>
        )}
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) send();
          }}
          placeholder="输入消息，⌘+Enter 发送"
          rows={3}
        />
        <button onClick={send} disabled={!draft.trim()}>
          发送
        </button>
      </div>
    </div>
  );
}
