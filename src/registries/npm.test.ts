import { describe, it, expect } from 'vitest';
import { NpmRegistryProxy } from './npm.ts';

const proxy = new NpmRegistryProxy({
  upstream: 'https://registry.npmjs.org',
  delayMs: 7 * 24 * 60 * 60 * 1000,
});

const CUTOFF = new Date('2024-01-15T00:00:00Z');

describe('NpmRegistryProxy.isMetadataPath', () => {
  it('returns true for package metadata paths', () => {
    expect(proxy.isMetadataPath('/lodash')).toBe(true);
    expect(proxy.isMetadataPath('/@scope/pkg')).toBe(true);
    expect(proxy.isMetadataPath('/lodash/4.17.21')).toBe(true);
  });

  it('returns false for tarball paths containing /-/', () => {
    expect(proxy.isMetadataPath('/lodash/-/lodash-4.17.21.tgz')).toBe(false);
    expect(proxy.isMetadataPath('/@scope/pkg/-/pkg-1.0.0.tgz')).toBe(false);
  });
});

describe('NpmRegistryProxy.filterMetadata', () => {
  it('returns data unchanged when versions field is missing', () => {
    const data = { name: 'pkg', 'dist-tags': { latest: '1.0.0' } };
    expect(proxy.filterMetadata(data, CUTOFF)).toBe(data);
  });

  it('returns data unchanged when time field is missing', () => {
    const data = { name: 'pkg', 'dist-tags': { latest: '1.0.0' }, versions: { '1.0.0': {} } };
    expect(proxy.filterMetadata(data, CUTOFF)).toBe(data);
  });

  it('filters out versions published after cutoff date', () => {
    const data = {
      name: 'pkg',
      'dist-tags': { latest: '1.1.0' },
      versions: { '1.0.0': {}, '1.1.0': {} },
      time: {
        created: '2023-01-01T00:00:00Z',
        modified: '2024-02-01T00:00:00Z',
        '1.0.0': '2024-01-01T00:00:00Z',  // before cutoff -> allowed
        '1.1.0': '2024-02-01T00:00:00Z',  // after cutoff -> filtered
      },
    };

    const result = proxy.filterMetadata(data, CUTOFF) as typeof data;

    expect(Object.keys(result.versions)).toEqual(['1.0.0']);
    expect(Object.keys(result.time)).toContain('1.0.0');
    expect(Object.keys(result.time)).not.toContain('1.1.0');
  });

  it('includes versions published exactly at the cutoff date', () => {
    const data = {
      name: 'pkg',
      'dist-tags': { latest: '1.0.0' },
      versions: { '1.0.0': {} },
      time: {
        created: '2023-01-01T00:00:00Z',
        modified: '2024-01-15T00:00:00Z',
        '1.0.0': '2024-01-15T00:00:00Z',  // exactly at cutoff -> allowed
      },
    };

    const result = proxy.filterMetadata(data, CUTOFF) as typeof data;
    expect(Object.keys(result.versions)).toEqual(['1.0.0']);
  });

  it('preserves special time keys: created and modified', () => {
    const data = {
      name: 'pkg',
      'dist-tags': { latest: '1.0.0' },
      versions: { '1.0.0': {} },
      time: {
        created: '2023-01-01T00:00:00Z',
        modified: '2024-02-01T00:00:00Z',
        '1.0.0': '2024-01-01T00:00:00Z',
      },
    };

    const result = proxy.filterMetadata(data, CUTOFF) as typeof data;
    expect(result.time.created).toBe('2023-01-01T00:00:00Z');
    expect(result.time.modified).toBe('2024-02-01T00:00:00Z');
  });

  it('redirects dist-tags to the latest allowed version when current tag is filtered', () => {
    const data = {
      name: 'pkg',
      'dist-tags': { latest: '1.2.0' },
      versions: { '1.0.0': {}, '1.1.0': {}, '1.2.0': {} },
      time: {
        created: '2023-01-01T00:00:00Z',
        modified: '2024-02-01T00:00:00Z',
        '1.0.0': '2024-01-01T00:00:00Z',  // allowed
        '1.1.0': '2024-01-10T00:00:00Z',  // allowed (newer of the two)
        '1.2.0': '2024-02-01T00:00:00Z',  // filtered
      },
    };

    const result = proxy.filterMetadata(data, CUTOFF) as typeof data;
    // latest tag should fall back to 1.1.0 (most recently published allowed version)
    expect(result['dist-tags'].latest).toBe('1.1.0');
  });

  it('keeps dist-tags that already point to allowed versions', () => {
    const data = {
      name: 'pkg',
      'dist-tags': { latest: '1.0.0', beta: '1.1.0' },
      versions: { '1.0.0': {}, '1.1.0': {} },
      time: {
        created: '2023-01-01T00:00:00Z',
        modified: '2024-01-10T00:00:00Z',
        '1.0.0': '2024-01-01T00:00:00Z',  // allowed
        '1.1.0': '2024-01-10T00:00:00Z',  // allowed
      },
    };

    const result = proxy.filterMetadata(data, CUTOFF) as typeof data;
    expect(result['dist-tags'].latest).toBe('1.0.0');
    expect(result['dist-tags'].beta).toBe('1.1.0');
  });

  it('drops dist-tags entirely when no versions are allowed', () => {
    const data = {
      name: 'pkg',
      'dist-tags': { latest: '1.0.0' },
      versions: { '1.0.0': {} },
      time: {
        created: '2024-02-01T00:00:00Z',
        modified: '2024-02-01T00:00:00Z',
        '1.0.0': '2024-02-01T00:00:00Z',  // after cutoff -> filtered
      },
    };

    const result = proxy.filterMetadata(data, CUTOFF) as typeof data;
    expect(Object.keys(result['dist-tags'])).toHaveLength(0);
    expect(Object.keys(result.versions)).toHaveLength(0);
  });

  it('preserves other top-level package fields', () => {
    const data = {
      name: 'pkg',
      description: 'A test package',
      readme: 'some readme',
      'dist-tags': { latest: '1.0.0' },
      versions: { '1.0.0': {} },
      time: {
        created: '2023-01-01T00:00:00Z',
        modified: '2024-01-01T00:00:00Z',
        '1.0.0': '2024-01-01T00:00:00Z',
      },
    };

    const result = proxy.filterMetadata(data, CUTOFF) as typeof data;
    expect(result.name).toBe('pkg');
    expect(result.description).toBe('A test package');
    expect(result.readme).toBe('some readme');
  });

  it('does not mutate the original data', () => {
    const data = {
      name: 'pkg',
      'dist-tags': { latest: '1.1.0' },
      versions: { '1.0.0': {}, '1.1.0': {} },
      time: {
        created: '2023-01-01T00:00:00Z',
        modified: '2024-02-01T00:00:00Z',
        '1.0.0': '2024-01-01T00:00:00Z',
        '1.1.0': '2024-02-01T00:00:00Z',
      },
    };

    const original = JSON.parse(JSON.stringify(data));
    proxy.filterMetadata(data, CUTOFF);
    expect(data).toEqual(original);
  });
});
