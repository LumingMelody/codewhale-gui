import { describe, expect, it } from 'vitest';
import type { ThreadEvent } from '../lib/events';
import { initialThreadView, threadReducer } from './threadReducer';

const ev = (partial: Partial<ThreadEvent>): ThreadEvent => ({
  schema_version: 1,
  seq: 1,
  event: 'item.delta',
  kind: 'item.delta',
  thread_id: 'thr_1',
  timestamp: '2026-07-06T00:00:00Z',
  payload: {},
  ...partial,
});

describe('threadReducer', () => {
  it('回放序列组装出流式 agent 消息', () => {
    let s = initialThreadView;
    s = threadReducer(s, ev({ seq: 1, kind: 'turn.started', turn_id: 't1' }));
    s = threadReducer(s, ev({ seq: 2, kind: 'item.started', turn_id: 't1', item_id: 'i1', payload: { kind: 'agent_message' } }));
    s = threadReducer(s, ev({ seq: 3, kind: 'item.delta', turn_id: 't1', item_id: 'i1', payload: { delta: 'Hello ', kind: 'agent_message' } }));
    s = threadReducer(s, ev({ seq: 4, kind: 'item.delta', turn_id: 't1', item_id: 'i1', payload: { delta: 'world', kind: 'agent_message' } }));
    s = threadReducer(s, ev({ seq: 5, kind: 'item.completed', turn_id: 't1', item_id: 'i1', payload: {} }));
    s = threadReducer(s, ev({ seq: 6, kind: 'turn.completed', turn_id: 't1' }));

    expect(s.items).toHaveLength(1);
    expect(s.items[0]).toMatchObject({ id: 'i1', kind: 'agent_message', text: 'Hello world', status: 'completed' });
    expect(s.activeTurnId).toBeNull();
    expect(s.lastSeq).toBe(6);
  });

  it('重复/乱序 seq 被丢弃', () => {
    let s = initialThreadView;
    s = threadReducer(s, ev({ seq: 5, kind: 'item.started', item_id: 'i1', payload: { kind: 'agent_message' } }));
    const again = threadReducer(s, ev({ seq: 5, kind: 'item.delta', item_id: 'i1', payload: { delta: 'dup' } }));
    expect(again).toBe(s);
    const older = threadReducer(s, ev({ seq: 3, kind: 'item.delta', item_id: 'i1', payload: { delta: 'old' } }));
    expect(older).toBe(s);
  });

  it('审批出现与决议', () => {
    let s = initialThreadView;
    s = threadReducer(s, ev({ seq: 1, kind: 'approval.required', payload: { approval_id: 'ap1', summary: 'rm -rf /tmp/x', matched_rule: 'shell' } }));
    expect(s.approvals).toHaveLength(1);
    expect(s.approvals[0].approvalId).toBe('ap1');
    s = threadReducer(s, ev({ seq: 2, kind: 'approval.decided', payload: { approval_id: 'ap1' } }));
    expect(s.approvals).toHaveLength(0);
  });

  it('turn 活跃状态跟随 started/completed', () => {
    let s = initialThreadView;
    s = threadReducer(s, ev({ seq: 1, kind: 'turn.started', turn_id: 't9' }));
    expect(s.activeTurnId).toBe('t9');
    s = threadReducer(s, ev({ seq: 2, kind: 'turn.completed', turn_id: 't9' }));
    expect(s.activeTurnId).toBeNull();
  });
});
