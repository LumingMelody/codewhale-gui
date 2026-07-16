import { Fragment, useCallback, useEffect, useReducer, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { getCurrentWebview } from '@tauri-apps/api/webview';
import { open } from '@tauri-apps/plugin-dialog';
import type { ApiClient, RuntimeInfo } from '../lib/api';
import { diffWorkspaceFiles, type WorkspaceFileInfo } from '../lib/artifacts';
import type { ThreadEvent } from '../lib/events';
import { subscribeThreadEvents } from '../lib/events';
import { initialThreadView, threadReducer } from '../state/threadReducer';
import ApprovalModal from './ApprovalModal';
import ArtifactList from './ArtifactList';
import { ArrowUpIcon, FileIcon, ImageIcon, PaperclipIcon } from './Icons';
import ItemView from './ItemView';

type AttachmentKind = 'image' | 'file';
type AttachmentSource = 'paste' | 'drop' | 'picker';

interface Attachment {
  rel: string; // 工作区内相对路径，供 image_analyze/agent 读取使用
  name: string;
  kind: AttachmentKind;
  size: number;
  mime?: string;
  previewUrl?: string; // object URL，仅用于缩略图
  source: AttachmentSource;
}

interface AttachmentInfo {
  rel: string;
  name: string;
  kind: AttachmentKind;
  size: number;
  mime?: string | null;
}

interface AttachmentPreview {
  bytes: number[];
  mime: string;
}

const MAX_BATCH_FILES = 50;
const MAX_CLIPBOARD_FILE_SIZE = 25 * 1024 * 1024;
const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'tiff']);

function isImageName(name: string): boolean {
  const ext = name.split('.').pop()?.toLowerCase();
  return ext ? IMAGE_EXTENSIONS.has(ext) : false;
}

function kindFromInfo(info: AttachmentInfo): AttachmentKind {
  return info.kind === 'image' || isImageName(info.name) ? 'image' : 'file';
}

function formatFileSize(size: number): string {
  if (size < 1024) return `${size} B`;
  const units = ['KiB', 'MiB', 'GiB'];
  let value = size / 1024;
  for (const unit of units) {
    if (value < 1024) return `${value.toFixed(value < 10 ? 1 : 0)} ${unit}`;
    value /= 1024;
  }
  return `${value.toFixed(1)} TiB`;
}

function fallbackClipboardName(file: File): string {
  if (file.name) return file.name;
  const ext = file.type.startsWith('image/')
    ? file.type.split('/')[1]?.replace('jpeg', 'jpg') || 'png'
    : 'bin';
  return `paste-${Date.now()}.${ext}`;
}

