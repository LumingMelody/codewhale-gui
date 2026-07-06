import type { ThreadEvent } from '../lib/events';

export type ItemKind =
  | 'user_message' | 'agent_message' | 'agent_reasoning' | 'tool_call'
  | 'file_change' | 'command_execution' | 'context_compaction' | 'status' | 'error';

export interface ConversationItem {
  id: string;
  turnId: string | null;
  kind: ItemKind;
  text: string;
  status: 'started' | 'completed' | 'failed' | 'interrupted';
  metadata: Record<string, unknown>;
}

export interface PendingApproval {
  approvalId: string;
  summary: string;
  matchedRule: string | null;
}

export interface ThreadViewState {
  items: ConversationItem[];
  activeTurnId: string | null;
  approvals: PendingApproval[];
  lastSeq: number;
}

export const initialThreadView: ThreadViewState = {
  items: [],
  activeTurnId: null,
  approvals: [],
  lastSeq: 0,
};

const str = (v: unknown): string => (typeof v === 'string' ? v : '');

// 实测(0.8.66): item.* 事件的 payload 为 {item: {id, kind, status, summary, detail}}
// 且错误 item 可能没有前置 item.started 直接 item.failed —— 所以必须 upsert。
interface RawItem {
  id?: string;
  kind?: string;
  status?: string;
  summary?: string;
  detail?: string;
}

const rawItem = (p: Record<string, unknown>): RawItem =>
  (p.item as RawItem | undefined) ?? {};

function mapStatus(
  raw: string | undefined,
  fallback: ConversationItem['status'],
): ConversationItem['status'] {
  switch (raw) {
    case 'completed':
      return 'completed';
    case 'failed':
      return 'failed';
    case 'interrupted':
      return 'interrupted';
    default:
      return fallback;
  }
}

function upsertItem(
  items: ConversationItem[],
  next: ConversationItem,
): ConversationItem[] {
  const idx = items.findIndex((it) => it.id === next.id);
  if (idx === -1) return [...items, next];
  const merged = { ...items[idx], ...next, text: next.text || items[idx].text };
  return items.map((it, i) => (i === idx ? merged : it));
}

export function threadReducer(state: ThreadViewState, ev: ThreadEvent): ThreadViewState {
  if (ev.seq <= state.lastSeq) return state;
  const s = { ...state, lastSeq: ev.seq };
  const p = ev.payload ?? {};

  switch (ev.kind) {
    case 'turn.started':
      return { ...s, activeTurnId: ev.turn_id ?? null };
    case 'turn.completed':
      return { ...s, activeTurnId: null };
    case 'item.started':
    case 'item.completed':
    case 'item.failed':
    case 'item.interrupted': {
      const raw = rawItem(p);
      const fallback: ConversationItem['status'] =
        ev.kind === 'item.completed'
          ? 'completed'
          : ev.kind === 'item.failed'
            ? 'failed'
            : ev.kind === 'item.interrupted'
              ? 'interrupted'
              : 'started';
      const id = raw.id || ev.item_id || `seq-${ev.seq}`;
      return {
        ...s,
        items: upsertItem(s.items, {
          id,
          turnId: ev.turn_id ?? null,
          kind: (raw.kind || 'status') as ItemKind,
          text: str(raw.detail) || str(raw.summary),
          status: ev.kind === 'item.started' ? mapStatus(raw.status, fallback) : fallback,
          metadata: p,
        }),
      };
    }
    case 'item.delta': {
      // delta 事件 payload 形状未在无 key 环境观测到；容错取 delta 字段，
      // item 未出现过则按 agent_message 占位创建（Task 11 真 key 联调复核）
      const id = ev.item_id ?? '';
      if (!id) return s;
      const delta = str(p.delta) || str(rawItem(p).detail);
      const existing = s.items.find((it) => it.id === id);
      if (existing) {
        return {
          ...s,
          items: s.items.map((it) => (it.id === id ? { ...it, text: it.text + delta } : it)),
        };
      }
      return {
        ...s,
        items: [
          ...s.items,
          {
            id,
            turnId: ev.turn_id ?? null,
            kind: (str(p.kind) || 'agent_message') as ItemKind,
            text: delta,
            status: 'started',
            metadata: p,
          },
        ],
      };
    }
    case 'approval.required': {
      const approvalId = str(p.approval_id) || str(p.id);
      if (!approvalId) return s;
      return {
        ...s,
        approvals: [
          ...s.approvals,
          {
            approvalId,
            summary: str(p.summary) || JSON.stringify(p),
            matchedRule: str(p.matched_rule) || null,
          },
        ],
      };
    }
    case 'approval.decided':
    case 'approval.timeout': {
      const decidedId = str(p.approval_id) || str(p.id);
      return { ...s, approvals: s.approvals.filter((a) => a.approvalId !== decidedId) };
    }
    default:
      return s;
  }
}
