import { describe, expect, it } from 'vitest';
import { diffWorkspaceFiles, type WorkspaceFileInfo } from './artifacts';

const file = (rel: string, size: number, modified_ms: number): WorkspaceFileInfo => ({
  rel,
  name: rel.split('/').pop()!,
  path: `/workspace/${rel}`,
  directory: '/workspace',
  size,
  modified_ms,
});

describe('diffWorkspaceFiles', () => {
  it('返回新建和更新的可交付文件', () => {
    const before = [file('旧报告.pdf', 10, 100), file('不变.xlsx', 20, 100)];
    const after = [
      file('旧报告.pdf', 11, 200),
      file('不变.xlsx', 20, 100),
      file('供应链培训.pptx', 300, 300),
    ];

    expect(diffWorkspaceFiles(before, after).map((item) => item.rel)).toEqual([
      '供应链培训.pptx',
      '旧报告.pdf',
    ]);
  });

  it('忽略源码和未变化文件，避免把执行脚本误报为产物', () => {
    const unchanged = file('已有.pdf', 10, 100);
    const after = [unchanged, file('generate.py', 30, 200), file('src/App.tsx', 40, 300)];
    expect(diffWorkspaceFiles([unchanged], after)).toEqual([]);
  });
});

