export interface RuntimeInfo {
  base_url: string;
  token: string;
  port: number;
}

export interface ThreadSummary {
  id: string;
  title: string | null;
  preview: string | null;
  model: string;
  mode: string;
  branch: string | null;
  head: string | null;
  dirty: boolean;
  workspace: string;
  archived: boolean;
  updated_at: string;
  latest_turn_id: string | null;
  latest_turn_status: string | null;
}

export class ApiClient {
  constructor(
    private baseUrl: string,
    private token: string,
  ) {}

  private async req<T>(path: string, init: RequestInit = {}): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${this.token}`,
        ...(init.body ? { 'Content-Type': 'application/json' } : {}),
        ...(init.headers ?? {}),
      },
    });
    if (!res.ok) {
      throw new Error(`${init.method ?? 'GET'} ${path} → ${res.status}: ${await res.text()}`);
    }
    const text = await res.text();
    return (text ? JSON.parse(text) : undefined) as T;
  }

  listThreadSummaries(limit = 50): Promise<ThreadSummary[]> {
    return this.req(`/v1/threads/summary?limit=${limit}`);
  }

  createThread(workspace: string): Promise<{ id: string }> {
    return this.req(`/v1/threads`, {
      method: 'POST',
      body: JSON.stringify({ workspace, mode: 'agent', allow_shell: true }),
    });
  }

  enableShell(threadId: string): Promise<unknown> {
    return this.req(`/v1/threads/${threadId}`, {
      method: 'PATCH',
      body: JSON.stringify({ allow_shell: true }),
    });
  }

  archiveThread(threadId: string): Promise<unknown> {
    return this.req(`/v1/threads/${threadId}`, {
      method: 'PATCH',
      body: JSON.stringify({ archived: true }),
    });
  }

  async startTurn(threadId: string, prompt: string): Promise<{ id?: string; turn?: { id?: string } }> {
    // 兼容升级前创建的会话；仍由引擎的审批机制约束具体 shell 命令。
    await this.enableShell(threadId);
    return this.req(`/v1/threads/${threadId}/turns`, {
      method: 'POST',
      body: JSON.stringify({ prompt }),
    });
  }

  steerTurn(threadId: string, turnId: string, prompt: string): Promise<unknown> {
    return this.req(`/v1/threads/${threadId}/turns/${turnId}/steer`, {
      method: 'POST',
      body: JSON.stringify({ prompt }),
    });
  }

  interruptTurn(threadId: string, turnId: string): Promise<unknown> {
    return this.req(`/v1/threads/${threadId}/turns/${turnId}/interrupt`, {
      method: 'POST',
      body: JSON.stringify({}),
    });
  }

  decideApproval(approvalId: string, decision: 'allow' | 'deny'): Promise<unknown> {
    return this.req(`/v1/approvals/${approvalId}`, {
      method: 'POST',
      body: JSON.stringify({ decision, remember: false }),
    });
  }
}
