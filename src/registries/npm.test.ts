import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { NpmRegistryProxy } from './npm.ts';
import { makeHandle, responseBody } from './test-helpers.ts';

vi.mock('node:fs', () => ({
  readFileSync: vi.fn(),
}));

const mockReadFileSync = vi.mocked(readFileSync);

vi.mock('axios', () => ({
  default: { get: vi.fn() },
}));

import axios from 'axios';

const DELAY_MS = 7 * 24 * 60 * 60 * 1000;
const CUTOFF = new Date('2024-01-15T00:00:00Z');
const NOW = new Date(CUTOFF.getTime() + DELAY_MS);

const proxy = new NpmRegistryProxy({
  upstream: 'https://registry.npmjs.org',
  delayMs: DELAY_MS,
  maliciousDbPath: '/dev/null',
});

const handle = makeHandle(proxy, vi.mocked(axios.get));

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('NpmRegistryProxy – routing', () => {
  it('routes metadata paths to metadata handler (not redirected)', async () => {
    const res = await handle('/lodash', {
      name: 'lodash',
      versions: { '4.17.21': {} },
      time: { '4.17.21': '2024-01-01T00:00:00Z' },
      'dist-tags': { latest: '4.17.21' },
    });
    expect(res.redirect).not.toHaveBeenCalled();
  });

  it('redirects tarball when version is before cutoff', async () => {
    const res = await handle('/lodash/-/lodash-4.17.21.tgz', {
      name: 'lodash',
      versions: { '4.17.21': {} },
      time: { '4.17.21': '2024-01-01T00:00:00Z' }, // before cutoff
      'dist-tags': { latest: '4.17.21' },
    });
    expect(res.redirect).toHaveBeenCalledWith(
      307,
      'https://registry.npmjs.org/lodash/-/lodash-4.17.21.tgz',
    );
  });

  it('blocks tarball when version is after cutoff', async () => {
    const res = await handle('/lodash/-/lodash-4.17.21.tgz', {
      name: 'lodash',
      versions: { '4.17.21': {} },
      time: { '4.17.21': '2024-02-01T00:00:00Z' }, // after cutoff
      'dist-tags': { latest: '4.17.21' },
    });
    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.redirect).not.toHaveBeenCalled();
  });

  it('blocks tarball when metadata fetch returns non-200', async () => {
    const res = await handle('/lodash/-/lodash-4.17.21.tgz', {}, 404);
    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.redirect).not.toHaveBeenCalled();
  });

  it('passes through search API path without blocking', async () => {
    const res = await handle('/-/v1/search', {});
    expect(res.redirect).toHaveBeenCalledWith(
      307,
      'https://registry.npmjs.org/-/v1/search',
    );
    expect(res.status).not.toHaveBeenCalledWith(404);
  });

  it('redirects scoped package tarball when version is before cutoff', async () => {
    const res = await handle('/@babel/core/-/core-7.0.0.tgz', {
      name: '@babel/core',
      versions: { '7.0.0': {} },
      time: { '7.0.0': '2024-01-01T00:00:00Z' }, // before cutoff
      'dist-tags': { latest: '7.0.0' },
    });
    expect(res.redirect).toHaveBeenCalledWith(
      307,
      'https://registry.npmjs.org/@babel/core/-/core-7.0.0.tgz',
    );
  });
});

