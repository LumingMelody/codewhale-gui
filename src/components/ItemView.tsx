import ReactMarkdown from 'react-markdown';
import { parseTodoUpdate, statusLabel, toolPresentation } from '../lib/itemPresentation';
import type { ConversationItem } from '../state/threadReducer';
import { PencilIcon, SparkleIcon, TerminalIcon, WrenchIcon } from './Icons';

export default function ItemView({ item }: { item: ConversationItem }) {
  const todo = item.kind === 'file_change' ? parseTodoUpdate(item.text) : null;
  if (todo) {
    return (
      <div className="task-progress-row">
        <div className="task-progress-copy">
          <span>任务进度</span>
          <span>{todo.completed}/{todo.total}</span>
        </div>
        <div
          className="task-progress-track"
          role="progressbar"
          aria-label="任务进度"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={todo.completion}
        >
          <span style={{ width: `${todo.completion}%` }} />
        </div>
      </div>
    );
  }

  switch (item.kind) {
    case 'user_message':
      return (
        <div className="item-row user">
          <div className="user-bubble">{item.text}</div>
        </div>
      );
    case 'agent_message':
      return (
        <div className="item-row agent">
          <div className="agent-prose">
            <ReactMarkdown>{item.text}</ReactMarkdown>
            {item.status === 'started' && <span className="cursor">▌</span>}
          </div>
        </div>
      );
    case 'agent_reasoning':
      return (
        <details className="tool-block reasoning">
          <summary>
            <span className="tool-icon">
              <SparkleIcon size={13} />
            </span>
            思考过程
            {item.status === 'started' && <span className="tool-status running">思考中</span>}
          </summary>
          <div className="reasoning-text">{item.text}</div>
        </details>
      );
    case 'tool_call':
    case 'command_execution': {
      const tool = toolPresentation(item);
      return (
        <details className="tool-block" open={item.status === 'failed' || undefined}>
          <summary>
            <span className="tool-icon">
              {item.kind === 'tool_call' ? <WrenchIcon size={13} /> : <TerminalIcon size={13} />}
            </span>
            <span className="tool-title">
              {item.kind === 'tool_call' ? '工具调用' : '命令执行'}
              {tool.name && <strong>{tool.name}</strong>}
            </span>
            {item.status === 'started' && <span className="tool-status running">运行中</span>}
            {item.status === 'failed' && <span className="tool-status failed">失败</span>}
            {item.status === 'interrupted' && <span className="tool-status">已打断</span>}
          </summary>
          <div className="tool-detail">
            {tool.input && (
              <section>
                <span>输入</span>
                <pre>{tool.input}</pre>
              </section>
            )}
            <section className={item.status === 'failed' ? 'tool-error-detail' : undefined}>
              <span>{item.status === 'failed' ? '失败原因' : '输出'}</span>
              <pre>{tool.output || JSON.stringify(item.metadata, null, 2)}</pre>
            </section>
          </div>
        </details>
      );
    }
    case 'file_change':
      return (
        <div className="item-row system">
          <span className="tool-icon">
            <PencilIcon size={13} />
          </span>{' '}
          文件已更新：{item.text || JSON.stringify(item.metadata)}
        </div>
      );
    case 'error':
      return <div className="item-row error-block">{item.text || JSON.stringify(item.metadata)}</div>;
    case 'status':
      return <div className="item-row system">{statusLabel(item.text)}</div>;
    case 'context_compaction':
      return <div className="item-row system">已整理上下文，继续处理…</div>;
    default:
      return (
        <div className="item-row system">
          {item.text}
        </div>
      );
  }
}
