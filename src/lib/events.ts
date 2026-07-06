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

export interface SubscribeOptions {
  baseUrl: string;
  token: string;
  threadId: string;
  sinceSeq: number;
  onEvent: (ev: ThreadEvent) => void;
  onStatus?: (status: 'open' | 'reconnecting') => void;
}

/**
 * 增量喂入 SSE 字节流，产出每个完整帧的 data 载荷。
 * 单独抽出便于测试；处理跨 chunk 的半帧与 CRLF。
 */
export function createSseFrameSplitter(): (chunk: string) => string[] {
  let buf = '';
  return (chunk: string) => {
    buf += chunk.replace(/\r\n/g, '\n');
    const out: string[] = [];
    let idx: number;
    while ((idx = buf.indexOf('\n\n')) !== -1) {
      const frame = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      const dataLines = frame
        .split('\n')
        .filter((l) => l.startsWith('data:'))
        .map((l) => l.slice(5).trimStart());
      if (dataLines.length) out.push(dataLines.join('\n'));
    }
    return out;
  };
}

// 实测(0.8.66): 文档声称的 ?token= query 鉴权在 /v1/threads/{id}/events 上
// 返回 401（ThreadEventsQuery 无 token 字段），EventSource 又设不了自定义
// header —— 所以用 fetch + ReadableStream 手写 SSE，与 REST 同一条
// Authorization: Bearer 鉴权路径。
export function subscribeThreadEvents(opts: SubscribeOptions): () => void {
  let closed = false;
  let retryMs = 500;
  let lastSeq = opts.sinceSeq;
  let controller: AbortController | null = null;

  const connect = async () => {
    if (closed) return;
    controller = new AbortController();
    try {
      const res = await fetch(
        `${opts.baseUrl}/v1/threads/${opts.threadId}/events?since_seq=${lastSeq}`,
        {
          headers: {
            Authorization: `Bearer ${opts.token}`,
            Accept: 'text/event-stream',
          },
          signal: controller.signal,
        },
      );
      if (!res.ok || !res.body) {
        throw new Error(`SSE ${res.status}`);
      }
      opts.onStatus?.('open');
      retryMs = 500;

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      const feed = createSseFrameSplitter();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        for (const data of feed(decoder.decode(value, { stream: true }))) {
          try {
            const ev = JSON.parse(data) as ThreadEvent;
            if (ev.seq > lastSeq) {
              lastSeq = ev.seq;
              opts.onEvent(ev);
            }
          } catch {
            // 跳过非 JSON 帧（如注释/心跳）
          }
        }
      }
      throw new Error('stream ended');
    } catch (err) {
      if (closed) return;
      opts.onStatus?.('reconnecting');
      setTimeout(connect, retryMs);
      retryMs = Math.min(retryMs * 2, 10_000);
    }
  };

  connect();
  return () => {
    closed = true;
    controller?.abort();
  };
}