describe('NpmRegistryProxy – metadata filtering', () => {
  it('filters out versions published after cutoff date', async () => {
    const data = {
      name: 'pkg',
      'dist-tags': { latest: '1.0.0' },
      versions: { '1.0.0': {}, '1.1.0': {} },
      time: {
        created: '2023-01-01T00:00:00Z',
        modified: '2024-02-01T00:00:00Z',
        '1.0.0': '2024-01-01T00:00:00Z', // before cutoff -> allowed
        '1.1.0': '2024-02-01T00:00:00Z', // after cutoff -> filtered
      },
    };
    const res = await handle('/lodash', data);
    const result = responseBody(res);
    expect(Object.keys(result.versions as object)).toEqual(['1.0.0']);
    expect(Object.keys(result.time as object)).toContain('1.0.0');
    expect(Object.keys(result.time as object)).not.toContain('1.1.0');
  });

  it('includes versions published exactly at the cutoff date', async () => {
    const data = {
      name: 'pkg',
      'dist-tags': { latest: '1.0.0' },
      versions: { '1.0.0': {} },
      time: {
        created: '2023-01-01T00:00:00Z',
        modified: '2024-01-15T00:00:00Z',
        '1.0.0': '2024-01-15T00:00:00Z', // exactly at cutoff -> allowed
      },
    };
    const res = await handle('/lodash', data);
    const result = responseBody(res);
    expect(Object.keys(result.versions as object)).toEqual(['1.0.0']);
  });

  it('preserves special time keys: created and modified', async () => {
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
    const res = await handle('/lodash', data);
    const result = responseBody(res);
    expect((result.time as Record<string, string>).created).toBe(
      '2023-01-01T00:00:00Z',
    );
    expect((result.time as Record<string, string>).modified).toBe(
      '2024-02-01T00:00:00Z',
    );
  });

  it('redirects dist-tags to the latest allowed version when current tag is filtered', async () => {
    const data = {
      name: 'pkg',
      'dist-tags': { latest: '1.2.0' },
      versions: { '1.0.0': {}, '1.1.0': {}, '1.2.0': {} },
      time: {
        created: '2023-01-01T00:00:00Z',
        modified: '2024-02-01T00:00:00Z',
        '1.0.0': '2024-01-01T00:00:00Z', // allowed
        '1.1.0': '2024-01-10T00:00:00Z', // allowed (newer of the two)
        '1.2.0': '2024-02-01T00:00:00Z', // filtered
      },
    };
    const res = await handle('/lodash', data);
    const result = responseBody(res);
    expect((result['dist-tags'] as Record<string, string>).latest).toBe(
      '1.1.0',
    );
  });

  it('keeps dist-tags that already point to allowed versions', async () => {
    const data = {
      name: 'pkg',
      'dist-tags': { latest: '1.0.0', beta: '1.1.0' },
      versions: { '1.0.0': {}, '1.1.0': {} },
      time: {
        created: '2023-01-01T00:00:00Z',
        modified: '2024-01-10T00:00:00Z',
        '1.0.0': '2024-01-01T00:00:00Z', // allowed
        '1.1.0': '2024-01-10T00:00:00Z', // allowed
      },
    };
    const res = await handle('/lodash', data);
    const result = responseBody(res);
    expect((result['dist-tags'] as Record<string, string>).latest).toBe(
      '1.0.0',
    );
    expect((result['dist-tags'] as Record<string, string>).beta).toBe('1.1.0');
  });

  it('preserves other top-level package fields', async () => {
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
    const res = await handle('/lodash', data);
    const result = responseBody(res);
    expect(result.name).toBe('pkg');
    expect(result.description).toBe('A test package');
    expect(result.readme).toBe('some readme');
  });

  it('drops non-latest dist-tags that point to filtered versions', async () => {
    const data = {
      name: 'pkg',
      'dist-tags': { latest: '1.0.0', beta: '1.1.0' },
      versions: { '1.0.0': {}, '1.1.0': {} },
      time: {
        created: '2023-01-01T00:00:00Z',
        modified: '2024-02-01T00:00:00Z',
        '1.0.0': '2024-01-01T00:00:00Z', // allowed
        '1.1.0': '2024-02-01T00:00:00Z', // filtered
      },
    };
    const res = await handle('/lodash', data);
    const result = responseBody(res);
    expect((result['dist-tags'] as Record<string, string>).latest).toBe('1.0.0');
    expect((result['dist-tags'] as Record<string, string>).beta).toBeUndefined();
  });

  it('prefers same-major versions when latest is filtered (cross-major fallback)', async () => {
    const data = {
      name: 'pkg',
      'dist-tags': { latest: '2.1.0' }, // major 2, filtered
      versions: { '2.0.0': {}, '1.9.0': {}, '1.8.0': {} },
      time: {
        created: '2023-01-01T00:00:00Z',
        modified: '2024-02-01T00:00:00Z',
        '2.0.0': '2024-01-05T00:00:00Z', // allowed, same major as latest
        '1.9.0': '2024-01-10T00:00:00Z', // allowed, different major, newer date
        '1.8.0': '2024-01-01T00:00:00Z', // allowed, different major
        '2.1.0': '2024-02-01T00:00:00Z', // filtered
      },
    };
    const res = await handle('/lodash', data);
    const result = responseBody(res);
    // Must pick 2.0.0 (same major as original latest=2.1.0), not 1.9.0 (newer date but different major)
    expect((result['dist-tags'] as Record<string, string>).latest).toBe('2.0.0');
  });

  it('falls back to newest-by-date when no same-major versions are allowed', async () => {
    const data = {
      name: 'pkg',
      'dist-tags': { latest: '3.0.0' }, // major 3, filtered, no other v3
      versions: { '1.5.0': {}, '2.0.0': {} },
      time: {
        created: '2023-01-01T00:00:00Z',
        modified: '2024-02-01T00:00:00Z',
        '1.5.0': '2024-01-01T00:00:00Z', // allowed
        '2.0.0': '2024-01-10T00:00:00Z', // allowed, newer
        '3.0.0': '2024-02-01T00:00:00Z', // filtered
      },
    };
    const res = await handle('/lodash', data);
    const result = responseBody(res);
    // No v3.x allowed → fall back to newest overall (2.0.0)
    expect((result['dist-tags'] as Record<string, string>).latest).toBe('2.0.0');
  });

  it('drops the latest dist-tag when all versions are filtered', async () => {
    const data = {
      name: 'pkg',
      'dist-tags': { latest: '2.0.0' },
      versions: { '2.0.0': {} },
      time: {
        created: '2023-01-01T00:00:00Z',
        modified: '2024-02-01T00:00:00Z',
        '2.0.0': '2024-02-01T00:00:00Z', // filtered
      },
    };
    const res = await handle('/lodash', data);
    const result = responseBody(res);
    expect((result['dist-tags'] as Record<string, string>).latest).toBeUndefined();
  });

  it('proxies upstream non-200 status', async () => {
    const res = await handle('/lodash', { error: 'not found' }, 404);
    expect(res.status).toHaveBeenCalledWith(404);
  });
});

