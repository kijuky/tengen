import { describe, it, expect } from 'vitest';
import { GoRegistryProxy } from './go.ts';

const proxy = new GoRegistryProxy({
  upstream: 'https://proxy.golang.org',
  delayMs: 7 * 24 * 60 * 60 * 1000,
});

const CUTOFF = new Date('2024-01-15T00:00:00Z');

describe('GoRegistryProxy.filterMetadata', () => {
  it('returns info when published before cutoff', () => {
    const info = { Version: 'v1.0.0', Time: '2024-01-01T00:00:00Z' };
    expect(proxy.filterMetadata(info, CUTOFF)).toBe(info);
  });

  it('returns info when published exactly at cutoff', () => {
    const info = { Version: 'v1.0.0', Time: '2024-01-15T00:00:00Z' };
    expect(proxy.filterMetadata(info, CUTOFF)).toBe(info);
  });

  it('returns null when published after cutoff', () => {
    const info = { Version: 'v1.0.0', Time: '2024-02-01T00:00:00Z' };
    expect(proxy.filterMetadata(info, CUTOFF)).toBeNull();
  });

  it('returns data unchanged when Time field is missing', () => {
    const info = { Version: 'v1.0.0' };
    expect(proxy.filterMetadata(info, CUTOFF)).toBe(info);
  });
});
