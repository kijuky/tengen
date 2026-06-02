import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { RubygemsRegistryProxy } from './rubygems.ts';
import { makeHandle, makeReq, makeRes } from './test-helpers.ts';

vi.mock('node:fs', () => ({
  readFileSync: vi.fn(),
}));

const mockReadFileSync = vi.mocked(readFileSync);

vi.mock('axios', () => {
  const fn = Object.assign(vi.fn(), { get: vi.fn() });
  return { default: fn };
});

import axios from 'axios';
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockedAxios = axios as any;
const mockedGet = vi.mocked(axios.get);

// Fix time so that: cutoffDate = Date.now() - delayMs = 2024-01-15T00:00:00Z
const DELAY_MS = 7 * 24 * 60 * 60 * 1000;
const CUTOFF = new Date('2024-01-15T00:00:00Z');
const NOW = new Date(CUTOFF.getTime() + DELAY_MS);

const proxy = new RubygemsRegistryProxy({
  upstream: 'https://rubygems.org',
  delayMs: DELAY_MS,
  maliciousDbPath: '/dev/null',
});

const handle = makeHandle(proxy, mockedGet);

function makeVersion(
  number: string,
  createdAt: string,
  platform = 'ruby',
): Record<string, unknown> {
  return { number, platform, created_at: createdAt, authors: 'test' };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('RubygemsRegistryProxy – routing', () => {
  it('routes /info/{name} to compact info handler (not redirected)', async () => {
    mockedGet
      .mockResolvedValueOnce({
        status: 200,
        data: '---\n1.0.0 |checksum:abc\n',
        headers: {},
      })
      .mockResolvedValueOnce({
        status: 200,
        data: [makeVersion('1.0.0', '2024-01-01T00:00:00Z')],
        headers: {},
      });
    const res = makeRes();
    await proxy.handleRequest(makeReq('/info/rails'), res);
    expect(res.redirect).not.toHaveBeenCalled();
  });

  it('routes /api/v1/versions/{name}.json to versions handler (not redirected)', async () => {
    const res = await handle('/api/v1/versions/rails.json', [
      makeVersion('7.0.0', '2024-01-01T00:00:00Z'),
    ]);
    expect(res.redirect).not.toHaveBeenCalled();
  });

  it('redirects non-metadata, non-download paths as passthrough', async () => {
    const res = makeRes();
    await proxy.handleRequest(makeReq('/quick/Marshal.4.8/rails-7.0.0.gemspec.rz'), res);
    expect(res.redirect).toHaveBeenCalledWith(
      307,
      'https://rubygems.org/quick/Marshal.4.8/rails-7.0.0.gemspec.rz',
    );
  });

  it('routes /versions without redirecting (proxied)', async () => {
    mockedAxios.mockResolvedValue({
      status: 200,
      data: '---\nrails 7.0.0 abc123\n',
      headers: {},
    });
    const res = makeRes();
    await proxy.handleRequest(makeReq('/versions'), res);
    expect(res.redirect).not.toHaveBeenCalled();
  });
});

describe('RubygemsRegistryProxy – /versions', () => {
  const VERSIONS_BODY = '---\nrails 7.0.0,7.1.0 abc123\n';

  it('proxies GET /versions and returns body (not a redirect)', async () => {
    mockedAxios.mockResolvedValue({
      status: 200,
      data: VERSIONS_BODY,
      headers: { 'content-type': 'text/plain' },
    });
    const res = makeRes();
    await proxy.handleRequest(makeReq('/versions'), res);
    expect(res.redirect).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(200);
    expect(vi.mocked(res.send)).toHaveBeenCalledWith(VERSIONS_BODY);
    expect(vi.mocked(res.end)).not.toHaveBeenCalled();
  });

  it('proxies HEAD /versions and calls res.end() without body', async () => {
    mockedAxios.mockResolvedValue({
      status: 200,
      data: '',
      headers: { etag: '"abc123"' },
    });
    const res = makeRes();
    await proxy.handleRequest(makeReq('/versions', {}, 'HEAD'), res);
    expect(res.redirect).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(200);
    expect(vi.mocked(res.end)).toHaveBeenCalled();
    expect(vi.mocked(res.send)).not.toHaveBeenCalled();
  });

  it('forwards ETag and Last-Modified headers', async () => {
    mockedAxios.mockResolvedValue({
      status: 200,
      data: VERSIONS_BODY,
      headers: {
        etag: '"abc"',
        'last-modified': 'Thu, 01 Jan 2026 00:00:00 GMT',
      },
    });
    const res = makeRes();
    await proxy.handleRequest(makeReq('/versions'), res);
    expect(vi.mocked(res.setHeader)).toHaveBeenCalledWith('etag', '"abc"');
    expect(vi.mocked(res.setHeader)).toHaveBeenCalledWith(
      'last-modified',
      'Thu, 01 Jan 2026 00:00:00 GMT',
    );
  });

  it('passes through non-200 upstream status', async () => {
    mockedAxios.mockResolvedValue({ status: 503, data: '', headers: {} });
    const res = makeRes();
    await proxy.handleRequest(makeReq('/versions'), res);
    expect(res.status).toHaveBeenCalledWith(503);
  });
});

describe('RubygemsRegistryProxy – /api/v1/versions/{name}.json', () => {
  it('filters out versions published after cutoff', async () => {
    const data = [
      makeVersion('7.0.0', '2024-01-01T00:00:00Z'), // before → allowed
      makeVersion('7.1.0', '2024-02-01T00:00:00Z'), // after  → filtered
    ];
    const res = await handle('/api/v1/versions/rails.json', data);
    expect(res.status).toHaveBeenCalledWith(200);
    const body = vi.mocked(res.json).mock.calls[0][0] as Array<
      Record<string, unknown>
    >;
    expect(body).toHaveLength(1);
    expect(body[0]['number']).toBe('7.0.0');
  });

  it('includes versions published exactly at cutoff', async () => {
    const res = await handle('/api/v1/versions/rails.json', [
      makeVersion('7.0.0', '2024-01-15T00:00:00Z'),
    ]);
    expect(res.status).toHaveBeenCalledWith(200);
    const body = vi.mocked(res.json).mock.calls[0][0] as unknown[];
    expect(body).toHaveLength(1);
  });

  it('proxies upstream non-200 status', async () => {
    const res = await handle(
      '/api/v1/versions/rails.json',
      { error: 'not found' },
      404,
    );
    expect(res.status).toHaveBeenCalledWith(404);
  });

  it('keeps platform-specific entries that share a version number with the ruby platform', async () => {
    // ffi 1.17.4 ships as both `ruby` and platform-specific gems. All variants
    // share `number: "1.17.4"` and must be retained when the date is allowed.
    const data = [
      makeVersion('1.17.4', '2024-01-01T00:00:00Z', 'ruby'),
      makeVersion('1.17.4', '2024-01-01T00:00:00Z', 'arm64-darwin'),
      makeVersion('1.17.4', '2024-01-01T00:00:00Z', 'x86_64-linux'),
    ];
    const res = await handle('/api/v1/versions/ffi.json', data);
    expect(res.status).toHaveBeenCalledWith(200);
    const body = vi.mocked(res.json).mock.calls[0][0] as Array<
      Record<string, unknown>
    >;
    expect(body).toHaveLength(3);
  });
});

describe('RubygemsRegistryProxy – /info/{name}', () => {
  beforeEach(() => {
    mockedGet.mockReset();
  });

  async function handleInfo(
    gemName: string,
    infoText: string,
    infoStatus: number,
    versionsData: unknown,
    versionsStatus: number,
  ) {
    mockedGet
      .mockResolvedValueOnce({
        status: infoStatus,
        data: infoText,
        headers: {},
      })
      .mockResolvedValueOnce({
        status: versionsStatus,
        data: versionsData,
        headers: {},
      });
    const res = makeRes();
    await proxy.handleRequest(makeReq(`/info/${gemName}`), res);
    return res;
  }

  it('returns filtered compact info excluding versions after cutoff', async () => {
    const res = await handleInfo(
      'rails',
      '---\n1.0.0 |checksum:abc\n1.1.0 |checksum:def\n',
      200,
      [
        makeVersion('1.0.0', '2024-01-01T00:00:00Z'), // before → allowed
        makeVersion('1.1.0', '2024-02-01T00:00:00Z'), // after  → filtered
      ],
      200,
    );

    expect(res.status).toHaveBeenCalledWith(200);
    expect(vi.mocked(res.type)).toHaveBeenCalledWith('text/plain');
    const body = vi.mocked(res.send).mock.calls[0][0] as string;
    expect(body).toContain('1.0.0');
    expect(body).not.toContain('1.1.0');
  });

  it('includes versions published exactly at cutoff', async () => {
    const res = await handleInfo(
      'rails',
      '---\n1.0.0 |checksum:abc\n',
      200,
      [makeVersion('1.0.0', '2024-01-15T00:00:00Z')],
      200,
    );

    expect(res.status).toHaveBeenCalledWith(200);
    const body = vi.mocked(res.send).mock.calls[0][0] as string;
    expect(body).toContain('1.0.0');
  });

  it('passes through unchanged when compact index has no --- separator line', async () => {
    // Compact index with unknown format (no ---) → returned as-is regardless of versions
    const infoText = '1.0.0 |checksum:abc\n';
    const res = await handleInfo(
      'rails',
      infoText,
      200,
      [makeVersion('1.0.0', '2024-01-01T00:00:00Z')],
      200,
    );

    expect(res.status).toHaveBeenCalledWith(200);
    const body = vi.mocked(res.send).mock.calls[0][0] as string;
    expect(body).toBe(infoText);
  });

  it('returns only the header when versions API returns non-200 (all versions excluded)', async () => {
    // When the secondary versions API call fails, getCompactIndexVersions returns [].
    // filterVersions([]) = [] → all version lines are filtered, only the header remains.
    const res = await handleInfo(
      'rails',
      '---\n1.0.0 |checksum:abc\n',
      200,
      null,
      503,
    );

    expect(res.status).toHaveBeenCalledWith(200);
    const body = vi.mocked(res.send).mock.calls[0][0] as string;
    expect(body).toContain('---');
    expect(body).not.toContain('1.0.0');
  });

  it('proxies non-200 status from info endpoint', async () => {
    const res = await handleInfo('unknown-gem', 'not found', 404, null, 404);

    expect(res.status).toHaveBeenCalledWith(404);
  });

  it('keeps platform-specific compact-index lines (e.g. 1.17.4-arm64-darwin)', async () => {
    const res = await handleInfo(
      'ffi',
      '---\n1.17.4 |checksum:abc\n1.17.4-arm64-darwin |checksum:def\n',
      200,
      [
        makeVersion('1.17.4', '2024-01-01T00:00:00Z', 'ruby'),
        makeVersion('1.17.4', '2024-01-01T00:00:00Z', 'arm64-darwin'),
      ],
      200,
    );

    expect(res.status).toHaveBeenCalledWith(200);
    const body = vi.mocked(res.send).mock.calls[0][0] as string;
    expect(body).toContain('1.17.4 ');
    expect(body).toContain('1.17.4-arm64-darwin');
  });
});

describe('RubygemsRegistryProxy – /gems/{name}-{version}.gem', () => {
  beforeEach(() => {
    mockedGet.mockReset();
  });

  it('allows download when version passes filter and redirects to upstream', async () => {
    const res = await handle('/gems/rails-7.0.0.gem', [
      makeVersion('7.0.0', '2024-01-01T00:00:00Z'), // before cutoff → allowed
    ]);
    expect(res.redirect).toHaveBeenCalledWith(
      307,
      'https://rubygems.org/gems/rails-7.0.0.gem',
    );
  });

  it('blocks download when version is after cutoff', async () => {
    const res = await handle('/gems/rails-7.1.0.gem', [
      makeVersion('7.1.0', '2024-02-01T00:00:00Z'), // after cutoff → blocked
    ]);
    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.redirect).not.toHaveBeenCalled();
  });

  it('blocks download when upstream returns non-200', async () => {
    const res = await handle('/gems/unknown-1.0.0.gem', null, 404);
    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.redirect).not.toHaveBeenCalled();
  });

  it('blocks download when requested version is not found in upstream response', async () => {
    const res = await handle('/gems/rails-7.0.0.gem', [
      makeVersion('7.1.0', '2024-01-01T00:00:00Z'), // different version
    ]);
    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.redirect).not.toHaveBeenCalled();
  });

  it('handles gem names with hyphens correctly', async () => {
    const res = await handle('/gems/aws-sdk-s3-1.0.0.gem', [
      makeVersion('1.0.0', '2024-01-01T00:00:00Z'),
    ]);
    expect(res.redirect).toHaveBeenCalledWith(
      307,
      'https://rubygems.org/gems/aws-sdk-s3-1.0.0.gem',
    );
  });

  it('allows download of platform-specific gems (e.g. arm64-darwin)', async () => {
    // The JSON API exposes platform as a separate field while the filename
    // embeds it as `{number}-{platform}`. The matcher must reconstruct the key.
    const res = await handle('/gems/ffi-1.17.4-arm64-darwin.gem', [
      makeVersion('1.17.4', '2024-01-01T00:00:00Z', 'ruby'),
      makeVersion('1.17.4', '2024-01-01T00:00:00Z', 'arm64-darwin'),
    ]);
    expect(res.redirect).toHaveBeenCalledWith(
      307,
      'https://rubygems.org/gems/ffi-1.17.4-arm64-darwin.gem',
    );
  });

  it('allows download of multi-segment-platform gems (e.g. x86-mingw32)', async () => {
    const res = await handle('/gems/mysql-2.9.1-x86-mingw32.gem', [
      makeVersion('2.9.1', '2024-01-01T00:00:00Z', 'x86-mingw32'),
    ]);
    expect(res.redirect).toHaveBeenCalledWith(
      307,
      'https://rubygems.org/gems/mysql-2.9.1-x86-mingw32.gem',
    );
  });

  it('blocks platform-specific download when version is after cutoff', async () => {
    const res = await handle('/gems/ffi-1.17.4-arm64-darwin.gem', [
      makeVersion('1.17.4', '2024-02-01T00:00:00Z', 'arm64-darwin'),
    ]);
    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.redirect).not.toHaveBeenCalled();
  });

  it('allows download when gem name contains a digit-prefixed segment (e.g. mail-iso-2022-jp)', async () => {
    // The filename "mail-iso-2022-jp-2.1.0.gem" can be split two ways:
    //   ["mail-iso-2022-jp", "2.1.0"]  ← correct
    //   ["mail-iso",         "2022-jp-2.1.0"]
    // Candidates are verified against upstream; the right-to-left split is
    // tried first and matches, so only one upstream call is needed here.
    mockedGet.mockResolvedValueOnce({
      status: 200,
      data: [makeVersion('2.1.0', '2024-01-01T00:00:00Z')],
      headers: {},
    });
    const res = makeRes();
    await proxy.handleRequest(
      makeReq('/gems/mail-iso-2022-jp-2.1.0.gem'),
      res,
    );
    expect(mockedGet).toHaveBeenCalledWith(
      'https://rubygems.org/api/v1/versions/mail-iso-2022-jp.json',
      expect.anything(),
    );
    expect(res.redirect).toHaveBeenCalledWith(
      307,
      'https://rubygems.org/gems/mail-iso-2022-jp-2.1.0.gem',
    );
  });

  it('falls back to a wider gem-name candidate when the narrower one is unknown upstream', async () => {
    // Hypothetical gem "foo-1bar-2.0.0" where "foo" is not a real gem but
    // "foo-1bar" is. The first candidate (foo-1bar / 2.0.0) succeeds upstream.
    mockedGet.mockResolvedValueOnce({
      status: 200,
      data: [makeVersion('2.0.0', '2024-01-01T00:00:00Z')],
      headers: {},
    });
    const res = makeRes();
    await proxy.handleRequest(makeReq('/gems/foo-1bar-2.0.0.gem'), res);
    expect(mockedGet).toHaveBeenNthCalledWith(
      1,
      'https://rubygems.org/api/v1/versions/foo-1bar.json',
      expect.anything(),
    );
    expect(res.redirect).toHaveBeenCalledWith(
      307,
      'https://rubygems.org/gems/foo-1bar-2.0.0.gem',
    );
  });

  it('tries the next candidate when the upstream versions list does not contain the requested version', async () => {
    // For "mail-iso-2022-jp-2.1.0.gem", the first split tried is
    // ["mail-iso-2022-jp", "2.1.0"]. If upstream's mail-iso-2022-jp version
    // list does not include 2.1.0, we should fall through to the next split
    // ["mail-iso", "2022-jp-2.1.0"] before giving up.
    mockedGet
      .mockResolvedValueOnce({
        status: 200,
        data: [makeVersion('1.0.0', '2024-01-01T00:00:00Z')], // no 2.1.0
        headers: {},
      })
      .mockResolvedValueOnce({
        status: 200,
        data: [makeVersion('2022-jp-2.1.0', '2024-01-01T00:00:00Z')],
        headers: {},
      });
    const res = makeRes();
    await proxy.handleRequest(
      makeReq('/gems/mail-iso-2022-jp-2.1.0.gem'),
      res,
    );
    expect(mockedGet).toHaveBeenNthCalledWith(
      1,
      'https://rubygems.org/api/v1/versions/mail-iso-2022-jp.json',
      expect.anything(),
    );
    expect(mockedGet).toHaveBeenNthCalledWith(
      2,
      'https://rubygems.org/api/v1/versions/mail-iso.json',
      expect.anything(),
    );
    expect(res.redirect).toHaveBeenCalledWith(
      307,
      'https://rubygems.org/gems/mail-iso-2022-jp-2.1.0.gem',
    );
  });

  it('blocks the download when no candidate matches upstream', async () => {
    mockedGet.mockResolvedValue({
      status: 404,
      data: { error: 'not found' },
      headers: {},
    });
    const res = makeRes();
    await proxy.handleRequest(
      makeReq('/gems/mail-iso-2022-jp-2.1.0.gem'),
      res,
    );
    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.redirect).not.toHaveBeenCalled();
  });
});

