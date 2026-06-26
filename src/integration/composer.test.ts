/**
 * Integration tests for the Packagist (Composer) registry proxy.
 * These tests fetch real package metadata from the upstream Packagist registry.
 *
 * Package version dates (cutoff = 2024-01-15):
 *   monolog/monolog 2.9.1  – released 2023-02-06 → before cutoff, allowed
 *   monolog/monolog 3.5.0  – released 2023-11-14 → before cutoff, allowed (latest before cutoff)
 *   monolog/monolog 3.6.0  – released 2024-02-01 → after cutoff,  blocked
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
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  startTestServer,
  stopTestServer,
  runCommand,
  isAvailable,
  NOW,
  UPSTREAM_ACCESS_MODES,
} from './helpers.ts';
import type { TestServer } from './helpers.ts';
import http from 'node:http';

const composerExists = isAvailable('composer');

describe.each(UPSTREAM_ACCESS_MODES)(
  'packagist proxy integration tests (%s mode)',
  (mode) => {
  let ts: TestServer;
  let server: http.Server;
  let registryUrl: string;

  beforeAll(async () => {
    ts = await startTestServer({ upstreamAccess: mode });
    server = ts.server;
    registryUrl = ts.url('composer');

    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
  });

  afterAll(async () => {
    vi.useRealTimers();
    await stopTestServer(server);
  });

  describe('/packages.json root metadata', () => {
    it('returns 200 with URL fields rewritten to go through the proxy', async () => {
      const res = await fetch(`${registryUrl}/packages.json`);
      expect(res.status).toBe(200);
      const data = (await res.json()) as Record<string, unknown>;
      // metadata-url must be rewritten to a proxy-relative path, not an absolute packagist.org URL
      expect(typeof data['metadata-url']).toBe('string');
      expect((data['metadata-url'] as string).startsWith('/composer/')).toBe(true);
    }, 30_000);
  });

  describe('/p2 package metadata', () => {
    it('lists only versions published before the cutoff', async () => {
      const res = await fetch(`${registryUrl}/p2/monolog/monolog.json`);
      expect(res.status).toBe(200);
      const data = (await res.json()) as {
        packages: Record<string, Array<{ version: string }>>;
      };
      const versions = data.packages['monolog/monolog'].map((v) => v.version);
      // 2.9.1 (2023-02-06) and 3.5.0 (2023-11-14) are before the cutoff
      expect(versions).toContain('2.9.1');
      expect(versions).toContain('3.5.0');
      // 3.6.0 (2024-02-01) is after the cutoff and must be filtered out
      expect(versions).not.toContain('3.6.0');
    }, 30_000);

    it('returns 404 for a non-existent package', async () => {
      const res = await fetch(
        `${registryUrl}/p2/nonexistent-vendor/nonexistent-package-xyz123.json`,
      );
      expect(res.status).toBe(404);
    }, 30_000);

    it('returns 200 for the dev metadata endpoint (~dev.json)', async () => {
      const res = await fetch(`${registryUrl}/p2/monolog/monolog~dev.json`);
      expect(res.status).toBe(200);
      const data = (await res.json()) as {
        packages: Record<string, Array<{ version: string }>>;
      };
      expect(data).toHaveProperty('packages');
    }, 30_000);
  });

  describe.skipIf(!composerExists)('composer CLI', () => {
    describe('composer require', () => {
      let tmpDir: string;

      beforeEach(() => {
        tmpDir = mkdtempSync(join(tmpdir(), 'tengen-composer-test-'));
        writeFileSync(
          join(tmpDir, 'composer.json'),
          JSON.stringify(
            {
              repositories: [
                { type: 'composer', url: registryUrl },
                { 'packagist.org': false },
              ],
              config: { 'secure-http': false },
              require: {},
            },
            null,
            2,
          ),
        );
      });

      afterEach(() => {
        rmSync(tmpDir, { recursive: true, force: true });
      });

      function composerRequire(
        pkg: string,
        args: string[] = [],
      ): Promise<{ exitCode: number; stdout: string; stderr: string }> {
        return runCommand(
          'composer',
          [
            'require',
            pkg,
            '--no-interaction',
            '--no-progress',
            '--no-scripts',
            '--no-plugins',
            ...args,
          ],
          {
            cwd: tmpDir,
            env: {
              COMPOSER_CACHE_DIR: join(tmpDir, '.composer-cache'),
              COMPOSER_NO_INTERACTION: '1',
            },
          },
        );
      }

      it('installs the latest allowed version when no version is specified', async () => {
        const { exitCode } = await composerRequire('monolog/monolog');
        expect(exitCode).toBe(0);

        const lock = JSON.parse(
          readFileSync(join(tmpDir, 'composer.lock'), 'utf-8'),
        ) as { packages: Array<{ name: string; version: string }> };
        const pkg = lock.packages.find((p) => p.name === 'monolog/monolog');
        expect(pkg).toBeDefined();
        // 3.5.0 (2023-11-14) is the latest version before the cutoff
        expect(pkg!.version).toBe('3.5.0');
        // 3.6.0 (2024-02-01) is after the cutoff and must not be installed
        expect(pkg!.version).not.toBe('3.6.0');
      }, 60_000);

      it('succeeds for an allowed version', async () => {
        const { exitCode } = await composerRequire('monolog/monolog:2.9.1');
        expect(exitCode).toBe(0);

        const lock = JSON.parse(
          readFileSync(join(tmpDir, 'composer.lock'), 'utf-8'),
        ) as { packages: Array<{ name: string; version: string }> };
        const pkg = lock.packages.find((p) => p.name === 'monolog/monolog');
        expect(pkg).toBeDefined();
        expect(pkg!.version).toBe('2.9.1');
      }, 60_000);

      it('exits non-zero for a blocked version', async () => {
        const { exitCode } = await composerRequire('monolog/monolog:3.6.0');
        // The proxy filters 3.6.0 out of metadata, so composer cannot resolve it
        expect(exitCode).not.toBe(0);
      }, 60_000);

      it('resolves to the latest allowed version with a range constraint', async () => {
        const { exitCode } = await composerRequire('monolog/monolog:>=2.9.1');
        expect(exitCode).toBe(0);

        const lock = JSON.parse(
          readFileSync(join(tmpDir, 'composer.lock'), 'utf-8'),
        ) as { packages: Array<{ name: string; version: string }> };
        const pkg = lock.packages.find((p) => p.name === 'monolog/monolog');
        expect(pkg).toBeDefined();
        // 3.5.0 (2023-11-14) is the latest version before the cutoff
        expect(pkg!.version).toBe('3.5.0');
        // 3.6.0 (2024-02-01) is after the cutoff and must not be resolved
        expect(pkg!.version).not.toBe('3.6.0');
      }, 60_000);
    });

    describe('composer install', () => {
      let tmpDir: string;

      beforeEach(async () => {
        tmpDir = mkdtempSync(join(tmpdir(), 'tengen-composer-install-test-'));
        writeFileSync(
          join(tmpDir, 'composer.json'),
          JSON.stringify(
            {
              repositories: [
                { type: 'composer', url: registryUrl },
                { 'packagist.org': false },
              ],
              config: { 'secure-http': false },
              require: {
                'monolog/monolog': '3.5.0',
              },
            },
            null,
            2,
          ),
        );
        // Generate composer.lock via an initial install
        await runCommand(
          'composer',
          [
            'install',
            '--no-interaction',
            '--no-progress',
            '--no-scripts',
            '--no-plugins',
          ],
          {
            cwd: tmpDir,
            env: {
              COMPOSER_CACHE_DIR: join(tmpDir, '.composer-cache'),
              COMPOSER_NO_INTERACTION: '1',
            },
          },
        );
      });

      afterEach(() => {
        rmSync(tmpDir, { recursive: true, force: true });
      });

      function composerInstall(): Promise<{
        exitCode: number;
        stdout: string;
        stderr: string;
      }> {
        return runCommand(
          'composer',
          [
            'install',
            '--no-interaction',
            '--no-progress',
            '--no-scripts',
            '--no-plugins',
          ],
          {
            cwd: tmpDir,
            env: {
              COMPOSER_CACHE_DIR: join(tmpDir, '.composer-cache'),
              COMPOSER_NO_INTERACTION: '1',
            },
          },
        );
      }

      it('reinstalls from lockfile when vendor is missing', async () => {
        // Remove the vendor directory so composer install re-downloads from the lockfile
        rmSync(join(tmpDir, 'vendor'), { recursive: true, force: true });

        const { exitCode } = await composerInstall();
        expect(exitCode).toBe(0);

        const lock = JSON.parse(
          readFileSync(join(tmpDir, 'composer.lock'), 'utf-8'),
        ) as { packages: Array<{ name: string; version: string }> };
        const pkg = lock.packages.find((p) => p.name === 'monolog/monolog');
        expect(pkg).toBeDefined();
        // 3.5.0 (2023-11-14) is the pinned allowed version and must be installed
        expect(pkg!.version).toBe('3.5.0');
        // 3.6.0 (2024-02-01) is after the cutoff and must not appear
        expect(pkg!.version).not.toBe('3.6.0');
      }, 60_000);

      it('exits zero and keeps the lockfile version when vendor is already present', async () => {
        // vendor dir still exists from beforeEach; install is effectively a no-op
        const { exitCode } = await composerInstall();
        expect(exitCode).toBe(0);

        const lock = JSON.parse(
          readFileSync(join(tmpDir, 'composer.lock'), 'utf-8'),
        ) as { packages: Array<{ name: string; version: string }> };
        const pkg = lock.packages.find((p) => p.name === 'monolog/monolog');
        expect(pkg).toBeDefined();
        expect(pkg!.version).toBe('3.5.0');
      }, 60_000);

      it('exits non-zero when composer.json requires a blocked version', async () => {
        // Rewrite composer.json to require a version that the proxy filters out
        writeFileSync(
          join(tmpDir, 'composer.json'),
          JSON.stringify(
            {
              repositories: [
                { type: 'composer', url: registryUrl },
                { 'packagist.org': false },
              ],
              config: { 'secure-http': false },
              require: {
                'monolog/monolog': '3.6.0',
              },
            },
            null,
            2,
          ),
        );
        // Remove the lockfile so composer resolves from scratch against the proxy
        rmSync(join(tmpDir, 'composer.lock'), { force: true });

        const { exitCode } = await composerInstall();
        // The proxy filters 3.6.0 out of metadata, so composer cannot resolve it
        expect(exitCode).not.toBe(0);
      }, 60_000);
    });

    describe('composer update', () => {
      let tmpDir: string;

      beforeEach(async () => {
        tmpDir = mkdtempSync(join(tmpdir(), 'tengen-composer-update-test-'));
        // Pin to an old version so composer update has something to upgrade
        writeFileSync(
          join(tmpDir, 'composer.json'),
          JSON.stringify(
            {
              repositories: [
                { type: 'composer', url: registryUrl },
                { 'packagist.org': false },
              ],
              config: { 'secure-http': false },
              require: {
                'monolog/monolog': '2.9.1',
              },
            },
            null,
            2,
          ),
        );
        await runCommand(
          'composer',
          [
            'install',
            '--no-interaction',
            '--no-progress',
            '--no-scripts',
            '--no-plugins',
          ],
          {
            cwd: tmpDir,
            env: {
              COMPOSER_CACHE_DIR: join(tmpDir, '.composer-cache'),
              COMPOSER_NO_INTERACTION: '1',
            },
          },
        );
        // Relax the constraint so update can upgrade
        writeFileSync(
          join(tmpDir, 'composer.json'),
          JSON.stringify(
            {
              repositories: [
                { type: 'composer', url: registryUrl },
                { 'packagist.org': false },
              ],
              config: { 'secure-http': false },
              require: {
                'monolog/monolog': '>=2.9.1',
              },
            },
            null,
            2,
          ),
        );
      });

      afterEach(() => {
        rmSync(tmpDir, { recursive: true, force: true });
      });

      function composerUpdate(
        packages: string[] = [],
      ): Promise<{ exitCode: number; stdout: string; stderr: string }> {
        return runCommand(
          'composer',
          [
            'update',
            ...packages,
            '--no-interaction',
            '--no-progress',
            '--no-scripts',
            '--no-plugins',
          ],
          {
            cwd: tmpDir,
            env: {
              COMPOSER_CACHE_DIR: join(tmpDir, '.composer-cache'),
              COMPOSER_NO_INTERACTION: '1',
            },
          },
        );
      }

      it('updates to the latest allowed version (does not exceed the cutoff)', async () => {
        const { exitCode } = await composerUpdate(['monolog/monolog']);
        expect(exitCode).toBe(0);

        const lock = JSON.parse(
          readFileSync(join(tmpDir, 'composer.lock'), 'utf-8'),
        ) as { packages: Array<{ name: string; version: string }> };
        const pkg = lock.packages.find((p) => p.name === 'monolog/monolog');
        expect(pkg).toBeDefined();
        // 3.5.0 (2023-11-14) is the latest version before the cutoff and must be resolved
        expect(pkg!.version).toBe('3.5.0');
        // 3.6.0 (2024-02-01) is after the cutoff and must not be resolved
        expect(pkg!.version).not.toBe('3.6.0');
      }, 60_000);

      it('exits zero and stays at the latest allowed version on a second run', async () => {
        await composerUpdate(['monolog/monolog']); // first run: upgrades to latest allowed
        const { exitCode } = await composerUpdate(['monolog/monolog']); // second run: nothing to do
        expect(exitCode).toBe(0);

        const lock = JSON.parse(
          readFileSync(join(tmpDir, 'composer.lock'), 'utf-8'),
        ) as { packages: Array<{ name: string; version: string }> };
        const pkg = lock.packages.find((p) => p.name === 'monolog/monolog');
        expect(pkg).toBeDefined();
        expect(pkg!.version).toBe('3.5.0');
        expect(pkg!.version).not.toBe('3.6.0');
      }, 120_000);
    });
  });
  },
);
