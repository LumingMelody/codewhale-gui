import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiClient } from './api';

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('ApiClient shell capability', () => {
  it('创建 Agent 会话时启用受审批保护的 shell', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ id: 'thr_1' }));
    vi.stubGlobal('fetch', fetchMock);
    const api = new ApiClient('http://localhost', 'token');

    await api.createThread('/tmp/workspace');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0];
    expect(JSON.parse(init.body)).toEqual({
      workspace: '/tmp/workspace',
      mode: 'agent',
      allow_shell: true,
    });
  });

  it('旧会话开始新一轮前先补启用 shell', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ id: 'thr_1', allow_shell: true }))
      .mockResolvedValueOnce(jsonResponse({ id: 'turn_1' }));
    vi.stubGlobal('fetch', fetchMock);
    const api = new ApiClient('http://localhost', 'token');

    await api.startTurn('thr_1', '生成一个 PPT');

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0][0]).toBe('http://localhost/v1/threads/thr_1');
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ allow_shell: true });
    expect(fetchMock.mock.calls[1][0]).toBe('http://localhost/v1/threads/thr_1/turns');
  });
});

