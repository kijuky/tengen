/**
 * Integration tests for the PyPI registry proxy using the uv CLI.
 * These tests fetch real package metadata from the upstream PyPI registry.
 *
 * Package version dates (cutoff = 2024-01-15):
 *   requests@2.31.0  – released 2023-05-22  → before cutoff, allowed
 *   requests@2.32.3  – released 2024-06-09  → after cutoff,  blocked
 *   certifi@2023.11.17 – released 2023-11-17 → before cutoff, allowed
 *   certifi@2024.2.2   – released 2024-02-02 → after cutoff,  blocked
 */

import {
  describe,
  it,
  expect,
  vi,
  beforeAll,
  beforeEach,
  afterAll,
  afterEach,
} from 'vitest';
import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  rmSync,
  readdirSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { startTestServer, stopTestServer, runCommand, NOW, isAvailable } from './helpers.ts';
import type { TestServer } from './helpers.ts';
import http from 'node:http';

const uvExists = isAvailable('uv');

describe.skipIf(!uvExists)('uv integration tests', () => {
  let ts: TestServer;
  let server: http.Server;
  let indexUrl: string;

  beforeAll(async () => {
    ts = await startTestServer();
    server = ts.server;
    indexUrl = ts.url('pypi') + '/simple/';

    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
  });

  afterAll(async () => {
    vi.useRealTimers();
    await stopTestServer(server);
  });

  describe('uv pip install', () => {
    let tmpDir: string;

    beforeEach(() => {
      tmpDir = mkdtempSync(join(tmpdir(), 'tengen-uv-test-'));
    });

    afterEach(() => {
      rmSync(tmpDir, { recursive: true, force: true });
    });

    function uvInstall(
      pkgSpec: string,
    ): Promise<{ exitCode: number; stdout: string; stderr: string }> {
      return runCommand('uv', [
        'pip',
        'install',
        pkgSpec,
        `--index-url=${indexUrl}`,
        '--target',
        tmpDir,
        '--no-cache',
      ]);
    }

    function installedVersion(packageName: string): string | undefined {
      const prefix = `${packageName}-`;
      const suffix = '.dist-info';
      return readdirSync(tmpDir)
        .find((d) => d.startsWith(prefix) && d.endsWith(suffix))
        ?.slice(prefix.length, -suffix.length);
    }

    it('installs the latest allowed version when no version is specified', async () => {
      const { exitCode } = await uvInstall('requests');
      expect(exitCode).toBe(0);
      // requests 2.32.x+ were released after 2024-01-15; 2.31.0 is the latest allowed
      expect(installedVersion('requests')).toBe('2.31.0');
    }, 30_000);

    it('succeeds for an allowed version', async () => {
      const { exitCode } = await uvInstall('requests==2.31.0');
      expect(exitCode).toBe(0);
      expect(installedVersion('requests')).toBe('2.31.0');
    }, 30_000);

    it('exits non-zero for a blocked version', async () => {
      const { exitCode } = await uvInstall('requests==2.32.3');
      expect(exitCode).not.toBe(0);
    }, 30_000);

    it('propagates upstream 404 for a non-existent package', async () => {
      const { exitCode } = await uvInstall('nonexistent-pkg-xyz-1234567');
      expect(exitCode).not.toBe(0);
    }, 30_000);
  });

  describe('uv pip compile', () => {
    let tmpDir: string;

    beforeEach(() => {
      tmpDir = mkdtempSync(join(tmpdir(), 'tengen-uv-compile-test-'));
    });

    afterEach(() => {
      rmSync(tmpDir, { recursive: true, force: true });
    });

    function uvCompile(
      reqsInContent: string,
    ): Promise<{ exitCode: number; stdout: string; stderr: string }> {
      const reqsInPath = join(tmpDir, 'requirements.in');
      writeFileSync(reqsInPath, reqsInContent);
      return runCommand('uv', [
        'pip',
        'compile',
        reqsInPath,
        `--index-url=${indexUrl}`,
        '--no-cache',
        '--no-header',
        '--no-annotate',
      ]);
    }

    it('resolves to the latest allowed version', async () => {
      const { exitCode, stdout } = await uvCompile('requests\n');
      expect(exitCode).toBe(0);
      // requests 2.32.x+ are blocked; 2.31.0 is the latest allowed
      expect(stdout).toContain('requests==2.31.0');
    }, 30_000);

    it('succeeds when pinning an allowed version', async () => {
      const { exitCode, stdout } = await uvCompile('requests==2.31.0\n');
      expect(exitCode).toBe(0);
      expect(stdout).toContain('requests==2.31.0');
    }, 30_000);

    it('exits non-zero when pinning a blocked version', async () => {
      const { exitCode } = await uvCompile('requests==2.32.3\n');
      expect(exitCode).not.toBe(0);
    }, 30_000);

    it('exits non-zero for a non-existent package', async () => {
      const { exitCode } = await uvCompile('nonexistent-pkg-xyz-1234567\n');
      expect(exitCode).not.toBe(0);
    }, 30_000);
  });

  describe('uv pip sync', () => {
    let tmpDir: string;

    beforeEach(() => {
      tmpDir = mkdtempSync(join(tmpdir(), 'tengen-uv-pip-sync-test-'));
    });

    afterEach(() => {
      rmSync(tmpDir, { recursive: true, force: true });
    });

    function uvPipSync(
      reqsContent: string,
    ): Promise<{ exitCode: number; stdout: string; stderr: string }> {
      const reqsPath = join(tmpDir, 'requirements.txt');
      writeFileSync(reqsPath, reqsContent);
      return runCommand('uv', [
        'pip',
        'sync',
        reqsPath,
        `--index-url=${indexUrl}`,
        '--target',
        join(tmpDir, 'site-packages'),
        '--no-cache',
      ]);
    }

    it('syncs when requirements pin an allowed version', async () => {
      const { exitCode } = await uvPipSync('certifi==2023.11.17\n');
      expect(exitCode).toBe(0);
      const sitePackages = join(tmpDir, 'site-packages');
      const installed = readdirSync(sitePackages).find(
        (d) => d.startsWith('certifi-') && d.endsWith('.dist-info'),
      );
      expect(installed).toBe('certifi-2023.11.17.dist-info');
    }, 30_000);

    it('exits non-zero when requirements pin a blocked version', async () => {
      const { exitCode } = await uvPipSync('certifi==2024.2.2\n');
      expect(exitCode).not.toBe(0);
    }, 30_000);
  });

  describe('uv sync', () => {
    let tmpDir: string;

    beforeEach(() => {
      tmpDir = mkdtempSync(join(tmpdir(), 'tengen-uv-sync-test-'));
    });

    afterEach(() => {
      rmSync(tmpDir, { recursive: true, force: true });
    });

    function uvSync(
      pyprojectContent: string,
    ): Promise<{ exitCode: number; stdout: string; stderr: string }> {
      writeFileSync(join(tmpDir, 'pyproject.toml'), pyprojectContent);
      return runCommand(
        'uv',
        ['sync', '--no-cache'],
        { env: { UV_DEFAULT_INDEX: indexUrl }, cwd: tmpDir },
      );
    }

    it('syncs an allowed dependency', async () => {
      const { exitCode } = await uvSync(`\
[project]
name = "test-project"
version = "0.1.0"
requires-python = ">=3.8"
dependencies = ["certifi==2023.11.17"]
`);
      expect(exitCode).toBe(0);
      const lockContent = readFileSync(join(tmpDir, 'uv.lock'), 'utf8');
      expect(lockContent).toContain('name = "certifi"');
      expect(lockContent).toContain('version = "2023.11.17"');
    }, 30_000);

    it('exits non-zero when a dependency pins a blocked version', async () => {
      const { exitCode } = await uvSync(`\
[project]
name = "test-project"
version = "0.1.0"
requires-python = ">=3.8"
dependencies = ["certifi==2024.2.2"]
`);
      expect(exitCode).not.toBe(0);
    }, 30_000);
  });

  describe('uv lock', () => {
    let tmpDir: string;

    beforeEach(() => {
      tmpDir = mkdtempSync(join(tmpdir(), 'tengen-uv-lock-test-'));
    });

    afterEach(() => {
      rmSync(tmpDir, { recursive: true, force: true });
    });

    function uvLock(
      pyprojectContent: string,
    ): Promise<{ exitCode: number; stdout: string; stderr: string }> {
      writeFileSync(join(tmpDir, 'pyproject.toml'), pyprojectContent);
      return runCommand(
        'uv',
        ['lock', '--no-cache'],
        { env: { UV_DEFAULT_INDEX: indexUrl }, cwd: tmpDir },
      );
    }

    it('generates a lockfile for an allowed pinned version', async () => {
      const { exitCode } = await uvLock(`\
[project]
name = "test-project"
version = "0.1.0"
requires-python = ">=3.8"
dependencies = ["certifi==2023.11.17"]
`);
      expect(exitCode).toBe(0);
      const lockContent = readFileSync(join(tmpDir, 'uv.lock'), 'utf8');
      expect(lockContent).toContain('name = "certifi"');
      expect(lockContent).toContain('version = "2023.11.17"');
    }, 30_000);

    it('resolves to the latest allowed version when no version is pinned', async () => {
      const { exitCode } = await uvLock(`\
[project]
name = "test-project"
version = "0.1.0"
requires-python = ">=3.8"
dependencies = ["certifi"]
`);
      expect(exitCode).toBe(0);
      const lockContent = readFileSync(join(tmpDir, 'uv.lock'), 'utf8');
      // certifi-2024.2.2 is blocked; certifi-2023.11.17 is the latest allowed
      expect(lockContent).toContain('version = "2023.11.17"');
      expect(lockContent).not.toContain('2024.2.2');
    }, 30_000);

    it('exits non-zero when a dependency pins a blocked version', async () => {
      const { exitCode } = await uvLock(`\
[project]
name = "test-project"
version = "0.1.0"
requires-python = ">=3.8"
dependencies = ["certifi==2024.2.2"]
`);
      expect(exitCode).not.toBe(0);
    }, 30_000);

    it('exits non-zero for a non-existent package', async () => {
      const { exitCode } = await uvLock(`\
[project]
name = "test-project"
version = "0.1.0"
requires-python = ">=3.8"
dependencies = ["nonexistent-pkg-xyz-1234567"]
`);
      expect(exitCode).not.toBe(0);
    }, 30_000);
  });

  describe('uv add', () => {
    let tmpDir: string;

    beforeEach(() => {
      tmpDir = mkdtempSync(join(tmpdir(), 'tengen-uv-add-test-'));
      writeFileSync(join(tmpDir, 'pyproject.toml'), `\
[project]
name = "test-project"
version = "0.1.0"
requires-python = ">=3.8"
dependencies = []
`);
    });

    afterEach(() => {
      rmSync(tmpDir, { recursive: true, force: true });
    });

    function uvAdd(
      pkgSpec: string,
    ): Promise<{ exitCode: number; stdout: string; stderr: string }> {
      return runCommand(
        'uv',
        ['add', pkgSpec, '--no-cache'],
        { env: { UV_DEFAULT_INDEX: indexUrl }, cwd: tmpDir },
      );
    }

    it('adds an allowed version', async () => {
      const { exitCode } = await uvAdd('certifi==2023.11.17');
      expect(exitCode).toBe(0);
      const lockContent = readFileSync(join(tmpDir, 'uv.lock'), 'utf8');
      expect(lockContent).toContain('name = "certifi"');
      expect(lockContent).toContain('version = "2023.11.17"');
    }, 30_000);

    it('resolves to the latest allowed version when no version is specified', async () => {
      const { exitCode } = await uvAdd('certifi');
      expect(exitCode).toBe(0);
      // certifi-2024.2.2 is blocked; certifi-2023.11.17 is the latest allowed
      const pyproject = readFileSync(join(tmpDir, 'pyproject.toml'), 'utf8');
      expect(pyproject).not.toMatch(/certifi.*2024/);
    }, 30_000);

    it('exits non-zero when adding a blocked version', async () => {
      const { exitCode } = await uvAdd('certifi==2024.2.2');
      expect(exitCode).not.toBe(0);
    }, 30_000);
  });

  describe('uv pip install from requirements.txt', () => {
    let tmpDir: string;

    beforeEach(() => {
      tmpDir = mkdtempSync(join(tmpdir(), 'tengen-uv-req-test-'));
    });

    afterEach(() => {
      rmSync(tmpDir, { recursive: true, force: true });
    });

    function uvInstallReqs(
      reqsContent: string,
    ): Promise<{ exitCode: number; stdout: string; stderr: string }> {
      const reqsPath = join(tmpDir, 'requirements.txt');
      writeFileSync(reqsPath, reqsContent);
      return runCommand('uv', [
        'pip',
        'install',
        '-r',
        reqsPath,
        `--index-url=${indexUrl}`,
        '--target',
        join(tmpDir, 'site-packages'),
        '--no-cache',
      ]);
    }

    it('installs when requirements pin an allowed version', async () => {
      const { exitCode } = await uvInstallReqs('requests==2.31.0\n');
      expect(exitCode).toBe(0);
      const sitePackages = join(tmpDir, 'site-packages');
      const installed = readdirSync(sitePackages).find(
        (d) => d.startsWith('requests-') && d.endsWith('.dist-info'),
      );
      expect(installed).toBe('requests-2.31.0.dist-info');
    }, 30_000);

    it('exits non-zero when requirements pin a blocked version', async () => {
      const { exitCode } = await uvInstallReqs('requests==2.32.3\n');
      expect(exitCode).not.toBe(0);
    }, 30_000);
  });
}); // describe.skipIf(!uvExists)

