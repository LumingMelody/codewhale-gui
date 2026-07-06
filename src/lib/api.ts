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
    return res.json() as Promise<T>;
  }

  listThreadSummaries(limit = 50): Promise<ThreadSummary[]> {
    return this.req(`/v1/threads/summary?limit=${limit}`);
  }

  createThread(workspace: string): Promise<{ id: string }> {
    return this.req(`/v1/threads`, {
      method: 'POST',
      body: JSON.stringify({ workspace }),
    });
  }

  startTurn(threadId: string, prompt: string): Promise<unknown> {
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
