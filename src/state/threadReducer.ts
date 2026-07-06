import type { ThreadEvent } from '../lib/events';

export type ItemKind =
  | 'user_message' | 'agent_message' | 'tool_call' | 'file_change'
  | 'command_execution' | 'context_compaction' | 'status' | 'error';

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

function patchItem(
  items: ConversationItem[],
  itemId: string,
  patch: (item: ConversationItem) => ConversationItem,
): ConversationItem[] {
  return items.map((it) => (it.id === itemId ? patch(it) : it));
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
      return {
        ...s,
        items: [
          ...s.items,
          {
            id: ev.item_id ?? `seq-${ev.seq}`,
            turnId: ev.turn_id ?? null,
            kind: (str(p.kind) || 'status') as ItemKind,
            text: str(p.text),
            status: 'started',
            metadata: p,
          },
        ],
      };
    case 'item.delta':
      return {
        ...s,
        items: patchItem(s.items, ev.item_id ?? '', (it) => ({
          ...it,
          text: it.text + str(p.delta),
        })),
      };
    case 'item.completed':
      return {
        ...s,
        items: patchItem(s.items, ev.item_id ?? '', (it) => ({
          ...it,
          status: 'completed',
          text: str(p.text) || it.text,
        })),
      };
    case 'item.failed':
    case 'item.interrupted':
      return {
        ...s,
        items: patchItem(s.items, ev.item_id ?? '', (it) => ({
          ...it,
          status: ev.kind === 'item.failed' ? 'failed' : 'interrupted',
        })),
      };
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