describe('simple API metadata', () => {
  let ts: TestServer;
  let server: http.Server;
  let indexUrl: string;

  beforeAll(async () => {
    ts = await startTestServer();
    server = ts.server;
    indexUrl = ts.url('pypi') + '/simple/';

    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
  });

  afterAll(async () => {
    vi.useRealTimers();
    await stopTestServer(server);
  });

  async function fetchSimple(
    packageName: string,
  ): Promise<{ status: number; files: Array<{ filename: string }> }> {
    const res = await fetch(`${indexUrl}${packageName}/`, {
      headers: { Accept: 'application/vnd.pypi.simple.v1+json' },
    });
    if (res.status !== 200) return { status: res.status, files: [] };
    const data = (await res.json()) as { files: Array<{ filename: string }> };
    return { status: res.status, files: data.files };
  }

  it('lists only files published before the cutoff', async () => {
    const { status, files } = await fetchSimple('certifi');
    expect(status).toBe(200);
    // certifi-2023.11.17 → allowed; certifi-2024.2.2 → blocked
    expect(files.some((f) => f.filename.startsWith('certifi-2023.11.17'))).toBe(true);
    expect(files.some((f) => f.filename.startsWith('certifi-2024.2.2'))).toBe(false);
  }, 30_000);

  it('returns 404 for a non-existent package', async () => {
    const { status } = await fetchSimple('nonexistent-pkg-xyz-1234567');
    expect(status).toBe(404);
  }, 30_000);
});

