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
});

const handle = makeHandle(proxy, mockedGet);

function makeVersion(
  number: string,
  createdAt: string,
): Record<string, unknown> {
  return { number, created_at: createdAt, authors: 'test' };
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

  it('redirects non-metadata paths as passthrough', async () => {
    const res = await handle('/gems/rails-7.0.0.gem', []);
    expect(res.redirect).toHaveBeenCalledWith(
      302,
      'https://rubygems.org/gems/rails-7.0.0.gem',
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
});

describe('RubygemsRegistryProxy – /info/{name}', () => {
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
});

describe('RubygemsRegistryProxy – malicious filtering', () => {
  const MALICIOUS_DB = JSON.stringify({
    maliciousPackages: ['evil-gem'],
    maliciousVersions: { rails: ['7.0.0'] },
  });

  let maliciousProxy: RubygemsRegistryProxy;
  let maliciousHandle: ReturnType<typeof makeHandle>;

  beforeEach(() => {
    mockedGet.mockReset();
    mockReadFileSync.mockReturnValue(MALICIOUS_DB);
    maliciousProxy = new RubygemsRegistryProxy({
      upstream: 'https://rubygems.org',
      delayMs: DELAY_MS,
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
