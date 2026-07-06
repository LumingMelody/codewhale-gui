import { describe, expect, it } from 'vitest';
import { createSseFrameSplitter } from './events';

describe('createSseFrameSplitter', () => {
  it('解析完整帧并剥离 event/data 前缀', () => {
    const feed = createSseFrameSplitter();
    const out = feed('event: item.delta\ndata: {"seq":1}\n\n');
    expect(out).toEqual(['{"seq":1}']);
  });

  it('半帧跨 chunk 续接', () => {
    const feed = createSseFrameSplitter();
    expect(feed('data: {"se')).toEqual([]);
    expect(feed('q":2}\n\n')).toEqual(['{"seq":2}']);
  });

  it('一个 chunk 多帧', () => {
    const feed = createSseFrameSplitter();
    const out = feed('data: a\n\ndata: b\n\n');
    expect(out).toEqual(['a', 'b']);
  });

  it('CRLF 归一化', () => {
    const feed = createSseFrameSplitter();
    expect(feed('data: x\r\n\r\n')).toEqual(['x']);
  });

  it('无 data 行的帧（注释/心跳）被跳过', () => {
    const feed = createSseFrameSplitter();
    expect(feed(': keepalive\n\n')).toEqual([]);
  });
});
