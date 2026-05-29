/**
 * Integration tests for the npm registry proxy using the npm CLI.
 * These tests fetch real package metadata from the upstream npm registry.
 *
 * Package version dates (cutoff = 2024-01-15):
 *   semver@7.5.4  – released 2023-07-21  → before cutoff, allowed
 *   semver@7.6.0  – released 2024-02-03  → after cutoff,  blocked
 *   lodash@4.17.21 – released 2021-02-20 → before cutoff, allowed
 *   @babel/core@7.0.0  – released 2018-08-27 → before cutoff, allowed
 *   @babel/core@7.24.0 – released 2024-03-06 → after cutoff,  blocked
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
  readFileSync,
  existsSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  startTestServer,
  stopTestServer,
  runCommand,
  NOW,
  isAvailable,
  PASSTHROUGH_MODES,
  expectAllowedDownload,
} from './helpers.ts';
import type { TestServer } from './helpers.ts';
import http from 'node:http';

const npmExists = isAvailable('npm');

describe.skipIf(!npmExists).each(PASSTHROUGH_MODES)(
  'npm integration tests (%s mode)',
  (mode) => {
  let ts: TestServer;
  let server: http.Server;
  let registryUrl: string;

  beforeAll(async () => {
    ts = await startTestServer({ passthroughMode: mode });
    server = ts.server;
    registryUrl = ts.url('npm');

    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
  });

  afterAll(async () => {
    vi.useRealTimers();
    await stopTestServer(server);
  });

  describe('npm view', () => {
    let tmpDir: string;

    beforeEach(() => {
      tmpDir = mkdtempSync(join(tmpdir(), 'tengen-npm-view-'));
    });

    afterEach(() => {
      rmSync(tmpDir, { recursive: true, force: true });
    });

    function npmView(
      args: string,
    ): Promise<{ exitCode: number; stdout: string }> {
      return runCommand('npm', [
        'view',
        ...args.split(/\s+/).filter(Boolean),
        `--registry=${registryUrl}`,
        '--json',
        '--no-update-notifier',
        '--no-fund',
        '--cache',
        join(tmpDir, '.npm-cache'),
      ]);
    }

    it('lists only versions published before the cutoff', async () => {
      const { exitCode, stdout } = await npmView('semver versions');
      expect(exitCode).toBe(0);
      const versions = JSON.parse(stdout) as string[];
      expect(versions).toContain('7.5.4');
      expect(versions).not.toContain('7.6.0');
    }, 30_000);

    it('dist-tags.latest points to the newest allowed version when original latest is blocked', async () => {
      // Run concurrently to get independent 200 responses (avoid ETag 304 reuse)
      const [versionsResult, latestResult] = await Promise.all([
        npmView('semver versions'),
        npmView('semver dist-tags.latest'),
      ]);
      expect(versionsResult.exitCode).toBe(0);
      expect(latestResult.exitCode).toBe(0);
      const versions = JSON.parse(versionsResult.stdout) as string[];
      const latest = JSON.parse(latestResult.stdout) as string;
      // The proxy must repoint dist-tags.latest to the newest allowed (pre-cutoff) version
      expect(latest).toBe('7.5.4');
      expect(versions).toContain(latest);
    }, 30_000);

    it('succeeds for an allowed version', async () => {
      const { exitCode, stdout } = await npmView('semver@7.5.4 version');
      expect(exitCode).toBe(0);
      expect(JSON.parse(stdout)).toBe('7.5.4');
    }, 30_000);

    it('exits non-zero for a blocked version', async () => {
      const { exitCode } = await npmView('semver@7.6.0 version');
      expect(exitCode).not.toBe(0);
    }, 30_000);

    it('propagates upstream 404 as E404', async () => {
      const { exitCode, stdout } = await npmView(
        'nonexistent-pkg-xyz-1234567 version',
      );
      expect(exitCode).not.toBe(0);
      const out = JSON.parse(stdout) as { error?: { code?: string } };
      expect(out.error?.code).toBe('E404');
    }, 30_000);

    it('lists only versions published before the cutoff for a scoped package', async () => {
      const { exitCode, stdout } = await npmView('@babel/core versions');
      expect(exitCode).toBe(0);
      const versions = JSON.parse(stdout) as string[];
      expect(versions).toContain('7.0.0');
      expect(versions).not.toContain('7.24.0');
    }, 30_000);

    it('dist-tags.latest is remapped to the newest allowed version for a scoped package', async () => {
      const [versionsResult, latestResult] = await Promise.all([
        npmView('@babel/core versions'),
        npmView('@babel/core dist-tags.latest'),
      ]);
      expect(versionsResult.exitCode).toBe(0);
      expect(latestResult.exitCode).toBe(0);
      const versions = JSON.parse(versionsResult.stdout) as string[];
      const latest = JSON.parse(latestResult.stdout) as string;
      // proxy must repoint latest to an allowed (pre-cutoff) version
      expect(versions).toContain(latest);
      expect(latest).not.toBe('7.24.0');
    }, 30_000);
  });

  describe('npm install', () => {
    let tmpDir: string;

    beforeEach(() => {
      tmpDir = mkdtempSync(join(tmpdir(), 'tengen-npm-test-'));
      writeFileSync(
        join(tmpDir, 'package.json'),
        JSON.stringify({ name: 'test', version: '1.0.0' }),
      );
    });

    afterEach(() => {
      rmSync(tmpDir, { recursive: true, force: true });
    });

    function npmInstall(pkg: string): Promise<{ exitCode: number }> {
      return runCommand('npm', [
        'install',
        pkg,
        `--registry=${registryUrl}`,
        '--no-update-notifier',
        '--no-fund',
        '--no-audit',
        '--cache',
        join(tmpDir, '.npm-cache'),
        '--prefix',
        tmpDir,
        '--ignore-scripts=true',
      ]);
    }

    it('installs the latest allowed version when no version is specified', async () => {
      const { exitCode } = await npmInstall('semver');
      expect(exitCode).toBe(0);

      const pkgJson = JSON.parse(
        readFileSync(
          join(tmpDir, 'node_modules', 'semver', 'package.json'),
          'utf-8',
        ),
      ) as { version: string };
      expect(pkgJson.version).toBe('7.5.4');
    }, 30_000);

    it('succeeds for an allowed version', async () => {
      const { exitCode } = await npmInstall('semver@7.5.4');
      expect(exitCode).toBe(0);

      const pkgJson = JSON.parse(
        readFileSync(
          join(tmpDir, 'node_modules', 'semver', 'package.json'),
          'utf-8',
        ),
      ) as { version: string };
      expect(pkgJson.version).toBe('7.5.4');
    }, 30_000);

    it('exits non-zero for a blocked version', async () => {
      const { exitCode } = await npmInstall('semver@7.6.0');
      expect(exitCode).not.toBe(0);

      const pkgJsonPath = join(
        tmpDir,
        'node_modules',
        'semver',
        'package.json',
      );
      if (existsSync(pkgJsonPath)) {
        const pkgJson = JSON.parse(readFileSync(pkgJsonPath, 'utf-8')) as {
          version: string;
        };
        expect(pkgJson.version).not.toBe('7.6.0');
      }
    }, 30_000);
  });

  describe('npm ci', () => {
    let tmpDir: string;

    beforeEach(async () => {
      tmpDir = mkdtempSync(join(tmpdir(), 'tengen-npm-ci-test-'));
      writeFileSync(
        join(tmpDir, 'package.json'),
        JSON.stringify({
          name: 'test',
          version: '1.0.0',
          dependencies: { semver: '7.5.4' },
        }),
      );
      // Generate package-lock.json with an allowed version via the proxy
      await runCommand(
        'npm',
        [
          'install',
          `--registry=${registryUrl}`,
          '--no-update-notifier',
          '--no-fund',
          '--no-audit',
          '--cache',
          join(tmpDir, '.npm-cache'),
          '--ignore-scripts=true',
        ],
        { cwd: tmpDir },
      );
    });

    afterEach(() => {
      rmSync(tmpDir, { recursive: true, force: true });
    });

    it('installs from lockfile when all versions are allowed', async () => {
      // npm ci removes node_modules automatically before installing
      const { exitCode } = await runCommand(
        'npm',
        [
          'ci',
          `--registry=${registryUrl}`,
          '--no-update-notifier',
          '--no-fund',
          '--no-audit',
          '--cache',
          join(tmpDir, '.npm-cache'),
          '--ignore-scripts=true',
        ],
        { cwd: tmpDir },
      );
      expect(exitCode).toBe(0);

      const pkgJson = JSON.parse(
        readFileSync(
          join(tmpDir, 'node_modules', 'semver', 'package.json'),
          'utf-8',
        ),
      ) as { version: string };
      expect(pkgJson.version).toBe('7.5.4');
    }, 30_000);

    it('exits non-zero when lockfile references a blocked version', async () => {
      writeFileSync(
        join(tmpDir, 'package.json'),
        JSON.stringify({
          name: 'test',
          version: '1.0.0',
          dependencies: { semver: '7.6.0' },
        }),
      );
      // Manually craft a lockfile whose resolved URL points to the proxy.
      // The proxy returns 404 for blocked tarballs, so npm ci exits non-zero.
      writeFileSync(
        join(tmpDir, 'package-lock.json'),
        JSON.stringify({
          name: 'test',
          version: '1.0.0',
          lockfileVersion: 3,
          requires: true,
          packages: {
            '': {
              name: 'test',
              version: '1.0.0',
              dependencies: { semver: '7.6.0' },
            },
            'node_modules/semver': {
              version: '7.6.0',
              resolved: `${registryUrl}/semver/-/semver-7.6.0.tgz`,
              // Placeholder integrity — the proxy 404s before this is checked
              integrity:
                'sha512-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==',
              license: 'ISC',
              bin: { semver: 'bin/semver.js' },
              engines: { node: '>=10' },
            },
          },
        }),
      );

      const { exitCode } = await runCommand(
        'npm',
        [
          'ci',
          `--registry=${registryUrl}`,
          '--no-update-notifier',
          '--no-fund',
          '--no-audit',
          '--cache',
          join(tmpDir, '.npm-cache'),
          '--ignore-scripts=true',
        ],
        { cwd: tmpDir },
      );
      expect(exitCode).not.toBe(0);
    }, 30_000);
  });

  describe('npm update', () => {
    let tmpDir: string;

    beforeEach(async () => {
      tmpDir = mkdtempSync(join(tmpdir(), 'tengen-npm-update-test-'));
      // Pin to an old exact version first so npm update has something to do
      writeFileSync(
        join(tmpDir, 'package.json'),
        JSON.stringify({
          name: 'test',
          version: '1.0.0',
          dependencies: { semver: '7.0.0' },
        }),
      );
      await runCommand(
        'npm',
        [
          'install',
          `--registry=${registryUrl}`,
          '--no-update-notifier',
          '--no-fund',
          '--no-audit',
          '--cache',
          join(tmpDir, '.npm-cache'),
          '--ignore-scripts=true',
        ],
        { cwd: tmpDir },
      );
      // Relax the range so npm update can upgrade to the latest allowed version
      writeFileSync(
        join(tmpDir, 'package.json'),
        JSON.stringify({
          name: 'test',
          version: '1.0.0',
          dependencies: { semver: '^7.0.0' },
        }),
      );
    });

    afterEach(() => {
      rmSync(tmpDir, { recursive: true, force: true });
    });

    function npmUpdate(
      pkgs: string[] = [],
    ): Promise<{ exitCode: number; stdout: string; stderr: string }> {
      return runCommand(
        'npm',
        [
          'update',
          ...pkgs,
          `--registry=${registryUrl}`,
          '--no-update-notifier',
          '--no-fund',
          '--no-audit',
          '--cache',
          join(tmpDir, '.npm-cache'),
          '--ignore-scripts=true',
        ],
        { cwd: tmpDir },
      );
    }

    it('updates to the latest allowed version (does not exceed the cutoff)', async () => {
      const { exitCode } = await npmUpdate();
      expect(exitCode).toBe(0);

      const pkgJson = JSON.parse(
        readFileSync(
          join(tmpDir, 'node_modules', 'semver', 'package.json'),
          'utf-8',
        ),
      ) as { version: string };
      // 7.5.4 is the last pre-cutoff release; 7.6.0 (2024-02-03) is blocked
      expect(pkgJson.version).toBe('7.5.4');
    }, 30_000);

    it('exits zero and stays at the latest allowed version on a second run', async () => {
      await npmUpdate(); // first run: upgrades 7.0.0 → 7.5.4
      const { exitCode } = await npmUpdate(); // second run: nothing to do
      expect(exitCode).toBe(0);

      const pkgJson = JSON.parse(
        readFileSync(
          join(tmpDir, 'node_modules', 'semver', 'package.json'),
          'utf-8',
        ),
      ) as { version: string };
      expect(pkgJson.version).toBe('7.5.4');
    }, 60_000);

    it('updates a named package to the latest allowed version', async () => {
      const { exitCode } = await npmUpdate(['semver']);
      expect(exitCode).toBe(0);

      const pkgJson = JSON.parse(
        readFileSync(
          join(tmpDir, 'node_modules', 'semver', 'package.json'),
          'utf-8',
        ),
      ) as { version: string };
      expect(pkgJson.version).toBe('7.5.4');
    }, 30_000);
  });

  describe('npm search', () => {
    function npmSearch(
      query: string,
    ): Promise<{ exitCode: number; stdout: string; stderr: string }> {
      return runCommand('npm', [
        'search',
        query,
        `--registry=${registryUrl}`,
        '--json',
        '--no-update-notifier',
      ]);
    }

    it('returns results including a known package', async () => {
      const { exitCode, stdout } = await npmSearch('semver');
      expect(exitCode).toBe(0);
      const results = JSON.parse(stdout) as Array<{ name: string }>;
      expect(results.some((r) => r.name === 'semver')).toBe(true);
    }, 30_000);

    it('does not include an exact match for a non-existent package name', async () => {
      const query = 'nonexistent-pkg-xyz-1234567-abc';
      const { exitCode, stdout } = await npmSearch(query);
      expect(exitCode).toBe(0);
      // npm search does full-text fuzzy matching and may return unrelated results;
      // verify only that no package has the exact non-existent name.
      const results = JSON.parse(stdout) as Array<{ name: string }>;
      expect(results.every((r) => r.name !== query)).toBe(true);
    }, 30_000);
  });

  describe('npm audit', () => {
    let tmpDir: string;

    beforeAll(async () => {
      tmpDir = mkdtempSync(join(tmpdir(), 'tengen-npm-audit-test-'));
      writeFileSync(
        join(tmpDir, 'package.json'),
        JSON.stringify({ name: 'test', version: '1.0.0' }),
      );
      // Install an allowed package to create package-lock.json required by audit
      await runCommand('npm', [
        'install',
        'semver@7.5.4',
        `--registry=${registryUrl}`,
        '--no-update-notifier',
        '--no-fund',
        '--no-audit',
        '--cache',
        join(tmpDir, '.npm-cache'),
        '--prefix',
        tmpDir,
        '--ignore-scripts=true',
      ]);
    });

    afterAll(() => {
      rmSync(tmpDir, { recursive: true, force: true });
    });

    it('completes without a proxy error', async () => {
      const { exitCode, stderr } = await runCommand('npm', [
        'audit',
        `--registry=${registryUrl}`,
        '--no-update-notifier',
        '--prefix',
        tmpDir,
      ]);
      // 0 = no vulnerabilities, 1 = vulnerabilities found — both are valid audit results.
      // Anything higher indicates a proxy/network error.
      expect(exitCode).toBeLessThanOrEqual(1);
      expect(stderr).not.toMatch(/ECONNREFUSED|ENOTFOUND|E500/);
    }, 30_000);

    it('returns valid JSON audit output with metadata', async () => {
      const { exitCode, stdout } = await runCommand('npm', [
        'audit',
        '--json',
        `--registry=${registryUrl}`,
        '--no-update-notifier',
        '--prefix',
        tmpDir,
      ]);
      expect(exitCode).toBeLessThanOrEqual(1);
      const report = JSON.parse(stdout) as {
        auditReportVersion?: number;
        vulnerabilities?: Record<string, unknown>;
        metadata?: { dependencies?: { total?: number } };
      };
      expect(report).toHaveProperty('auditReportVersion');
      expect(report).toHaveProperty('vulnerabilities');
      expect(report).toHaveProperty('metadata');
      expect(typeof report.metadata?.dependencies?.total).toBe('number');
    }, 30_000);
  });

  },
); // describe.skipIf(!npmExists).each(PASSTHROUGH_MODES)

describe.each(PASSTHROUGH_MODES)('npm tarball download (%s mode)', (mode) => {
  let ts: TestServer;
  let server: http.Server;
  let registryUrl: string;

  beforeAll(async () => {
    ts = await startTestServer({ passthroughMode: mode });
    server = ts.server;
    registryUrl = ts.url('npm');

    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
  });

  afterAll(async () => {
    vi.useRealTimers();
    await stopTestServer(server);
  });

  it('serves an allowed version (302 redirect or piped 200)', async () => {
    const res = await fetch(`${registryUrl}/lodash/-/lodash-4.17.21.tgz`, {
      redirect: 'manual',
    });
    await expectAllowedDownload(res, mode);
  }, 30_000);

  it('returns 404 for a blocked version', async () => {
    const res = await fetch(`${registryUrl}/semver/-/semver-7.6.0.tgz`, {
      redirect: 'manual',
    });
    expect(res.status).toBe(404);
  }, 30_000);

  it('serves an allowed scoped package version (302 redirect or piped 200)', async () => {
    const res = await fetch(`${registryUrl}/@babel/core/-/core-7.0.0.tgz`, {
      redirect: 'manual',
    });
    await expectAllowedDownload(res, mode);
  }, 30_000);

  it('returns 404 for a blocked scoped package version', async () => {
    const res = await fetch(`${registryUrl}/@babel/core/-/core-7.24.0.tgz`, {
      redirect: 'manual',
    });
    expect(res.status).toBe(404);
  }, 30_000);

  it('returns 404 when upstream metadata returns 404', async () => {
    const res = await fetch(
      `${registryUrl}/nonexistent-pkg-xyz-1234567/-/nonexistent-pkg-xyz-1234567-1.0.0.tgz`,
      { redirect: 'manual' },
    );
    expect(res.status).toBe(404);
  }, 30_000);
});