describe('NpmRegistryProxy – malicious filtering', () => {
  const MALICIOUS_DB = JSON.stringify({
    npm: { maliciousPackages: ['evil-pkg'], maliciousVersions: { 'bad-pkg': ['1.0.0'] } },
  });

  let maliciousProxy: NpmRegistryProxy;
  let maliciousHandle: ReturnType<typeof makeHandle>;

  beforeEach(() => {
    mockReadFileSync.mockReturnValue(MALICIOUS_DB);
    maliciousProxy = new NpmRegistryProxy({
      upstream: 'https://registry.npmjs.org',
      delayMs: DELAY_MS,
      maliciousDbPath: '/dev/null',
    });
    maliciousHandle = makeHandle(maliciousProxy, vi.mocked(axios.get));
  });

  afterEach(() => {
    mockReadFileSync.mockReset();
  });

  it('blocks all versions of a package listed in maliciousPackages', async () => {
    const data = {
      name: 'evil-pkg',
      'dist-tags': { latest: '1.0.0' },
      versions: { '1.0.0': {} },
      time: {
        created: '2023-01-01T00:00:00Z',
        modified: '2024-01-01T00:00:00Z',
        '1.0.0': '2024-01-01T00:00:00Z', // before cutoff → would pass delay filter
      },
    };
    const res = await maliciousHandle('/evil-pkg', data);
    const result = responseBody(res);
    expect(Object.keys(result.versions as object)).toEqual([]);
  });

  it('blocks specific malicious versions while keeping safe ones', async () => {
    const data = {
      name: 'bad-pkg',
      'dist-tags': { latest: '2.0.0' },
      versions: { '1.0.0': {}, '2.0.0': {} },
      time: {
        created: '2023-01-01T00:00:00Z',
        modified: '2024-01-10T00:00:00Z',
        '1.0.0': '2024-01-01T00:00:00Z', // before cutoff but malicious → blocked
        '2.0.0': '2024-01-10T00:00:00Z', // before cutoff and safe → allowed
      },
    };
    const res = await maliciousHandle('/bad-pkg', data);
    const result = responseBody(res);
    expect(Object.keys(result.versions as object)).toEqual(['2.0.0']);
    expect((result['dist-tags'] as Record<string, string>).latest).toBe('2.0.0');
  });

  it('does not filter packages absent from the malicious DB', async () => {
    const data = {
      name: 'safe-pkg',
      'dist-tags': { latest: '1.0.0' },
      versions: { '1.0.0': {} },
      time: {
        created: '2023-01-01T00:00:00Z',
        modified: '2024-01-01T00:00:00Z',
        '1.0.0': '2024-01-01T00:00:00Z',
      },
    };
    const res = await maliciousHandle('/safe-pkg', data);
    const result = responseBody(res);
    expect(Object.keys(result.versions as object)).toEqual(['1.0.0']);
  });
});
