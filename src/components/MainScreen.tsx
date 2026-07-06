import { useMemo, useState } from 'react';
import { ApiClient, type RuntimeInfo } from '../lib/api';
import ThreadList from './ThreadList';
import ConversationView from './ConversationView';

export default function MainScreen({ info }: { info: RuntimeInfo }) {
  const api = useMemo(() => new ApiClient(info.base_url, info.token), [info]);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  return (
    <div className="app-layout">
      <ThreadList api={api} selectedId={selectedId} onSelect={setSelectedId} />
      {selectedId ? (
        <ConversationView key={selectedId} api={api} info={info} threadId={selectedId} />
      ) : (
        <div className="conversation">
          <div className="center-screen">选择或新建一个会话</div>
        </div>
      )}
    </div>
  );
}
