import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PypiRegistryProxy } from './pypi.ts';
import { makeHandle, makeReq, makeRes, responseBody } from './test-helpers.ts';

vi.mock('axios', () => ({
  default: { get: vi.fn() },
}));

import axios from 'axios';

const DELAY_MS = 7 * 24 * 60 * 60 * 1000;
const CUTOFF = new Date('2024-01-15T00:00:00Z');
const NOW = new Date(CUTOFF.getTime() + DELAY_MS);

const proxy = new PypiRegistryProxy({
  upstream: 'https://pypi.org',
  delayMs: DELAY_MS,
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

function makeSimpleFile(
  filename: string,
  uploadTime: string,
): Record<string, unknown> {
  return {
    filename,
    url: `https://files.pythonhosted.org/packages/${filename}`,
    hashes: { sha256: 'abc123' },
    'upload-time': uploadTime,
  };
}

function makeMetadataFile(uploadTime: string): Record<string, unknown> {
  return { upload_time_iso_8601: uploadTime, filename: 'pkg.tar.gz' };
}

describe('PypiRegistryProxy – routing', () => {
  it('routes /simple/{name}/ to simple API handler (not streamed)', async () => {
    const data = {
      meta: { 'api-version': '1.0' },
      name: 'requests',
      versions: [],
      files: [],
    };
    const res = await handle('/simple/requests/', data);
    expect(res.send).toHaveBeenCalled();
  });

  it('routes /pypi/{name}/json to JSON API handler (not redirected)', async () => {
    const data = {
      info: { name: 'requests', version: '2.28.0' },
      last_serial: 1,
      releases: {},
      urls: [],
    };
    const res = await handle('/pypi/requests/json', data);
    expect(res.redirect).not.toHaveBeenCalled();
  });

  it('redirects other paths as passthrough', async () => {
    const res = await handle('/packages/requests-2.28.0.tar.gz', {});
    expect(res.redirect).toHaveBeenCalledWith(
      302,
      'https://pypi.org/packages/requests-2.28.0.tar.gz',
    );
  });
});

describe('PypiRegistryProxy – simple API (/simple/{name}/)', () => {
  it('returns HTML by default', async () => {
    const data = {
      meta: { 'api-version': '1.0' },
      name: 'requests',
      versions: [],
      files: [],
    };
    const res = await handle('/simple/requests/', data);
    expect(res.setHeader).toHaveBeenCalledWith('content-type', 'text/html');
    expect(res.send).toHaveBeenCalled();
  });

  it('returns JSON when Accept header is application/vnd.pypi.simple.v1+json', async () => {
    const data = {
      meta: { 'api-version': '1.0' },
      name: 'requests',
      versions: [],
      files: [],
    };
    vi.mocked(axios.get).mockResolvedValue({ status: 200, data, headers: {} });
    const res = makeRes();
    await proxy.handleRequest(
      makeReq('/simple/requests/', {
        accept: 'application/vnd.pypi.simple.v1+json',
      }),
      res,
    );
    expect(res.setHeader).toHaveBeenCalledWith(
      'content-type',
      'application/vnd.pypi.simple.v1+json',
    );
    expect(res.json).toHaveBeenCalled();
  });

  it('filters out files published after cutoff', async () => {
    const data = {
      meta: { 'api-version': '1.0' },
      name: 'requests',
      versions: ['2.28.0', '2.29.0'],
      files: [
        makeSimpleFile('requests-2.28.0.tar.gz', '2024-01-01T00:00:00Z'), // before → allowed
        makeSimpleFile('requests-2.29.0.tar.gz', '2024-02-01T00:00:00Z'), // after  → filtered
      ],
    };
    vi.mocked(axios.get).mockResolvedValue({ status: 200, data, headers: {} });
    const res = makeRes();
    await proxy.handleRequest(
      makeReq('/simple/requests/', {
        accept: 'application/vnd.pypi.simple.v1+json',
      }),
      res,
    );
    const result = responseBody(res);
    expect((result['files'] as unknown[]).length).toBe(1);
    expect((result['files'] as Record<string, unknown>[])[0]['filename']).toBe(
      'requests-2.28.0.tar.gz',
    );
  });

  it('includes files published exactly at cutoff', async () => {
    const data = {
      meta: { 'api-version': '1.0' },
      name: 'requests',
      versions: ['2.28.0'],
      files: [makeSimpleFile('requests-2.28.0.tar.gz', '2024-01-15T00:00:00Z')],
    };
    vi.mocked(axios.get).mockResolvedValue({ status: 200, data, headers: {} });
    const res = makeRes();
    await proxy.handleRequest(
      makeReq('/simple/requests/', {
        accept: 'application/vnd.pypi.simple.v1+json',
      }),
      res,
    );
    const result = responseBody(res);
    expect((result['files'] as unknown[]).length).toBe(1);
    expect((result['files'] as Record<string, unknown>[])[0]['filename']).toBe(
      'requests-2.28.0.tar.gz',
    );
  });

  it('excludes files without upload-time', async () => {
    const data = {
      meta: { 'api-version': '1.0' },
      name: 'requests',
      versions: ['old'],
      files: [{ filename: 'requests-old.tar.gz', url: '...', hashes: {} }],
    };
    vi.mocked(axios.get).mockResolvedValue({ status: 200, data, headers: {} });
    const res = makeRes();
    await proxy.handleRequest(
      makeReq('/simple/requests/', {
        accept: 'application/vnd.pypi.simple.v1+json',
      }),
      res,
    );
    const result = responseBody(res);
    expect((result['files'] as unknown[]).length).toBe(0);
  });

  it('proxies upstream non-200 status', async () => {
    const res = await handle('/simple/requests/', { error: 'not found' }, 404);
    expect(res.status).toHaveBeenCalledWith(404);
  });
});

describe('PypiRegistryProxy – JSON API package-level (/pypi/{name}/json)', () => {
  it('filters out versions published after cutoff', async () => {
    const data = {
      info: { name: 'requests', version: '2.29.0' },
      last_serial: 1,
      releases: {
        '2.28.0': [makeMetadataFile('2024-01-01T00:00:00Z')], // before → allowed
        '2.29.0': [makeMetadataFile('2024-02-01T00:00:00Z')], // after  → filtered
      },
      urls: [makeMetadataFile('2024-02-01T00:00:00Z')],
    };
    const res = await handle('/pypi/requests/json', data);
    const result = responseBody(res);
    expect(Object.keys(result['releases'] as Record<string, unknown>)).toEqual([
      '2.28.0',
    ]);
  });

  it('includes versions published exactly at cutoff', async () => {
    const data = {
      info: { name: 'requests', version: '2.28.0' },
      last_serial: 1,
      releases: { '2.28.0': [makeMetadataFile('2024-01-15T00:00:00Z')] },
      urls: [],
    };
    const res = await handle('/pypi/requests/json', data);
    expect(res.status).toHaveBeenCalledWith(200);
    const result = responseBody(res);
    expect(Object.keys(result['releases'] as Record<string, unknown>)).toEqual([
      '2.28.0',
    ]);
  });

  it('updates info.version to the latest allowed version', async () => {
    const data = {
      info: { name: 'requests', version: '2.29.0' },
      last_serial: 1,
      releases: {
        '2.27.0': [makeMetadataFile('2024-01-01T00:00:00Z')],
        '2.28.0': [makeMetadataFile('2024-01-10T00:00:00Z')], // newest allowed
        '2.29.0': [makeMetadataFile('2024-02-01T00:00:00Z')], // filtered
      },
      urls: [makeMetadataFile('2024-02-01T00:00:00Z')],
    };
    const res = await handle('/pypi/requests/json', data);
    const result = responseBody(res);
    expect((result['info'] as Record<string, unknown>)['version']).toBe(
      '2.28.0',
    );
  });

  it('updates urls to files of the latest allowed version', async () => {
    const file2270 = makeMetadataFile('2024-01-01T00:00:00Z');
    const file2280 = makeMetadataFile('2024-01-10T00:00:00Z');
    const data = {
      info: { name: 'requests', version: '2.29.0' },
      last_serial: 1,
      releases: {
        '2.27.0': [file2270],
        '2.28.0': [file2280],
        '2.29.0': [makeMetadataFile('2024-02-01T00:00:00Z')],
      },
      urls: [makeMetadataFile('2024-02-01T00:00:00Z')],
    };
    const res = await handle('/pypi/requests/json', data);
    const result = responseBody(res);
    expect(result['urls']).toEqual([file2280]);
  });

  it('returns 200 with empty releases when all versions are after cutoff', async () => {
    const data = {
      info: { name: 'requests', version: '2.29.0' },
      last_serial: 1,
      releases: { '2.29.0': [makeMetadataFile('2024-02-01T00:00:00Z')] },
      urls: [],
    };
    const res = await handle('/pypi/requests/json', data);
    expect(res.status).toHaveBeenCalledWith(200);
    const result = responseBody(res);
    expect(Object.keys(result['releases'] as Record<string, unknown>)).toEqual(
      [],
    );
  });

  it('returns 200 with empty releases when all release file arrays are empty', async () => {
    const data = {
      info: { name: 'requests', version: '2.29.0' },
      last_serial: 1,
      releases: {
        '2.28.0': [], // empty → skipped
        '2.29.0': [makeMetadataFile('2024-02-01T00:00:00Z')], // filtered
      },
      urls: [],
    };
    const res = await handle('/pypi/requests/json', data);
    expect(res.status).toHaveBeenCalledWith(200);
    const result = responseBody(res);
    expect(Object.keys(result['releases'] as Record<string, unknown>)).toEqual(
      [],
    );
  });

  it('uses the earliest file upload time when a release has multiple files', async () => {
    const data = {
      info: { name: 'requests', version: '2.28.0' },
      last_serial: 1,
      releases: {
        '2.28.0': [
          makeMetadataFile('2024-01-10T00:00:00Z'), // earlier, before cutoff → allowed
          makeMetadataFile('2024-01-20T00:00:00Z'), // later, after cutoff
        ],
      },
      urls: [],
    };
    const res = await handle('/pypi/requests/json', data);
    expect(res.status).toHaveBeenCalledWith(200);
    const result = responseBody(res);
    expect(Object.keys(result['releases'] as Record<string, unknown>)).toEqual([
      '2.28.0',
    ]);
  });

  it('proxies upstream non-200 status', async () => {
    const res = await handle(
      '/pypi/requests/json',
      { error: 'not found' },
      404,
    );
    expect(res.status).toHaveBeenCalledWith(404);
  });
});

describe('PypiRegistryProxy – JSON API version-specific (/pypi/{name}/{version}/json)', () => {
  it('returns data when release files are before cutoff', async () => {
    const data = {
      info: { name: 'requests', version: '2.28.0' },
      last_serial: 1,
      releases: {
        '2.28.0': [makeMetadataFile('2024-01-01T00:00:00Z')], // before → allowed
      },
      urls: [makeMetadataFile('2024-01-01T00:00:00Z')],
    };
    const res = await handle('/pypi/requests/2.28.0/json', data);
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(data);
  });

  it('uses the earliest file upload time when a release has multiple files', async () => {
    const data = {
      info: { name: 'requests', version: '2.28.0' },
      last_serial: 1,
      releases: {
        '2.28.0': [
          makeMetadataFile('2024-01-10T00:00:00Z'), // earliest, before cutoff → version allowed
          makeMetadataFile('2024-01-20T00:00:00Z'), // later
        ],
      },
      urls: [],
    };
    const res = await handle('/pypi/requests/2.28.0/json', data);
    // earliest is before cutoff → allowed
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it('returns 200 with empty releases when the specific version is after cutoff', async () => {
    const data = {
      info: { name: 'requests', version: '2.29.0' },
      last_serial: 1,
      releases: { '2.29.0': [makeMetadataFile('2024-02-01T00:00:00Z')] }, // after cutoff → filtered
      urls: [makeMetadataFile('2024-02-01T00:00:00Z')],
    };
    const res = await handle('/pypi/requests/2.29.0/json', data);
    expect(res.status).toHaveBeenCalledWith(200);
    const result = responseBody(res);
    expect(Object.keys(result['releases'] as Record<string, unknown>)).toEqual([]);
  });

  it('proxies upstream non-200 status', async () => {
    const res = await handle(
      '/pypi/requests/2.29.0/json',
      { error: 'not found' },
      404,
    );
    expect(res.status).toHaveBeenCalledWith(404);
  });
});

describe('PypiRegistryProxy – passthrough', () => {
  it('redirects .tar.gz artifact', async () => {
    const res = await handle('/packages/requests-2.28.0.tar.gz', {});
    expect(res.redirect).toHaveBeenCalledWith(
      302,
      'https://pypi.org/packages/requests-2.28.0.tar.gz',
    );
  });

  it('redirects .whl artifact', async () => {
    const res = await handle('/packages/requests-2.28.0-py3-none-any.whl', {});
    expect(res.redirect).toHaveBeenCalledWith(
      302,
      'https://pypi.org/packages/requests-2.28.0-py3-none-any.whl',
    );
  });
});
