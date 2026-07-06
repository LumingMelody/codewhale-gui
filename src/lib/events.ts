export interface ThreadEvent {
  schema_version: number;
  seq: number;
  event: string;
  kind: string;
  thread_id: string;
  turn_id?: string;
  item_id?: string;
  timestamp: string;
  payload: Record<string, unknown>;
}

// RUNTIME_API.md 列出的事件名全集；SSE 以命名事件下发，
// EventSource 的 onmessage 收不到命名事件，必须逐名监听。
const EVENT_NAMES = [
  'thread.started', 'thread.forked',
  'turn.started', 'turn.lifecycle', 'turn.steered',
  'turn.interrupt_requested', 'turn.completed',
  'item.started', 'item.delta', 'item.completed',
  'item.failed', 'item.interrupted',
  'approval.required', 'approval.decided', 'approval.timeout',
  'sandbox.denied',
];

export interface SubscribeOptions {
  baseUrl: string;
  token: string;
  threadId: string;
  sinceSeq: number;
  onEvent: (ev: ThreadEvent) => void;
  onStatus?: (status: 'open' | 'reconnecting') => void;
}

export function subscribeThreadEvents(opts: SubscribeOptions): () => void {
  let es: EventSource | null = null;
  let lastSeq = opts.sinceSeq;
  let closed = false;
  let retryMs = 500;

  const connect = () => {
    if (closed) return;
    const url =
      `${opts.baseUrl}/v1/threads/${opts.threadId}/events` +
      `?since_seq=${lastSeq}&token=${encodeURIComponent(opts.token)}`;
    es = new EventSource(url);
    const handle = (e: MessageEvent) => {
      const ev = JSON.parse(e.data) as ThreadEvent;
      if (ev.seq > lastSeq) {
        lastSeq = ev.seq;
        retryMs = 500;
        opts.onEvent(ev);
      }
    };
    for (const name of EVENT_NAMES) es!.addEventListener(name, handle);
    es.onmessage = handle; // 兜底未命名事件
    es.onopen = () => opts.onStatus?.('open');
    es.onerror = () => {
      es?.close();
      opts.onStatus?.('reconnecting');
      if (!closed) {
        setTimeout(connect, retryMs);
        retryMs = Math.min(retryMs * 2, 10_000);
      }
    };
  };

  connect();
  return () => {
    closed = true;
    es?.close();
  };
}
