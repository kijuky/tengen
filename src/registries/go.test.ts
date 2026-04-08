import { describe, it, expect } from 'vitest';
import { GoRegistryProxy } from './go.ts';

const proxy = new GoRegistryProxy({
  upstream: 'https://proxy.golang.org',
  delayMs: 7 * 24 * 60 * 60 * 1000,
});

const CUTOFF = new Date('2024-01-15T00:00:00Z');

describe('GoRegistryProxy.isMetadataPath', () => {
  it('returns true for .info paths', () => {
    expect(proxy.isMetadataPath('/golang.org/x/tools/gopls/@v/v0.15.3.info')).toBe(true);
    expect(proxy.isMetadataPath('/github.com/user/repo/@v/v1.0.0.info')).toBe(true);
  });

  it('returns false for binary artifact paths', () => {
    expect(proxy.isMetadataPath('/golang.org/x/tools/gopls/@v/v0.15.3.mod')).toBe(false);
    expect(proxy.isMetadataPath('/golang.org/x/tools/gopls/@v/v0.15.3.zip')).toBe(false);
    expect(proxy.isMetadataPath('/golang.org/x/tools/gopls/@v/list')).toBe(false);
    expect(proxy.isMetadataPath('/golang.org/x/tools/gopls/@latest')).toBe(false);
  });
});

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
