/**
 * Integration tests for the PyPI registry proxy using the pip CLI.
 * These tests fetch real package metadata from the upstream PyPI registry.
 *
 * Package version dates (cutoff = 2024-01-15):
 *   requests@2.31.0    – released 2023-05-22  → before cutoff, allowed
 *   requests@2.32.3    – released 2024-06-09  → after cutoff,  blocked
 *   certifi@2023.11.17 – released 2023-11-17  → before cutoff, allowed
 *   certifi@2024.2.2   – released 2024-02-02  → after cutoff,  blocked
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
  rmSync,
  readdirSync,
  existsSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { startTestServer, stopTestServer, runCommand, NOW, isAvailable } from './helpers.ts';
import type { TestServer } from './helpers.ts';
import http from 'node:http';

const pipExists = isAvailable('pip');

describe.skipIf(!pipExists)('pip integration tests', () => {
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

  describe('pip install', () => {
    let tmpDir: string;

    beforeEach(() => {
      tmpDir = mkdtempSync(join(tmpdir(), 'tengen-pip-test-'));
    });

    afterEach(() => {
      rmSync(tmpDir, { recursive: true, force: true });
    });

    function pipInstall(
      pkgSpec: string,
    ): Promise<{ exitCode: number; stdout: string; stderr: string }> {
      return runCommand('pip', [
        'install',
        pkgSpec,
        `--index-url=${indexUrl}`,
        '--target',
        tmpDir,
        '--no-cache-dir',
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
      const { exitCode } = await pipInstall('requests');
      expect(exitCode).toBe(0);
      // requests 2.32.x+ were released after 2024-01-15; 2.31.0 is the latest allowed
      expect(installedVersion('requests')).toBe('2.31.0');
    }, 30_000);

    it('succeeds for an allowed version', async () => {
      const { exitCode } = await pipInstall('requests==2.31.0');
      expect(exitCode).toBe(0);
      expect(installedVersion('requests')).toBe('2.31.0');
    }, 30_000);

    it('exits non-zero for a blocked version', async () => {
      const { exitCode } = await pipInstall('requests==2.32.3');
      expect(exitCode).not.toBe(0);
      expect(installedVersion('requests')).toBeUndefined();
    }, 30_000);

    it('propagates upstream 404 for a non-existent package', async () => {
      const { exitCode } = await pipInstall('nonexistent-pkg-xyz-1234567');
      expect(exitCode).not.toBe(0);
    }, 30_000);
  });

  describe('pip install from requirements.txt', () => {
    let tmpDir: string;

    beforeEach(() => {
      tmpDir = mkdtempSync(join(tmpdir(), 'tengen-pip-req-test-'));
    });

    afterEach(() => {
      rmSync(tmpDir, { recursive: true, force: true });
    });

    function pipInstallReqs(
      reqsContent: string,
    ): Promise<{ exitCode: number; stdout: string; stderr: string }> {
      const reqsPath = join(tmpDir, 'requirements.txt');
      writeFileSync(reqsPath, reqsContent);
      return runCommand('pip', [
        'install',
        '-r',
        reqsPath,
        `--index-url=${indexUrl}`,
        '--target',
        join(tmpDir, 'site-packages'),
        '--no-cache-dir',
      ]);
    }

    function installedReqVersion(packageName: string): string | undefined {
      const sitePackages = join(tmpDir, 'site-packages');
      if (!existsSync(sitePackages)) return undefined;
      const prefix = `${packageName}-`;
      const suffix = '.dist-info';
      return readdirSync(sitePackages)
        .find((d) => d.startsWith(prefix) && d.endsWith(suffix))
        ?.slice(prefix.length, -suffix.length);
    }

    it('installs when requirements pin an allowed version', async () => {
      const { exitCode } = await pipInstallReqs('requests==2.31.0\n');
      expect(exitCode).toBe(0);
      expect(installedReqVersion('requests')).toBe('2.31.0');
    }, 30_000);

    it('exits non-zero when requirements pin a blocked version', async () => {
      const { exitCode } = await pipInstallReqs('requests==2.32.3\n');
      expect(exitCode).not.toBe(0);
      expect(installedReqVersion('requests')).toBeUndefined();
    }, 30_000);

    it('installs multiple allowed packages from requirements.txt', async () => {
      const { exitCode } = await pipInstallReqs(
        'requests==2.31.0\ncertifi==2023.11.17\n',
      );
      expect(exitCode).toBe(0);
      expect(installedReqVersion('requests')).toBe('2.31.0');
      expect(installedReqVersion('certifi')).toBe('2023.11.17');
    }, 30_000);

    it('exits non-zero when any requirement is blocked', async () => {
      const { exitCode } = await pipInstallReqs(
        'requests==2.31.0\ncertifi==2024.2.2\n',
      );
      expect(exitCode).not.toBe(0);
    }, 30_000);
  });

  describe('pip download', () => {
    let tmpDir: string;

    beforeEach(() => {
      tmpDir = mkdtempSync(join(tmpdir(), 'tengen-pip-dl-test-'));
    });

    afterEach(() => {
      rmSync(tmpDir, { recursive: true, force: true });
    });

    function pipDownload(
      pkgSpec: string,
    ): Promise<{ exitCode: number; stdout: string; stderr: string }> {
      return runCommand('pip', [
        'download',
        pkgSpec,
        `--index-url=${indexUrl}`,
        '--dest',
        tmpDir,
        '--no-cache-dir',
        '--no-deps',
      ]);
    }

    it('succeeds for an allowed version', async () => {
      const { exitCode } = await pipDownload('certifi==2023.11.17');
      expect(exitCode).toBe(0);
      const files = readdirSync(tmpDir);
      expect(files.some((f) => f.startsWith('certifi-2023.11.17'))).toBe(true);
    }, 30_000);

    it('exits non-zero for a blocked version', async () => {
      const { exitCode } = await pipDownload('certifi==2024.2.2');
      expect(exitCode).not.toBe(0);
      expect(readdirSync(tmpDir)).toHaveLength(0);
    }, 30_000);

    it('exits non-zero for a non-existent package', async () => {
      const { exitCode } = await pipDownload('nonexistent-pkg-xyz-1234567');
      expect(exitCode).not.toBe(0);
      expect(readdirSync(tmpDir)).toHaveLength(0);
    }, 30_000);
  });
  describe('pip wheel', () => {
    let tmpDir: string;

    beforeEach(() => {
      tmpDir = mkdtempSync(join(tmpdir(), 'tengen-pip-wheel-test-'));
    });

    afterEach(() => {
      rmSync(tmpDir, { recursive: true, force: true });
    });

    function pipWheel(
      pkgSpec: string,
    ): Promise<{ exitCode: number; stdout: string; stderr: string }> {
      return runCommand('pip', [
        'wheel',
        pkgSpec,
        `--index-url=${indexUrl}`,
        '--wheel-dir',
        tmpDir,
        '--no-cache-dir',
        '--no-deps',
      ]);
    }

    it('succeeds for an allowed version', async () => {
      const { exitCode } = await pipWheel('certifi==2023.11.17');
      expect(exitCode).toBe(0);
      const wheels = readdirSync(tmpDir).filter((f) => f.endsWith('.whl'));
      expect(wheels.some((f) => f.startsWith('certifi-2023.11.17'))).toBe(true);
    }, 30_000);

    it('exits non-zero for a blocked version', async () => {
      const { exitCode } = await pipWheel('certifi==2024.2.2');
      expect(exitCode).not.toBe(0);
      expect(readdirSync(tmpDir).filter((f) => f.endsWith('.whl'))).toHaveLength(0);
    }, 30_000);

    it('exits non-zero for a non-existent package', async () => {
      const { exitCode } = await pipWheel('nonexistent-pkg-xyz-1234567');
      expect(exitCode).not.toBe(0);
      expect(readdirSync(tmpDir).filter((f) => f.endsWith('.whl'))).toHaveLength(0);
    }, 30_000);
  });
}); // describe.skipIf(!pipExists)
