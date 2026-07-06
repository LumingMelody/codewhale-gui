import { describe, expect, it } from 'vitest';
import { isNewerVersion } from './version';

describe('isNewerVersion', () => {
  it('检测 patch 升级', () => {
    expect(isNewerVersion('0.1.1', 'v0.1.2')).toBe(true);
  });
  it('检测 minor / major 升级', () => {
    expect(isNewerVersion('0.1.9', 'v0.2.0')).toBe(true);
    expect(isNewerVersion('0.9.9', 'v1.0.0')).toBe(true);
  });
  it('相同版本不提示', () => {
    expect(isNewerVersion('0.1.1', 'v0.1.1')).toBe(false);
  });
  it('远端更旧不提示（本地 dev 超前）', () => {
    expect(isNewerVersion('0.2.0', 'v0.1.9')).toBe(false);
  });
  it('容忍位数不齐', () => {
    expect(isNewerVersion('0.1', 'v0.1.1')).toBe(true);
    expect(isNewerVersion('0.1.0', 'v0.1')).toBe(false);
  });
  it('容忍大小写 V 与空白', () => {
    expect(isNewerVersion('0.1.1', ' V0.1.2 ')).toBe(true);
  });
});
