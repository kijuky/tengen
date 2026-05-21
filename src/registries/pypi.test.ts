import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { PypiRegistryProxy } from './pypi.ts';
import { makeHandle, makeReq, makeRes, responseBody } from './test-helpers.ts';

vi.mock('axios', () => ({
  default: { get: vi.fn() },
}));
vi.mock('node:fs', () => ({
  readFileSync: vi.fn(),
}));

import axios from 'axios';
const mockReadFileSync = vi.mocked(readFileSync);

const DELAY_MS = 7 * 24 * 60 * 60 * 1000;
const CUTOFF = new Date('2024-01-15T00:00:00Z');
const NOW = new Date(CUTOFF.getTime() + DELAY_MS);

const proxy = new PypiRegistryProxy({
  upstream: 'https://pypi.org',
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

  it('routes /packages/ paths to download handler', async () => {
    const data = {
      meta: { 'api-version': '1.0' },
      name: 'requests',
      versions: ['2.28.0'],
      files: [makeSimpleFile('requests-2.28.0.tar.gz', '2024-01-01T00:00:00Z')],
    };
    vi.mocked(axios.get).mockResolvedValue({ status: 200, data, headers: {} });
    const res = makeRes();
    await proxy.handleRequest(makeReq('/packages/requests-2.28.0.tar.gz'), res);
    expect(res.send).not.toHaveBeenCalled();
    expect(res.redirect).toHaveBeenCalledWith(302, 'https://pypi.org/packages/requests-2.28.0.tar.gz');
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

  it('rewrites file URLs to proxy-relative paths in JSON response', async () => {
    const data = {
      meta: { 'api-version': '1.0' },
      name: 'requests',
      versions: ['2.28.0'],
      files: [makeSimpleFile('requests-2.28.0.tar.gz', '2024-01-01T00:00:00Z')],
    };
    vi.mocked(axios.get).mockResolvedValue({ status: 200, data, headers: {} });
    const res = makeRes();
    await proxy.handleRequest(
      makeReq('/simple/requests/', { accept: 'application/vnd.pypi.simple.v1+json' }),
      res,
    );
    const result = responseBody(res);
    const files = result['files'] as Record<string, unknown>[];
    expect(files[0]['url']).toBe('/pypi/packages/requests-2.28.0.tar.gz');
  });

  it('rewrites file URLs to proxy-relative paths in HTML response', async () => {
    const data = {
      meta: { 'api-version': '1.0' },
      name: 'requests',
      versions: ['2.28.0'],
      files: [makeSimpleFile('requests-2.28.0.tar.gz', '2024-01-01T00:00:00Z')],
    };
    vi.mocked(axios.get).mockResolvedValue({ status: 200, data, headers: {} });
    const res = makeRes();
    await proxy.handleRequest(makeReq('/simple/requests/'), res);
    const html = vi.mocked(res.send).mock.calls[0][0] as string;
    expect(html).toContain('href="/pypi/packages/requests-2.28.0.tar.gz"');
    expect(html).not.toContain('files.pythonhosted.org');
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

describe('PypiRegistryProxy – download route (/packages/...)', () => {
  it('redirects .tar.gz artifact when version is within delay', async () => {
    const data = {
      meta: { 'api-version': '1.0' },
      name: 'requests',
      versions: ['2.28.0'],
      files: [makeSimpleFile('requests-2.28.0.tar.gz', '2024-01-01T00:00:00Z')],
    };
    vi.mocked(axios.get).mockResolvedValue({ status: 200, data, headers: {} });
    const res = makeRes();
    await proxy.handleRequest(makeReq('/packages/requests-2.28.0.tar.gz'), res);
    expect(res.redirect).toHaveBeenCalledWith(302, 'https://pypi.org/packages/requests-2.28.0.tar.gz');
  });

  it('redirects .whl artifact when version is within delay', async () => {
    const data = {
      meta: { 'api-version': '1.0' },
      name: 'requests',
      versions: ['2.28.0'],
      files: [makeSimpleFile('requests-2.28.0-py3-none-any.whl', '2024-01-01T00:00:00Z')],
    };
    vi.mocked(axios.get).mockResolvedValue({ status: 200, data, headers: {} });
    const res = makeRes();
    await proxy.handleRequest(makeReq('/packages/requests-2.28.0-py3-none-any.whl'), res);
    expect(res.redirect).toHaveBeenCalledWith(302, 'https://pypi.org/packages/requests-2.28.0-py3-none-any.whl');
  });

  it('redirects artifact at nested /packages/{a}/{b}/{c}/{file} path', async () => {
    const data = {
      meta: { 'api-version': '1.0' },
      name: 'requests',
      versions: ['2.28.0'],
      files: [makeSimpleFile('requests-2.28.0.tar.gz', '2024-01-01T00:00:00Z')],
    };
    vi.mocked(axios.get).mockResolvedValue({ status: 200, data, headers: {} });
    const res = makeRes();
    await proxy.handleRequest(makeReq('/packages/ab/cd/ef123/requests-2.28.0.tar.gz'), res);
    expect(res.redirect).toHaveBeenCalledWith(302, 'https://pypi.org/packages/ab/cd/ef123/requests-2.28.0.tar.gz');
  });

  it('returns 404 when version is too new', async () => {
    const data = {
      meta: { 'api-version': '1.0' },
      name: 'requests',
      versions: ['2.29.0'],
      files: [makeSimpleFile('requests-2.29.0.tar.gz', '2024-02-01T00:00:00Z')],
    };
    vi.mocked(axios.get).mockResolvedValue({ status: 200, data, headers: {} });
    const res = makeRes();
    await proxy.handleRequest(makeReq('/packages/requests-2.29.0.tar.gz'), res);
    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.redirect).not.toHaveBeenCalled();
  });

  it('returns 404 when file is not found in Simple API', async () => {
    const data = {
      meta: { 'api-version': '1.0' },
      name: 'requests',
      versions: [],
      files: [],
    };
    vi.mocked(axios.get).mockResolvedValue({ status: 200, data, headers: {} });
    const res = makeRes();
    await proxy.handleRequest(makeReq('/packages/requests-2.28.0.tar.gz'), res);
    expect(res.status).toHaveBeenCalledWith(404);
  });

  it('returns 404 when Simple API returns non-200', async () => {
    vi.mocked(axios.get).mockResolvedValue({ status: 404, data: {}, headers: {} });
    const res = makeRes();
    await proxy.handleRequest(makeReq('/packages/requests-2.28.0.tar.gz'), res);
    expect(res.status).toHaveBeenCalledWith(404);
  });

  it('redirects .whl.metadata artifact by looking up the corresponding .whl in Simple API', async () => {
    const data = {
      meta: { 'api-version': '1.0' },
      name: 'boto3',
      versions: ['1.35.90'],
      files: [makeSimpleFile('boto3-1.35.90-py3-none-any.whl', '2024-01-01T00:00:00Z')],
    };
    vi.mocked(axios.get).mockResolvedValue({ status: 200, data, headers: {} });
    const res = makeRes();
    await proxy.handleRequest(
      makeReq('/packages/5c/f9/abc/boto3-1.35.90-py3-none-any.whl.metadata'),
      res,
    );
    expect(res.redirect).toHaveBeenCalledWith(
      302,
      'https://pypi.org/packages/5c/f9/abc/boto3-1.35.90-py3-none-any.whl.metadata',
    );
  });

  it('returns 404 for .whl.metadata when version is too new', async () => {
    const data = {
      meta: { 'api-version': '1.0' },
      name: 'boto3',
      versions: ['1.35.90'],
      files: [makeSimpleFile('boto3-1.35.90-py3-none-any.whl', '2024-02-01T00:00:00Z')],
    };
    vi.mocked(axios.get).mockResolvedValue({ status: 200, data, headers: {} });
    const res = makeRes();
    await proxy.handleRequest(
      makeReq('/packages/5c/f9/abc/boto3-1.35.90-py3-none-any.whl.metadata'),
      res,
    );
    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.redirect).not.toHaveBeenCalled();
  });
});

describe('PypiRegistryProxy – namespace packages with dots in name', () => {
  it('redirects .whl with dots in package name (e.g. ruamel.yaml.clib)', async () => {
    const data = {
      meta: { 'api-version': '1.0' },
      name: 'ruamel-yaml-clib',
      versions: ['0.2.14'],
      files: [makeSimpleFile('ruamel.yaml.clib-0.2.14-cp314-cp314-macosx_15_0_arm64.whl', '2024-01-01T00:00:00Z')],
    };
    vi.mocked(axios.get).mockResolvedValue({ status: 200, data, headers: {} });
    const res = makeRes();
    await proxy.handleRequest(
      makeReq('/packages/6b/fa/3234f913fe9a6525a7b97c6dad1f51e72b917e6872e051a5e2ffd8b16fbb/ruamel.yaml.clib-0.2.14-cp314-cp314-macosx_15_0_arm64.whl'),
      res,
    );
    expect(vi.mocked(axios.get)).toHaveBeenCalledWith(
      expect.stringContaining('/simple/ruamel-yaml-clib/'),
      expect.anything(),
    );
    expect(res.redirect).toHaveBeenCalledWith(
      302,
      expect.stringContaining('ruamel.yaml.clib-0.2.14-cp314-cp314-macosx_15_0_arm64.whl'),
    );
  });

  it('redirects .tar.gz with dots in package name', async () => {
    const data = {
      meta: { 'api-version': '1.0' },
      name: 'ruamel-yaml-clib',
      versions: ['0.2.14'],
      files: [makeSimpleFile('ruamel.yaml.clib-0.2.14.tar.gz', '2024-01-01T00:00:00Z')],
    };
    vi.mocked(axios.get).mockResolvedValue({ status: 200, data, headers: {} });
    const res = makeRes();
    await proxy.handleRequest(
      makeReq('/packages/ab/cd/ruamel.yaml.clib-0.2.14.tar.gz'),
      res,
    );
    expect(vi.mocked(axios.get)).toHaveBeenCalledWith(
      expect.stringContaining('/simple/ruamel-yaml-clib/'),
      expect.anything(),
    );
    expect(res.redirect).toHaveBeenCalledWith(
      302,
      expect.stringContaining('ruamel.yaml.clib-0.2.14.tar.gz'),
    );
  });

  it('filters versions for simple API with dotted package names', async () => {
    const data = {
      meta: { 'api-version': '1.0' },
      name: 'ruamel-yaml-clib',
      versions: ['0.2.14'],
      files: [makeSimpleFile('ruamel.yaml.clib-0.2.14-cp314-cp314-macosx_15_0_arm64.whl', '2024-01-01T00:00:00Z')],
    };
    vi.mocked(axios.get).mockResolvedValue({ status: 200, data, headers: {} });
    const res = makeRes();
    await proxy.handleRequest(
      makeReq('/simple/ruamel-yaml-clib/', { accept: 'application/vnd.pypi.simple.v1+json' }),
      res,
    );
    const result = responseBody(res);
    expect((result['files'] as unknown[]).length).toBe(1);
    expect((result['versions'] as unknown[]).length).toBe(1);
  });
});

describe('PypiRegistryProxy – malicious filtering', () => {
  const MALICIOUS_DB = JSON.stringify({
    pypi: { maliciousPackages: ['evil-pkg'], maliciousVersions: { 'requests': ['2.28.0'] } },
  });

  let maliciousProxy: PypiRegistryProxy;
  let maliciousHandle: ReturnType<typeof makeHandle>;

  beforeEach(() => {
    mockReadFileSync.mockReturnValue(MALICIOUS_DB);
    maliciousProxy = new PypiRegistryProxy({
      upstream: 'https://pypi.org',
      delayMs: DELAY_MS,
      maliciousDbPath: '/dev/null',
    });
    maliciousHandle = makeHandle(maliciousProxy, vi.mocked(axios.get));
  });

  afterEach(() => {
    mockReadFileSync.mockReset();
  });

  it('blocks all files of a fully malicious package (simple API)', async () => {
    const data = {
      meta: { 'api-version': '1.0' },
      name: 'evil-pkg',
      versions: ['1.0.0'],
      files: [makeSimpleFile('evil-pkg-1.0.0.tar.gz', '2024-01-01T00:00:00Z')],
    };
    vi.mocked(axios.get).mockResolvedValue({ status: 200, data, headers: {} });
    const res = makeRes();
    await maliciousProxy.handleRequest(
      makeReq('/simple/evil-pkg/', { accept: 'application/vnd.pypi.simple.v1+json' }),
      res,
    );
    const result = responseBody(res);
    expect((result['files'] as unknown[]).length).toBe(0);
    expect((result['versions'] as unknown[]).length).toBe(0);
  });

  it('blocks specific malicious versions while keeping safe ones (simple API)', async () => {
    const data = {
      meta: { 'api-version': '1.0' },
      name: 'requests',
      versions: ['2.28.0', '2.29.0'],
      files: [
        makeSimpleFile('requests-2.28.0.tar.gz', '2024-01-01T00:00:00Z'), // malicious → blocked
        makeSimpleFile('requests-2.29.0.tar.gz', '2024-01-10T00:00:00Z'), // safe → allowed
      ],
    };
    vi.mocked(axios.get).mockResolvedValue({ status: 200, data, headers: {} });
    const res = makeRes();
    await maliciousProxy.handleRequest(
      makeReq('/simple/requests/', { accept: 'application/vnd.pypi.simple.v1+json' }),
      res,
    );
    const result = responseBody(res);
    const files = result['files'] as Record<string, unknown>[];
    expect(files.length).toBe(1);
    expect(files[0]['filename']).toBe('requests-2.29.0.tar.gz');
  });

  it('does not leak a malicious version whose number is a prefix of a safe one (simple API)', async () => {
    // Regression: substring matching on `-${ver}.` made `requests-2.28.0.*`
    // match `ver="2.28"` too, so a malicious 2.28.0 could slip through under
    // the 2.28 label even when 2.28.0 itself was in the malicious DB.
    const maliciousDb = JSON.stringify({
      pypi: {
        maliciousPackages: [],
        maliciousVersions: { requests: ['2.28.0'] },
      },
    });
    mockReadFileSync.mockReturnValue(maliciousDb);
    const prefixProxy = new PypiRegistryProxy({
      upstream: 'https://pypi.org',
      delayMs: DELAY_MS,
      maliciousDbPath: '/dev/null',
    });

    const data = {
      meta: { 'api-version': '1.0' },
      name: 'requests',
      versions: ['2.28', '2.28.0'],
      files: [
        makeSimpleFile('requests-2.28.tar.gz', '2024-01-01T00:00:00Z'),
        makeSimpleFile('requests-2.28.0.tar.gz', '2024-01-01T00:00:00Z'),
      ],
    };
    vi.mocked(axios.get).mockResolvedValue({ status: 200, data, headers: {} });
    const res = makeRes();
    await prefixProxy.handleRequest(
      makeReq('/simple/requests/', { accept: 'application/vnd.pypi.simple.v1+json' }),
      res,
    );
    const result = responseBody(res);
    const files = result['files'] as Record<string, unknown>[];
    expect(files.map((f) => f['filename'])).toEqual(['requests-2.28.tar.gz']);
  });

  it('blocks all releases of a fully malicious package (JSON API)', async () => {
    const data = {
      info: { name: 'evil-pkg', version: '1.0.0' },
      last_serial: 1,
      releases: { '1.0.0': [makeMetadataFile('2024-01-01T00:00:00Z')] },
      urls: [],
    };
    const res = await maliciousHandle('/pypi/evil-pkg/json', data);
    const result = responseBody(res);
    expect(Object.keys(result['releases'] as Record<string, unknown>)).toEqual([]);
  });

  it('blocks a specific malicious release while keeping safe ones (JSON API)', async () => {
    const data = {
      info: { name: 'requests', version: '2.29.0' },
      last_serial: 1,
      releases: {
        '2.28.0': [makeMetadataFile('2024-01-01T00:00:00Z')], // malicious → blocked
        '2.29.0': [makeMetadataFile('2024-01-10T00:00:00Z')], // safe → allowed
      },
      urls: [],
    };
    const res = await maliciousHandle('/pypi/requests/json', data);
    const result = responseBody(res);
    expect(Object.keys(result['releases'] as Record<string, unknown>)).toEqual(['2.29.0']);
  });
});
