import ReactMarkdown from 'react-markdown';
import type { ConversationItem } from '../state/threadReducer';

export default function ItemView({ item }: { item: ConversationItem }) {
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
            <span className="tool-icon">✳</span> 思考过程
            {item.status === 'started' && <span className="tool-status running">思考中</span>}
          </summary>
          <div className="reasoning-text">{item.text}</div>
        </details>
      );
    case 'tool_call':
    case 'command_execution':
      return (
        <details className="tool-block">
          <summary>
            <span className="tool-icon">{item.kind === 'tool_call' ? '⚙' : '❯'}</span>
            {item.kind === 'tool_call' ? '工具调用' : '命令执行'}
            {item.status === 'started' && <span className="tool-status running">运行中</span>}
            {item.status === 'failed' && <span className="tool-status failed">失败</span>}
            {item.status === 'interrupted' && <span className="tool-status">已打断</span>}
          </summary>
          <pre>{item.text || JSON.stringify(item.metadata, null, 2)}</pre>
        </details>
      );
    case 'file_change':
      return (
        <div className="item-row system">
          <span className="tool-icon">✎</span> 文件变更: {item.text || JSON.stringify(item.metadata)}
        </div>
      );
    case 'error':
      return <div className="item-row error-block">{item.text || JSON.stringify(item.metadata)}</div>;
    default:
      return (
        <div className="item-row system">
          {item.kind}: {item.text}
        </div>
      );
  }
}
