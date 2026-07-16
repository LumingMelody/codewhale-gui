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

// payload 形状按 0.8.66 真机抓包: item.* 事件为 {item: {id, kind, status, summary, detail}}
describe('threadReducer', () => {
  it('回放序列组装出流式 agent 消息', () => {
    let s = initialThreadView;
    s = threadReducer(s, ev({ seq: 1, kind: 'turn.started', turn_id: 't1' }));
    s = threadReducer(s, ev({
      seq: 2, kind: 'item.started', turn_id: 't1', item_id: 'i1',
      payload: { item: { id: 'i1', kind: 'agent_message', status: 'in_progress' } },
    }));
    s = threadReducer(s, ev({ seq: 3, kind: 'item.delta', turn_id: 't1', item_id: 'i1', payload: { delta: 'Hello ' } }));
    s = threadReducer(s, ev({ seq: 4, kind: 'item.delta', turn_id: 't1', item_id: 'i1', payload: { delta: 'world' } }));
    s = threadReducer(s, ev({
      seq: 5, kind: 'item.completed', turn_id: 't1', item_id: 'i1',
      payload: { item: { id: 'i1', kind: 'agent_message', status: 'completed' } },
    }));
    s = threadReducer(s, ev({ seq: 6, kind: 'turn.completed', turn_id: 't1' }));

    expect(s.items).toHaveLength(1);
    expect(s.items[0]).toMatchObject({ id: 'i1', kind: 'agent_message', text: 'Hello world', status: 'completed' });
    expect(s.activeTurnId).toBeNull();
    expect(s.lastSeq).toBe(6);
  });

  it('user_message 以 completed 状态直接出场（真机行为）', () => {
    let s = initialThreadView;
    s = threadReducer(s, ev({
      seq: 5, kind: 'item.started', turn_id: 't1', item_id: 'iu',
      payload: { item: { id: 'iu', kind: 'user_message', status: 'completed', summary: 'hello', detail: 'hello' } },
    }));
    expect(s.items[0]).toMatchObject({ kind: 'user_message', text: 'hello', status: 'completed' });
  });

  it('错误 item 无前置 started 直接 failed 出场（真机行为: 缺 key 时）', () => {
    let s = initialThreadView;
    s = threadReducer(s, ev({
      seq: 8, kind: 'item.failed', turn_id: 't1', item_id: 'ie',
      payload: { item: { id: 'ie', kind: 'error', status: 'failed', summary: 'API key not found', detail: 'DeepSeek API key not found.' } },
    }));
    expect(s.items).toHaveLength(1);
    expect(s.items[0]).toMatchObject({ id: 'ie', kind: 'error', status: 'failed', text: 'DeepSeek API key not found.' });
  });

  it('工具完成或失败时保留 started 事件里的工具名和输入', () => {
    let s = initialThreadView;
    s = threadReducer(s, ev({
      seq: 1, kind: 'item.started', turn_id: 't1', item_id: 'it',
      payload: {
        item: { id: 'it', kind: 'command_execution', status: 'in_progress', detail: '{"command":"pwd"}' },
        tool: { name: 'exec_shell', input: { command: 'pwd' } },
      },
    }));
    s = threadReducer(s, ev({
      seq: 2, kind: 'item.failed', turn_id: 't1', item_id: 'it',
      payload: {
        item: { id: 'it', kind: 'command_execution', status: 'failed', detail: 'shell disabled' },
      },
    }));

    expect(s.items[0]).toMatchObject({ status: 'failed', text: 'shell disabled' });
    expect(s.items[0].metadata.tool).toEqual({ name: 'exec_shell', input: { command: 'pwd' } });
  });

  it('重复/乱序 seq 被丢弃', () => {
    let s = initialThreadView;
    s = threadReducer(s, ev({
      seq: 5, kind: 'item.started', item_id: 'i1',
      payload: { item: { id: 'i1', kind: 'agent_message', status: 'in_progress' } },
    }));
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

  it('turn 活跃状态跟随 started/completed（failed turn 也走 turn.completed）', () => {
    let s = initialThreadView;
    s = threadReducer(s, ev({ seq: 1, kind: 'turn.started', turn_id: 't9' }));
    expect(s.activeTurnId).toBe('t9');
    s = threadReducer(s, ev({ seq: 2, kind: 'turn.completed', turn_id: 't9', payload: { turn: { status: 'failed' } } }));
    expect(s.activeTurnId).toBeNull();
  });
});
