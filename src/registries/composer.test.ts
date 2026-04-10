import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ComposerRegistryProxy } from './composer.ts';
import { makeHandle, responseBody } from './test-helpers.ts';

vi.mock('axios', () => ({
  default: { get: vi.fn() },
}));

import axios from 'axios';

// Fix time so that: cutoffDate = Date.now() - delayMs = 2024-01-15T00:00:00Z
const DELAY_MS = 7 * 24 * 60 * 60 * 1000;
const CUTOFF = new Date('2024-01-15T00:00:00Z');
const NOW = new Date(CUTOFF.getTime() + DELAY_MS);

const proxy = new ComposerRegistryProxy({
  upstream: 'https://packagist.org',
  delayMs: DELAY_MS,
});

const handle = makeHandle(proxy, vi.mocked(axios.get));

function makeVersion(
  version: string,
  versionNormalized: string,
  time: string,
): Record<string, unknown> {
  return { version, version_normalized: versionNormalized, time };
}
beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('ComposerRegistryProxy – routing', () => {
  it('routes /packages.json to metadata handler (not redirected)', async () => {
    const res = await handle('/packages.json', {});
    expect(res.redirect).not.toHaveBeenCalled();
  });

  it('routes /p2/vendor/package.json to metadata handler (not redirected)', async () => {
    const res = await handle('/p2/vendor/package.json', {});
    expect(res.redirect).not.toHaveBeenCalled();
  });

  it('routes /p2/vendor/package~dev.json to metadata handler (not redirected)', async () => {
    const res = await handle('/p2/vendor/package~dev.json', {});
    expect(res.redirect).not.toHaveBeenCalled();
  });

  it('redirects non-metadata paths as passthrough', async () => {
    const res = await handle('/downloads/vendor/package/1.0.0.zip', {});
    expect(res.redirect).toHaveBeenCalledWith(
      302,
      'https://packagist.org/downloads/vendor/package/1.0.0.zip',
    );
  });
});

describe('ComposerRegistryProxy – packages.json URL rewriting', () => {
  it('rewrites all absolute URLs to proxy-relative paths', async () => {
    const data = {
      'metadata-url': 'https://repo.packagist.org/p2/%package%.json',
      'providers-url': '/p/%package%$%hash%.json',
      'metadata-changes-url': 'https://packagist.org/metadata/changes.json',
      'notify-batch': 'https://packagist.org/downloads/',
      search: 'https://packagist.org/search.json?q=%query%&type=%type%',
      list: 'https://packagist.org/packages/list.json',
      'providers-api': 'https://packagist.org/providers/%package%.json',
      'security-advisories': {
        metadata: true,
        'api-url': 'https://packagist.org/api/security-advisories/',
      },
      packages: [],
    };
    const res = await handle('/packages.json', data);

    expect(res.status).toHaveBeenCalledWith(200);
    const result = responseBody(res);
    expect(result['metadata-url']).toBe('/composer/p2/%package%.json');
    expect(result['providers-url']).toBe('/composer/p/%package%$%hash%.json');
    expect(result['metadata-changes-url']).toBe(
      '/composer/metadata/changes.json',
    );
    expect(result['notify-batch']).toBe('/composer/downloads/');
    expect(result['search']).toBe(
      '/composer/search.json?q=%query%&type=%type%',
    );
    expect(result['list']).toBe('/composer/packages/list.json');
    expect(result['providers-api']).toBe('/composer/providers/%package%.json');
    expect(
      (result['security-advisories'] as Record<string, unknown>)['api-url'],
    ).toBe('/composer/api/security-advisories/');
  });

  it('rewrites already-relative metadata-url to a proxy-prefixed path', async () => {
    const data = { 'metadata-url': '/p2/%package%.json', packages: [] };
    const res = await handle('/packages.json', data);
    const result = responseBody(res);
    expect(result['metadata-url']).toBe('/composer/p2/%package%.json');
  });

  it('passes through data with unrecognized structure unchanged', async () => {
    const data = { foo: 'bar' };
    const res = await handle('/packages.json', data);
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(data);
  });
});

describe('ComposerRegistryProxy – package metadata filtering', () => {
  it('filters out versions published after cutoff date', async () => {
    const data = {
      packages: {
        'symfony/console': [
          makeVersion('6.0.0', '6.0.0.0', '2024-01-01T00:00:00Z'), // before → allowed
          makeVersion('6.1.0', '6.1.0.0', '2024-02-01T00:00:00Z'), // after  → filtered
        ],
      },
      minified: 'composer/2.0',
    };
    const res = await handle('/p2/symfony/console.json', data);
    const result = responseBody(res);
    const versions = (result['packages'] as Record<string, unknown[]>)[
      'symfony/console'
    ];
    expect(versions).toHaveLength(1);
    expect((versions[0] as Record<string, unknown>)['version']).toBe('6.0.0');
  });

  it('includes versions published exactly at the cutoff date', async () => {
    const data = {
      packages: {
        'symfony/console': [
          makeVersion('6.0.0', '6.0.0.0', '2024-01-15T00:00:00Z'),
        ],
      },
    };
    const res = await handle('/p2/symfony/console.json', data);
    const result = responseBody(res);
    const versions = (result['packages'] as Record<string, unknown[]>)[
      'symfony/console'
    ];
    expect(versions).toHaveLength(1);
  });

  it('propagates time through minified diff-chain before filtering (newest-first real-world format)', async () => {
    // Packagist minified: newest first, subsequent entries only carry changed fields.
    // The oldest entry has no `time` field — it must inherit from the entry above it.
    const data = {
      packages: {
        'symfony/console': [
          // newest first (after cutoff → filtered); carries time
          {
            version: '6.1.0',
            version_normalized: '6.1.0.0',
            time: '2024-02-01T00:00:00Z',
          },
          // older (before cutoff → kept); no time field: inherits from entry above
          {
            version: '6.0.0',
            version_normalized: '6.0.0.0',
            time: '2024-01-01T00:00:00Z',
          },
          // oldest (before cutoff → kept); no time field: must inherit "2024-01-01"
          {
            version: '5.0.0',
            version_normalized: '5.0.0.0',
          },
        ],
      },
      minified: 'composer/2.0',
    };
    const res = await handle('/p2/symfony/console.json', data);
    const result = responseBody(res);
    const versions = (result['packages'] as Record<string, unknown[]>)[
      'symfony/console'
    ];
    expect(versions).toHaveLength(2);
    expect((versions[0] as Record<string, unknown>)['version']).toBe('6.0.0');
    expect((versions[1] as Record<string, unknown>)['version']).toBe('5.0.0');
    // 5.0.0 was not incorrectly filtered out (it inherited time "2024-01-01" from 6.0.0).
    // After re-minification the time field is omitted because it equals the previous entry.
    expect((versions[1] as Record<string, unknown>)['time']).toBeUndefined();
  });

  it('returns 404 when all versions are filtered out', async () => {
    const data = {
      packages: {
        'symfony/console': [
          makeVersion('6.1.0', '6.1.0.0', '2024-02-01T00:00:00Z'), // after cutoff
        ],
      },
    };
    const res = await handle('/p2/symfony/console.json', data);
    expect(res.status).toHaveBeenCalledWith(404);
  });
});