function revokeAttachmentPreview(attachment: Attachment) {
  if (attachment.previewUrl) URL.revokeObjectURL(attachment.previewUrl);
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
  const [dragActive, setDragActive] = useState(false);
  const [importing, setImporting] = useState(false);
  const [artifactsByTurn, setArtifactsByTurn] = useState<Record<string, WorkspaceFileInfo[]>>({});
  const bottomRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const attachmentsRef = useRef<Attachment[]>([]);
  const turnBaselinesRef = useRef(new Map<string, WorkspaceFileInfo[]>());
  const pendingBaselineRef = useRef<WorkspaceFileInfo[] | null>(null);

  useEffect(() => {
    attachmentsRef.current = attachments;
  }, [attachments]);

  useEffect(() => {
    return () => attachmentsRef.current.forEach(revokeAttachmentPreview);
  }, []);

  useEffect(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    ta.style.height = 'auto';
    ta.style.height = `${Math.min(ta.scrollHeight, 200)}px`;
  }, [draft]);

  const finishArtifactCapture = useCallback(
    async (turnId: string) => {
      const before = turnBaselinesRef.current.get(turnId);
      if (!before || !workspacePath) return;
      turnBaselinesRef.current.delete(turnId);
      try {
        const after = await invoke<WorkspaceFileInfo[]>('list_workspace_files', {
          workspace: workspacePath,
        });
        const changed = diffWorkspaceFiles(before, after);
        if (changed.length > 0) {
          setArtifactsByTurn((current) => ({ ...current, [turnId]: changed }));
        }
      } catch (error) {
        setSendError(`读取生成文件失败: ${String(error)}`);
      }
    },
    [workspacePath],
  );

  const onThreadEvent = useCallback(
    (event: ThreadEvent) => {
      dispatch(event);
      const turnId = event.turn_id;
      if (!turnId) return;
      if (event.kind === 'turn.started' && pendingBaselineRef.current) {
        turnBaselinesRef.current.set(turnId, pendingBaselineRef.current);
        pendingBaselineRef.current = null;
      } else if (event.kind === 'turn.completed') {
        void finishArtifactCapture(turnId);
      }
    },
    [finishArtifactCapture],
  );

  useEffect(() => {
    return subscribeThreadEvents({
      baseUrl: info.base_url,
      token: info.token,
      threadId,
      sinceSeq: 0,
      onEvent: onThreadEvent,
      onStatus: setConnState,
    });
  }, [info, onThreadEvent, threadId]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [state.items]);

  const hydratePreview = useCallback(
    async (info: AttachmentInfo, source: AttachmentSource, previewFile?: File): Promise<Attachment> => {
      const kind = kindFromInfo(info);
      let previewUrl: string | undefined;
      if (kind === 'image') {
        if (previewFile) {
          previewUrl = URL.createObjectURL(previewFile);
        } else if (workspacePath) {
          try {
            const preview = await invoke<AttachmentPreview>('read_attachment_preview', {
              workspace: workspacePath,
              rel: info.rel,
            });
            previewUrl = URL.createObjectURL(
              new Blob([Uint8Array.from(preview.bytes)], { type: preview.mime }),
            );
          } catch {
            // 大图或不支持预览时降级为图标 chip，不影响发送。
          }
        }
      }
      return {
        rel: info.rel,
        name: info.name,
        kind,
        size: info.size,
        mime: info.mime ?? undefined,
        previewUrl,
        source,
      };
    },
    [workspacePath],
  );

  const importPaths = useCallback(
    async (paths: string[], source: AttachmentSource) => {
      if (!workspacePath) {
        setSendError('工作区未就绪，暂时无法添加附件');
        return;
      }
      if (paths.length === 0) return;
      if (paths.length > MAX_BATCH_FILES) {
        setSendError(`单次最多添加 ${MAX_BATCH_FILES} 个附件`);
        return;
      }
      setImporting(true);
      const added: Attachment[] = [];
      const errors: string[] = [];
      for (const path of paths) {
        try {
          const info = await invoke<AttachmentInfo>('import_attachment', {
            workspace: workspacePath,
            path,
          });
          added.push(await hydratePreview(info, source));
        } catch (err) {
          errors.push(String(err));
        }
      }
      if (added.length > 0) {
        setAttachments((current) => [...current, ...added]);
      }
      setSendError(errors.length > 0 ? `添加附件失败: ${errors[0]}` : null);
      setImporting(false);
    },
    [hydratePreview, workspacePath],
  );

  useEffect(() => {
    let unlisten: (() => void) | null = null;
    let cancelled = false;
    getCurrentWebview()
      .onDragDropEvent((event) => {
        const payload = event.payload;
        if (payload.type === 'enter' || payload.type === 'over') {
          setDragActive(true);
          return;
        }
        if (payload.type === 'leave') {
          setDragActive(false);
          return;
        }
        setDragActive(false);
        void importPaths(payload.paths, 'drop');
      })
      .then((fn) => {
        if (cancelled) {
          fn();
        } else {
          unlisten = fn;
        }
      })
      .catch((err) => setSendError(`拖放监听初始化失败: ${String(err)}`));
    return () => {
      cancelled = true;
      if (unlisten) unlisten();
    };
  }, [importPaths]);

  const addClipboardFile = async (file: File) => {
    if (!workspacePath) {
      setSendError('工作区未就绪，暂时无法添加附件');
      return;
    }
    const isImage = file.type.startsWith('image/') || isImageName(file.name);
    if (file.size > MAX_CLIPBOARD_FILE_SIZE) {
      setSendError(isImage ? '剪贴板图片超过 25 MiB' : '剪贴板文件超过 25 MiB，请用附件按钮或拖入文件');
      return;
    }
    try {
      const filename = fallbackClipboardName(file);
      const bytes = Array.from(new Uint8Array(await file.arrayBuffer()));
      const info = await invoke<AttachmentInfo>('save_attachment', {
        workspace: workspacePath,
        filename,
        bytes,
      });
      const attachment = await hydratePreview(info, 'paste', isImage ? file : undefined);
      setAttachments((a) => [...a, attachment]);
      setSendError(null);
    } catch (err) {
      setSendError(`添加附件失败: ${String(err)}`);
    }
  };

  const onPaste = (e: React.ClipboardEvent) => {
    const files = Array.from(e.clipboardData.items)
      .map((item) => item.getAsFile())
      .filter((file): file is File => file !== null);
    if (files.length === 0) return;
    e.preventDefault();
    if (files.length > MAX_BATCH_FILES) {
      setSendError(`单次最多添加 ${MAX_BATCH_FILES} 个附件`);
      return;
    }
    files.forEach((file) => void addClipboardFile(file));
  };

  const removeAttachment = (rel: string) => {
    setAttachments((a) => {
      const hit = a.find((x) => x.rel === rel);
      if (hit) revokeAttachmentPreview(hit);
      return a.filter((x) => x.rel !== rel);
    });
  };

  const chooseAttachments = async () => {
    try {
      const selected = await open({
        multiple: true,
        directory: false,
        title: '选择附件',
      });
      if (!selected) return;
      const paths = Array.isArray(selected) ? selected : [selected];
      await importPaths(paths, 'picker');
    } catch (err) {
      setSendError(`选择附件失败: ${String(err)}`);
    }
  };

  const send = async () => {
    const text = draft.trim();
    if (!text && attachments.length === 0) return;

    let prompt = text;
    if (attachments.length > 0) {
      const images = attachments.filter((a) => a.kind === 'image');
      const files = attachments.filter((a) => a.kind === 'file');
      const parts: string[] = [];
      if (images.length > 0) {
        parts.push(
          `图片附件（请用 image_analyze 查看，路径相对工作区）：\n${images
            .map((a) => `- ${a.rel}`)
            .join('\n')}`,
        );
      }
      if (files.length > 0) {
        parts.push(
          `普通文件附件（请直接按工作区相对路径读取/处理）：\n${files
            .map((a) => `- ${a.rel}`)
            .join('\n')}`,
        );
      }
      prompt = `${parts.join('\n\n')}${text ? `\n\n${text}` : ''}`.trim();
    }

    setSendError(null);
    const sentRels = new Set(attachments.map((a) => a.rel));
    try {
      if (steering && state.activeTurnId) {
        await api.steerTurn(threadId, state.activeTurnId, prompt);
        setSteering(false);
      } else {
        if (workspacePath) {
          try {
            pendingBaselineRef.current = await invoke<WorkspaceFileInfo[]>('list_workspace_files', {
              workspace: workspacePath,
            });
          } catch {
            pendingBaselineRef.current = null;
          }
        }
        const started = await api.startTurn(threadId, prompt);
        const startedTurnId = started.id ?? started.turn?.id;
        if (startedTurnId && pendingBaselineRef.current) {
          turnBaselinesRef.current.set(startedTurnId, pendingBaselineRef.current);
          pendingBaselineRef.current = null;
        }
      }
      setDraft((current) => (current.trim() === text ? '' : current));
      setAttachments((current) => {
        current.forEach((a) => {
          if (sentRels.has(a.rel)) revokeAttachmentPreview(a);
        });
        return current.filter((a) => !sentRels.has(a.rel));
      });
    } catch (err) {
      pendingBaselineRef.current = null;
      setSendError(String(err));
    }
  };

  const canSend = !importing && (draft.trim().length > 0 || attachments.length > 0);

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
          {state.items.map((item, index) => {
            const next = state.items[index + 1];
            const isTurnEnd = item.turnId && next?.turnId !== item.turnId;
            const artifacts = item.turnId ? artifactsByTurn[item.turnId] : undefined;
            return (
              <Fragment key={item.id}>
                <ItemView item={item} />
                {isTurnEnd && artifacts && (
                  <ArtifactList files={artifacts} onError={setSendError} />
                )}
              </Fragment>
            );
          })}
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
        <div className={`composer-card${dragActive ? ' drag-active' : ''}`}>
          {attachments.length > 0 && (
            <div className="attachment-strip">
              {attachments.map((a) => (
                <div key={a.rel} className={`attachment-chip ${a.kind}`}>
                  <div className="attachment-thumb">
                    {a.kind === 'image' && a.previewUrl ? (
                      <img src={a.previewUrl} alt={a.name} />
                    ) : a.kind === 'image' ? (
                      <ImageIcon size={18} />
                    ) : (
                      <FileIcon size={18} />
                    )}
                  </div>
                  <div className="attachment-meta">
                    <span className="attachment-name" title={a.name}>
                      {a.name}
                    </span>
                    <span className="attachment-size">{formatFileSize(a.size)}</span>
                  </div>
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
            placeholder={steering ? '给运行中的 agent 追加指令…' : '输入消息，可粘贴图片、拖入文件或点附件…'}
            rows={1}
          />
          <div className="composer-row">
            <span className="composer-hint">
              ⏎ 发送 · ⇧⏎ 换行 · 可粘贴图片、拖入文件或点附件
            </span>
            <div className="composer-actions">
              <button
                className="attach-btn"
                onClick={chooseAttachments}
                disabled={importing}
                title="添加附件"
              >
                <PaperclipIcon size={16} />
              </button>
              <button className="send-btn" onClick={send} disabled={!canSend} title="发送">
                <ArrowUpIcon size={16} />
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