describe('RubygemsRegistryProxy – malicious filtering', () => {
  const MALICIOUS_DB = JSON.stringify({
    rubygems: { maliciousPackages: ['evil-gem'], maliciousVersions: { rails: ['7.0.0'] } },
  });

  let maliciousProxy: RubygemsRegistryProxy;
  let maliciousHandle: ReturnType<typeof makeHandle>;

  beforeEach(() => {
    mockedGet.mockReset();
    mockReadFileSync.mockReturnValue(MALICIOUS_DB);
    maliciousProxy = new RubygemsRegistryProxy({
      upstream: 'https://rubygems.org',
      delayMs: DELAY_MS,
      maliciousDbPath: '/dev/null',
    });
    maliciousHandle = makeHandle(maliciousProxy, mockedGet);
  });

  afterEach(() => {
    mockReadFileSync.mockReset();
  });

  it('blocks all versions of a fully malicious gem (/api/v1/versions/)', async () => {
    mockedGet.mockResolvedValueOnce({
      status: 200,
      data: [makeVersion('1.0.0', '2024-01-01T00:00:00Z')],
      headers: {},
    });
    const res = makeRes();
    await maliciousProxy.handleRequest(makeReq('/api/v1/versions/evil-gem.json'), res);
    expect(res.json).toHaveBeenCalledWith([]);
  });

  it('blocks a specific malicious version while keeping safe ones (/api/v1/versions/)', async () => {
    const data = [
      makeVersion('7.0.0', '2024-01-01T00:00:00Z'), // malicious → blocked
      makeVersion('7.1.0', '2024-01-10T00:00:00Z'), // safe → allowed
    ];
    const res = await maliciousHandle('/api/v1/versions/rails.json', data);
    const body = vi.mocked(res.json).mock.calls[0][0] as Array<Record<string, unknown>>;
    expect(body).toHaveLength(1);
    expect(body[0]['number']).toBe('7.1.0');
  });

  it('removes all version lines for a fully malicious gem (/info/)', async () => {
    mockedGet
      .mockResolvedValueOnce({
        status: 200,
        data: '---\n1.0.0 |checksum:abc\n',
        headers: {},
      })
      .mockResolvedValueOnce({
        status: 200,
        data: [makeVersion('1.0.0', '2024-01-01T00:00:00Z')],
        headers: {},
      });
    const res = makeRes();
    await maliciousProxy.handleRequest(makeReq('/info/evil-gem'), res);
    const body = vi.mocked(res.send).mock.calls[0][0] as string;
    expect(body).toContain('---');
    expect(body).not.toContain('1.0.0');
  });

  it('removes only the malicious version line (/info/)', async () => {
    mockedGet
      .mockResolvedValueOnce({
        status: 200,
        data: '---\n7.0.0 |checksum:abc\n7.1.0 |checksum:def\n',
        headers: {},
      })
      .mockResolvedValueOnce({
        status: 200,
        data: [
          makeVersion('7.0.0', '2024-01-01T00:00:00Z'), // malicious → blocked
          makeVersion('7.1.0', '2024-01-10T00:00:00Z'), // safe → allowed
        ],
        headers: {},
      });
    const res = makeRes();
    await maliciousProxy.handleRequest(makeReq('/info/rails'), res);
    const body = vi.mocked(res.send).mock.calls[0][0] as string;
    expect(body).not.toContain('7.0.0');
    expect(body).toContain('7.1.0');
  });
});
