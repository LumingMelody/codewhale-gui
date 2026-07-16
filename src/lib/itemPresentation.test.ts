import { describe, expect, it } from 'vitest';
import type { ConversationItem } from '../state/threadReducer';
import { parseTodoUpdate, statusLabel, toolPresentation } from './itemPresentation';

const toolItem: ConversationItem = {
  id: 'item_1',
  turnId: 'turn_1',
  kind: 'command_execution',
  text: 'Tool exec_shell is not available',
  status: 'failed',
  metadata: {
    tool: { name: 'exec_shell', input: { command: 'python generate.py' } },
    item: { summary: 'exec_shell failed' },
  },
};

describe('item presentation', () => {
  it('展示工具名、输入和失败输出', () => {
    expect(toolPresentation(toolItem)).toEqual({
      name: 'exec_shell',
      input: '{\n  "command": "python generate.py"\n}',
      output: 'Tool exec_shell is not available',
    });
  });

  it('把 todo 原始负载压缩为任务进度', () => {
    expect(parseTodoUpdate('Todo list updated (4 items, 100% complete) {"items":[]}')).toEqual({
      total: 4,
      completion: 100,
      completed: 4,
    });
  });

  it('把内部英文调度状态转换为简洁中文', () => {
    expect(statusLabel('status: Executing tools sequentially (writes detected)')).toBe('正在依次执行工具…');
  });
});

