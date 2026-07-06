import ReactMarkdown from 'react-markdown';
import type { ConversationItem } from '../state/threadReducer';

export default function ItemView({ item }: { item: ConversationItem }) {
  switch (item.kind) {
    case 'user_message':
      return <div className="item user">{item.text}</div>;
    case 'agent_message':
      return (
        <div className="item agent">
          <ReactMarkdown>{item.text}</ReactMarkdown>
          {item.status === 'started' && <span className="cursor">▌</span>}
        </div>
      );
    case 'tool_call':
    case 'command_execution':
      return (
        <details className="item tool">
          <summary>
            {item.kind === 'tool_call' ? '🔧 工具调用' : '💻 命令执行'}
            {item.status !== 'completed' ? `（${item.status}）` : ''}
          </summary>
          <pre>{item.text || JSON.stringify(item.metadata, null, 2)}</pre>
        </details>
      );
    case 'file_change':
      return <div className="item file">📝 文件变更: {item.text || JSON.stringify(item.metadata)}</div>;
    case 'error':
      return <div className="item error-text">{item.text || JSON.stringify(item.metadata)}</div>;
    default:
      return (
        <div className="item system">
          {item.kind}: {item.text}
        </div>
      );
  }
}
