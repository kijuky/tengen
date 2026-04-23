/**
 * Integration tests for the npm registry proxy using the pnpm CLI.
 * pnpm uses the same npm registry protocol, so this exercises NpmRegistryProxy.
 *
 * Package version dates (cutoff = 2024-01-15):
 *   semver@7.5.4  – released 2023-07-21  → before cutoff, allowed
 *   semver@7.6.0  – released 2024-02-03  → after cutoff,  blocked
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
import { execSync } from 'node:child_process';
import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  rmSync,
  existsSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { startTestServer, stopTestServer, runCommand, NOW } from './helpers.ts';
import type { TestServer } from './helpers.ts';
import http from 'node:http';

const pnpmExists = (() => {
  try {
    execSync('pnpm --version', { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

describe.skipIf(!pnpmExists)('pnpm integration tests', () => {
  let ts: TestServer;
  let server: http.Server;
  let registryUrl: string;

  beforeAll(async () => {
    ts = await startTestServer();
    server = ts.server;
    registryUrl = ts.url('npm');

    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
  });

  afterAll(async () => {
    vi.useRealTimers();
    await stopTestServer(server);
  });

  describe('pnpm view', () => {
    function pnpmView(
      args: string,
    ): Promise<{ exitCode: number; stdout: string; stderr: string }> {
      return runCommand('pnpm', [
        'view',
        ...args.split(/\s+/).filter(Boolean),
        `--registry=${registryUrl}`,
        '--json',
      ]);
    }

    it('lists only versions published before the cutoff', async () => {
      const { exitCode, stdout } = await pnpmView('semver versions');
      expect(exitCode).toBe(0);
      const versions = JSON.parse(stdout) as string[];
      expect(versions).toContain('7.5.4');
      expect(versions).not.toContain('7.6.0');
    }, 30_000);

    it('dist-tags.latest points to the newest allowed version when original latest is blocked', async () => {
      const [versionsResult, latestResult] = await Promise.all([
        pnpmView('semver versions'),
        pnpmView('semver dist-tags.latest'),
      ]);
      expect(versionsResult.exitCode).toBe(0);
      expect(latestResult.exitCode).toBe(0);
      const versions = JSON.parse(versionsResult.stdout) as string[];
      const latest = JSON.parse(latestResult.stdout) as string;
      expect(latest).toBe('7.5.4');
      expect(versions).toContain(latest);
    }, 30_000);

    it('succeeds for an allowed version', async () => {
      const { exitCode, stdout } = await pnpmView('semver@7.5.4 version');
      expect(exitCode).toBe(0);
      expect(JSON.parse(stdout)).toBe('7.5.4');
    }, 30_000);

    it('exits non-zero for a blocked version', async () => {
      const { exitCode } = await pnpmView('semver@7.6.0 version');
      expect(exitCode).not.toBe(0);
    }, 30_000);

    it('exits non-zero for a non-existent package', async () => {
      const { exitCode } = await pnpmView('nonexistent-pkg-xyz-1234567 version');
      expect(exitCode).not.toBe(0);
    }, 30_000);

    it('lists only versions published before the cutoff for a scoped package', async () => {
      const { exitCode, stdout } = await pnpmView('@babel/core versions');
      expect(exitCode).toBe(0);
      const versions = JSON.parse(stdout) as string[];
      expect(versions).toContain('7.0.0');
      expect(versions).not.toContain('7.24.0');
    }, 30_000);

    it('dist-tags.latest is remapped to the newest allowed version for a scoped package', async () => {
      const [versionsResult, latestResult] = await Promise.all([
        pnpmView('@babel/core versions'),
        pnpmView('@babel/core dist-tags.latest'),
      ]);
      expect(versionsResult.exitCode).toBe(0);
      expect(latestResult.exitCode).toBe(0);
      const versions = JSON.parse(versionsResult.stdout) as string[];
      const latest = JSON.parse(latestResult.stdout) as string;
      expect(versions).toContain(latest);
      expect(latest).not.toBe('7.24.0');
    }, 30_000);
  });

  describe('pnpm add', () => {
    let tmpDir: string;

    beforeEach(() => {
      tmpDir = mkdtempSync(join(tmpdir(), 'tengen-pnpm-add-'));
      writeFileSync(
        join(tmpDir, 'package.json'),
        JSON.stringify({ name: 'test', version: '1.0.0' }),
      );
    });

    afterEach(() => {
      rmSync(tmpDir, { recursive: true, force: true });
    });

    function pnpmAdd(
      pkg: string,
    ): Promise<{ exitCode: number; stdout: string; stderr: string }> {
      return runCommand(
        'pnpm',
        [
          'add',
          pkg,
          `--registry=${registryUrl}`,
          '--ignore-scripts',
          '--store-dir',
          join(tmpDir, '.pnpm-store'),
        ],
        { cwd: tmpDir },
      );
    }

    it('installs the latest allowed version when no version is specified', async () => {
      const { exitCode } = await pnpmAdd('semver');
      expect(exitCode).toBe(0);

      const pkgJson = JSON.parse(
        readFileSync(
          join(tmpDir, 'node_modules', 'semver', 'package.json'),
          'utf-8',
        ),
      ) as { version: string };
      // semver@7.6.0 (2024-02-03) is blocked; 7.5.4 is the latest allowed
      expect(pkgJson.version).toBe('7.5.4');
    }, 30_000);

    it('succeeds for an allowed version', async () => {
      const { exitCode } = await pnpmAdd('semver@7.5.4');
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
      const { exitCode } = await pnpmAdd('semver@7.6.0');
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

    it('exits non-zero for a non-existent package', async () => {
      const { exitCode } = await pnpmAdd('nonexistent-pkg-xyz-1234567');
      expect(exitCode).not.toBe(0);
    }, 30_000);

    it('succeeds for an allowed scoped package version', async () => {
      const { exitCode } = await pnpmAdd('@babel/core@7.0.0');
      expect(exitCode).toBe(0);

      const pkgJson = JSON.parse(
        readFileSync(
          join(tmpDir, 'node_modules', '@babel', 'core', 'package.json'),
          'utf-8',
        ),
      ) as { version: string };
      expect(pkgJson.version).toBe('7.0.0');
    }, 30_000);

    it('exits non-zero for a blocked scoped package version', async () => {
      const { exitCode } = await pnpmAdd('@babel/core@7.24.0');
      expect(exitCode).not.toBe(0);
    }, 30_000);

    it('installs the latest allowed version for a scoped package when no version is specified', async () => {
      const { exitCode } = await pnpmAdd('@babel/core');
      expect(exitCode).toBe(0);

      const pkgJson = JSON.parse(
        readFileSync(
          join(tmpDir, 'node_modules', '@babel', 'core', 'package.json'),
          'utf-8',
        ),
      ) as { version: string };
      // @babel/core@7.24.0 (2024-03-06) is blocked; latest pre-cutoff version should be installed
      expect(pkgJson.version).not.toBe('7.24.0');
    }, 30_000);
  });

  describe('pnpm install', () => {
    let tmpDir: string;

    beforeEach(async () => {
      tmpDir = mkdtempSync(join(tmpdir(), 'tengen-pnpm-install-'));
      writeFileSync(
        join(tmpDir, 'package.json'),
        JSON.stringify({
          name: 'test',
          version: '1.0.0',
          dependencies: { semver: '7.5.4' },
        }),
      );
      // Generate pnpm-lock.yaml with an allowed version via the proxy
      await runCommand(
        'pnpm',
        [
          'install',
          `--registry=${registryUrl}`,
          '--ignore-scripts',
          '--store-dir',
          join(tmpDir, '.pnpm-store'),
        ],
        { cwd: tmpDir },
      );
    });

    afterEach(() => {
      rmSync(tmpDir, { recursive: true, force: true });
    });

    it('installs from lockfile when all versions are allowed', async () => {
      // Remove node_modules so pnpm reinstalls from the lockfile
      rmSync(join(tmpDir, 'node_modules'), { recursive: true, force: true });

      const { exitCode } = await runCommand(
        'pnpm',
        [
          'install',
          `--registry=${registryUrl}`,
          '--ignore-scripts',
          '--frozen-lockfile',
          '--store-dir',
          join(tmpDir, '.pnpm-store'),
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
      // Rewrite package.json and patch the lockfile to reference the blocked
      // version. pnpm will try to download the tarball from the proxy URL,
      // which returns 404 for blocked versions — forcing a non-zero exit.
      writeFileSync(
        join(tmpDir, 'package.json'),
        JSON.stringify({
          name: 'test',
          version: '1.0.0',
          dependencies: { semver: '7.6.0' },
        }),
      );
      const lockPath = join(tmpDir, 'pnpm-lock.yaml');
      writeFileSync(
        lockPath,
        readFileSync(lockPath, 'utf8')
          .replace(/semver@7\.5\.4/g, 'semver@7.6.0')
          .replace(/specifier: 7\.5\.4/g, 'specifier: 7.6.0')
          .replace(/version: 7\.5\.4/g, 'version: 7.6.0')
          .replace(/semver-7\.5\.4\.tgz/g, 'semver-7.6.0.tgz'),
      );

      const { exitCode } = await runCommand(
        'pnpm',
        [
          'install',
          `--registry=${registryUrl}`,
          '--ignore-scripts',
          '--frozen-lockfile',
          '--store-dir',
          join(tmpDir, '.pnpm-store'),
        ],
        { cwd: tmpDir },
      );
      expect(exitCode).not.toBe(0);
    }, 30_000);
  });

  describe('pnpm update', () => {
    let tmpDir: string;

    beforeEach(async () => {
      tmpDir = mkdtempSync(join(tmpdir(), 'tengen-pnpm-update-'));
      // Pin to an old exact version first so pnpm update has something to do
      writeFileSync(
        join(tmpDir, 'package.json'),
        JSON.stringify({
          name: 'test',
          version: '1.0.0',
          dependencies: { semver: '7.0.0' },
        }),
      );
      await runCommand(
        'pnpm',
        [
          'install',
          `--registry=${registryUrl}`,
          '--ignore-scripts',
          '--store-dir',
          join(tmpDir, '.pnpm-store'),
        ],
        { cwd: tmpDir },
      );
      // Relax the range so pnpm update can upgrade to the latest allowed version
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

    function pnpmUpdate(
      pkgs: string[] = [],
    ): Promise<{ exitCode: number; stdout: string; stderr: string }> {
      return runCommand(
        'pnpm',
        [
          'update',
          ...pkgs,
          `--registry=${registryUrl}`,
          '--ignore-scripts',
          '--store-dir',
          join(tmpDir, '.pnpm-store'),
        ],
        { cwd: tmpDir },
      );
    }

    it('updates to the latest allowed version (does not exceed the cutoff)', async () => {
      const { exitCode } = await pnpmUpdate();
      expect(exitCode).toBe(0);

      const pkgJson = JSON.parse(
        readFileSync(
          join(tmpDir, 'node_modules', 'semver', 'package.json'),
          'utf-8',
        ),
      ) as { version: string };
      // semver@7.6.0 (2024-02-03) is blocked; 7.5.4 is the last pre-cutoff release
      expect(pkgJson.version).toBe('7.5.4');
    }, 30_000);

    it('exits zero and stays at the latest allowed version on a second run', async () => {
      await pnpmUpdate(); // first run: upgrades 7.0.0 → 7.5.4
      const { exitCode } = await pnpmUpdate(); // second run: nothing to do
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
      const { exitCode } = await pnpmUpdate(['semver']);
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

  // pnpm audit is intentionally not tested here.
  // pnpm's HTTP client cannot follow HTTP → HTTPS redirects (ERR_INVALID_PROTOCOL),
  // so audit requests that the proxy forwards via 307 to registry.npmjs.org always
  // fail on the pnpm side. The proxy's audit passthrough behaviour is covered by
  // the npm audit tests in npm.test.ts.
});
