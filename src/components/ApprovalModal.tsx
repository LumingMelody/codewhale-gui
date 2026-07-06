import { useState } from 'react';
import type { ApiClient } from '../lib/api';
import type { PendingApproval } from '../state/threadReducer';

export default function ApprovalModal({
  approval,
  api,
}: {
  approval: PendingApproval;
  api: ApiClient;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const decide = async (decision: 'allow' | 'deny') => {
    setBusy(true);
    setError(null);
    try {
      await api.decideApproval(approval.approvalId, decision);
      // 弹窗移除交给 approval.decided 事件驱动 reducer，不本地乐观删除
    } catch (err) {
      setError(String(err));
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop">
      <div className="wizard-card">
        <h3>⚠️ 工具审批</h3>
        <pre className="approval-summary">{approval.summary}</pre>
        {approval.matchedRule && <p className="thread-meta">规则: {approval.matchedRule}</p>}
        {error && <p className="error-text">{error}</p>}
        <div className="approval-actions">
          <button disabled={busy} onClick={() => decide('deny')}>
            拒绝
          </button>
          <button disabled={busy} className="primary" onClick={() => decide('allow')}>
            允许
          </button>
        </div>
      </div>
    </div>
  );
}
