import { useEffect, useReducer, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import type { ApiClient, RuntimeInfo } from '../lib/api';
import { subscribeThreadEvents } from '../lib/events';
import { initialThreadView, threadReducer } from '../state/threadReducer';
import ApprovalModal from './ApprovalModal';
import { ArrowUpIcon } from './Icons';
import ItemView from './ItemView';

interface Attachment {
  rel: string; // 工作区内相对路径，供 image_analyze 使用
  name: string;
  preview: string; // object URL，仅用于缩略图
}

export default function ConversationView({
  api,
  info,
  threadId,
  title,
  workspace,
  workspacePath,
}: {
  api: ApiClient;
  info: RuntimeInfo;
  threadId: string;
  title: string;
  workspace: string | null;
  workspacePath: string | null;
}) {
  const [state, dispatch] = useReducer(threadReducer, initialThreadView);
  const [draft, setDraft] = useState('');
  const [attachments, setAttachments] = useState<Attachment[]>([]);
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

  const addImage = async (file: File) => {
    if (!workspacePath) {
      setSendError('工作区未就绪，暂时无法添加图片');
      return;
    }
    try {
      const ext = (file.type.split('/')[1] || 'png').replace('jpeg', 'jpg');
      // 前端可用 Date.now；文件名唯一即可
      const filename = `paste-${Date.now()}-${attachments.length}.${ext}`;
      const bytes = Array.from(new Uint8Array(await file.arrayBuffer()));
      const rel = await invoke<string>('save_attachment', {
        workspace: workspacePath,
        filename,
        bytes,
      });
      setAttachments((a) => [...a, { rel, name: filename, preview: URL.createObjectURL(file) }]);
      setSendError(null);
    } catch (err) {
      setSendError(`添加图片失败: ${String(err)}`);
    }
  };

  const onPaste = (e: React.ClipboardEvent) => {
    const imgs = Array.from(e.clipboardData.items).filter((i) => i.type.startsWith('image/'));
    if (imgs.length === 0) return;
    e.preventDefault();
    for (const item of imgs) {
      const file = item.getAsFile();
      if (file) addImage(file);
    }
  };

  const onDrop = (e: React.DragEvent) => {
    const files = Array.from(e.dataTransfer.files).filter((f) => f.type.startsWith('image/'));
    if (files.length === 0) return;
    e.preventDefault();
    files.forEach(addImage);
  };

  const removeAttachment = (rel: string) => {
    setAttachments((a) => {
      const hit = a.find((x) => x.rel === rel);
      if (hit) URL.revokeObjectURL(hit.preview);
      return a.filter((x) => x.rel !== rel);
    });
  };

  const send = async () => {
    const text = draft.trim();
    if (!text && attachments.length === 0) return;

    let prompt = text;
    if (attachments.length > 0) {
      const refs = attachments.map((a) => `- ${a.rel}`).join('\n');
      prompt =
        `[我发送了 ${attachments.length} 张图片，请用 image_analyze 工具查看（路径相对工作区）]\n` +
        `${refs}\n\n${text}`.trim();
    }

    setDraft('');
    attachments.forEach((a) => URL.revokeObjectURL(a.preview));
    setAttachments([]);
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
      setDraft(text);
    }
  };

  const canSend = draft.trim().length > 0 || attachments.length > 0;

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
        <div className="composer-card" onDrop={onDrop} onDragOver={(e) => e.preventDefault()}>
          {attachments.length > 0 && (
            <div className="attachment-strip">
              {attachments.map((a) => (
                <div key={a.rel} className="attachment-chip">
                  <img src={a.preview} alt={a.name} />
                  <button
                    className="attachment-remove"
                    title="移除"
                    onClick={() => removeAttachment(a.rel)}
                  >
                    ×
                  </button>
                </div>
              ))}
            </div>
          )}
          <textarea
            ref={textareaRef}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onPaste={onPaste}
            onKeyDown={(e) => {
              if (e.key !== 'Enter') return;
              // 中文输入法组词上屏的回车不发送
              if (e.nativeEvent.isComposing) return;
              // Shift+Enter 换行
              if (e.shiftKey) return;
              e.preventDefault();
              send();
            }}
            placeholder={steering ? '给运行中的 agent 追加指令…' : '输入消息，可粘贴或拖入图片…'}
            rows={1}
          />
          <div className="composer-row">
            <span className="composer-hint">⏎ 发送 · ⇧⏎ 换行 · 可粘贴图片</span>
            <button className="send-btn" onClick={send} disabled={!canSend} title="发送">
              <ArrowUpIcon size={16} />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