describe('tarball download', () => {
  let ts: TestServer;
  let server: http.Server;
  let indexUrl: string;

  beforeAll(async () => {
    ts = await startTestServer();
    server = ts.server;
    indexUrl = ts.url('pypi') + '/simple/';

    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
  });

  afterAll(async () => {
    vi.useRealTimers();
    await stopTestServer(server);
  });

  it('allows downloading a tarball for an allowed version', async () => {
    // First fetch the simple API to get a real proxied URL for an allowed file
    const res = await fetch(`${indexUrl}certifi/`, {
      headers: { Accept: 'application/vnd.pypi.simple.v1+json' },
    });
    expect(res.status).toBe(200);
    const data = (await res.json()) as {
      files: Array<{ filename: string; url: string }>;
    };
    const allowed = data.files.find((f) =>
      f.filename.startsWith('certifi-2023.11.17'),
    );
    expect(allowed).toBeDefined();
    // The URL is rewritten to a root-relative proxy path (e.g. /pypi/packages/...).
    // Prepend the proxy origin to make it absolute before fetching.
    const proxyOrigin = new URL(ts.url('pypi')).origin;
    const dlRes = await fetch(proxyOrigin + allowed!.url, { method: 'HEAD', redirect: 'manual' });
    expect(dlRes.status).toBeLessThan(400);
  }, 30_000);

  it('returns 404 for a blocked version tarball', async () => {
    // PyPI download paths are hash-based; derive the blocked path from the
    // upstream simple API (bypassing the proxy) to get the real URL.
    const upstreamRes = await fetch(
      'https://pypi.org/simple/certifi/',
      { headers: { Accept: 'application/vnd.pypi.simple.v1+json' } },
    );
    expect(upstreamRes.status).toBe(200);
    const upstreamData = (await upstreamRes.json()) as {
      files: Array<{ filename: string; url: string }>;
    };
    const blockedFile = upstreamData.files.find((f) =>
      f.filename.startsWith('certifi-2024.2.2'),
    );
    expect(blockedFile).toBeDefined();

    // Strip the upstream CDN origin and replace with the proxy path
    const upstreamUrl = new URL(blockedFile!.url);
    const proxiedUrl = `${ts.url('pypi')}${upstreamUrl.pathname}`;
    const res = await fetch(proxiedUrl, { redirect: 'manual' });
    expect(res.status).toBe(404);
  }, 30_000);
});
