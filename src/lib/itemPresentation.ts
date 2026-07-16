import type { ConversationItem } from '../state/threadReducer';

type UnknownRecord = Record<string, unknown>;

function record(value: unknown): UnknownRecord | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as UnknownRecord)
    : null;
}

export interface ToolPresentation {
  name: string;
  input: string;
  output: string;
}

export function toolPresentation(item: ConversationItem): ToolPresentation {
  const tool = record(item.metadata.tool);
  const rawItem = record(item.metadata.item);
  const summary = typeof rawItem?.summary === 'string' ? rawItem.summary : '';
  const summaryMatch = summary.match(/^([\w.-]+)\s+(?:started|failed|completed)|^([\w.-]+):/);
  const inferredName = summaryMatch?.[1] ?? summaryMatch?.[2] ?? '';
  const name = typeof tool?.name === 'string' ? tool.name : inferredName;
  const input = tool?.input === undefined ? '' : JSON.stringify(tool.input, null, 2);
  return { name, input, output: item.text };
}

export interface TodoPresentation {
  total: number;
  completion: number;
  completed: number;
}

export function parseTodoUpdate(text: string): TodoPresentation | null {
  const match = text.match(/Todo list updated\s*\((\d+)\s+items?,\s*(\d+)%\s+complete\)/i);
  if (!match) return null;
  const total = Number(match[1]);
  const completion = Math.max(0, Math.min(100, Number(match[2])));
  return {
    total,
    completion,
    completed: Math.round((total * completion) / 100),
  };
}

export function statusLabel(text: string): string {
  if (/Executing tools sequentially/i.test(text)) return '正在依次执行工具…';
  if (/Executing tools/i.test(text)) return '正在执行工具…';
  return text.replace(/^status:\s*/i, '');
}
