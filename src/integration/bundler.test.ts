/**
 * Integration tests for the RubyGems registry proxy using the Bundler CLI.
 * These tests fetch real gem metadata from the upstream RubyGems registry.
 *
 * Gem version dates (cutoff = 2024-01-15):
 *   rack 2.2.8  – released 2022-11-14 → before cutoff, allowed
 *   rack 3.0.8  – released 2023-06-14 → before cutoff, allowed (latest before cutoff)
 *   rack 3.1.0  – released 2024-01-16 → after cutoff,  blocked
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
  isAvailable,
  NOW,
} from './helpers.ts';
import type { TestServer } from './helpers.ts';
import http from 'node:http';

const bundlerExists = isAvailable('bundle');

describe('rubygems proxy integration tests', () => {
  let ts: TestServer;
  let server: http.Server;
  let registryUrl: string;

  beforeAll(async () => {
    ts = await startTestServer();
    server = ts.server;
    registryUrl = ts.url('rubygems');

    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
  });

  afterAll(async () => {
    vi.useRealTimers();
    await stopTestServer(server);
  });

  describe.skipIf(!bundlerExists)('bundler CLI', () => {
    describe('bundle install', () => {
      let tmpDir: string;

      beforeEach(() => {
        tmpDir = mkdtempSync(join(tmpdir(), 'tengen-bundle-test-'));
      });

      afterEach(() => {
        rmSync(tmpDir, { recursive: true, force: true });
      });

      function bundleInstall(
        gemLine: string,
      ): Promise<{ exitCode: number; stdout: string; stderr: string }> {
        writeFileSync(
          join(tmpDir, 'Gemfile'),
          [
            '# frozen_string_literal: true',
            `source "${registryUrl}"`,
            gemLine,
            '',
          ].join('\n'),
        );
        return runCommand('bundle', ['install', '--no-color'], {
          cwd: tmpDir,
          env: { BUNDLE_PATH: join(tmpDir, 'vendor', 'bundle') },
        });
      }

      it('installs the latest allowed version when no version is specified', async () => {
        const { exitCode } = await bundleInstall('gem "rack"');
        expect(exitCode).toBe(0);

        const lockfile = readFileSync(join(tmpDir, 'Gemfile.lock'), 'utf-8');
        // rack 3.0.8 (2023-06-14) is the latest version before the cutoff and must be installed
        expect(lockfile).toContain('rack (3.0.8)');
        // rack 3.1.0 was released 2024-01-16, just after the cutoff – must not be installed
        expect(lockfile).not.toContain('rack (3.1.0)');
      }, 60_000);

      it('succeeds for an allowed version', async () => {
        const { exitCode } = await bundleInstall('gem "rack", "2.2.8"');
        expect(exitCode).toBe(0);

        const lockfile = readFileSync(join(tmpDir, 'Gemfile.lock'), 'utf-8');
        expect(lockfile).toContain('rack (2.2.8)');
      }, 60_000);

      it('exits non-zero for a blocked version', async () => {
        const { exitCode } = await bundleInstall('gem "rack", "3.1.0"');
        expect(exitCode).not.toBe(0);

        // Even if a partial lockfile was written, the blocked version must not appear
        const lockPath = join(tmpDir, 'Gemfile.lock');
        if (existsSync(lockPath)) {
          const lockfile = readFileSync(lockPath, 'utf-8');
          expect(lockfile).not.toContain('rack (3.1.0)');
        }
      }, 60_000);
    });

    describe('bundle add', () => {
      let tmpDir: string;

      beforeEach(() => {
        tmpDir = mkdtempSync(join(tmpdir(), 'tengen-bundle-add-test-'));
        writeFileSync(
          join(tmpDir, 'Gemfile'),
          [
            '# frozen_string_literal: true',
            `source "${registryUrl}"`,
            '',
          ].join('\n'),
        );
      });

      afterEach(() => {
        rmSync(tmpDir, { recursive: true, force: true });
      });

      function bundleAdd(
        gem: string,
        args: string[] = [],
      ): Promise<{ exitCode: number; stdout: string; stderr: string }> {
        return runCommand('bundle', ['add', gem, '--no-color', ...args], {
          cwd: tmpDir,
          env: { BUNDLE_PATH: join(tmpDir, 'vendor', 'bundle') },
          timeout: 55_000,
        });
      }

      it('installs the latest allowed version when no version is specified', async () => {
        const { exitCode } = await bundleAdd('rack');
        expect(exitCode).toBe(0);

        const lockfile = readFileSync(join(tmpDir, 'Gemfile.lock'), 'utf-8');
        // rack 3.0.8 (2023-06-14) is the latest version before the cutoff and must be installed
        expect(lockfile).toContain('rack (3.0.8)');
        // rack 3.1.0 was released 2024-01-16, just after the cutoff – must not be installed
        expect(lockfile).not.toContain('rack (3.1.0)');
      }, 60_000);

      it('succeeds for an allowed version', async () => {
        const { exitCode } = await bundleAdd('rack', ['--version', '2.2.8']);
        expect(exitCode).toBe(0);

        const lockfile = readFileSync(join(tmpDir, 'Gemfile.lock'), 'utf-8');
        expect(lockfile).toContain('rack (2.2.8)');
      }, 60_000);

      it('exits non-zero for a blocked version', async () => {
        const { exitCode } = await bundleAdd('rack', ['--version', '3.1.0']);
        expect(exitCode).not.toBe(0);

        // Even if a partial lockfile was written, the blocked version must not appear
        const lockPath = join(tmpDir, 'Gemfile.lock');
        if (existsSync(lockPath)) {
          const lockfile = readFileSync(lockPath, 'utf-8');
          expect(lockfile).not.toContain('rack (3.1.0)');
        }
      }, 60_000);
    });

    describe('bundle update', () => {
      let tmpDir: string;

      beforeEach(async () => {
        tmpDir = mkdtempSync(join(tmpdir(), 'tengen-bundle-update-test-'));
        // Pin to an old version so bundle update has something to upgrade
        writeFileSync(
          join(tmpDir, 'Gemfile'),
          [
            '# frozen_string_literal: true',
            `source "${registryUrl}"`,
            'gem "rack", "2.2.8"',
            '',
          ].join('\n'),
        );
        await runCommand('bundle', ['install', '--no-color'], {
          cwd: tmpDir,
          env: { BUNDLE_PATH: join(tmpDir, 'vendor', 'bundle') },
          timeout: 55_000,
        });
        // Relax the constraint so bundle update can upgrade
        writeFileSync(
          join(tmpDir, 'Gemfile'),
          [
            '# frozen_string_literal: true',
            `source "${registryUrl}"`,
            'gem "rack", ">= 2.2.8"',
            '',
          ].join('\n'),
        );
      }, 60_000);

      afterEach(() => {
        rmSync(tmpDir, { recursive: true, force: true });
      });

      function bundleUpdate(
        gems: string[] = [],
      ): Promise<{ exitCode: number; stdout: string; stderr: string }> {
        return runCommand(
          'bundle',
          ['update', ...gems, '--no-color'],
          {
            cwd: tmpDir,
            env: { BUNDLE_PATH: join(tmpDir, 'vendor', 'bundle') },
            timeout: 55_000,
          },
        );
      }

      it('updates to the latest allowed version (does not exceed the cutoff)', async () => {
        const { exitCode } = await bundleUpdate(['rack']);
        expect(exitCode).toBe(0);

        const lockfile = readFileSync(join(tmpDir, 'Gemfile.lock'), 'utf-8');
        // rack 3.0.8 (2023-06-14) is the latest version before the cutoff and must be resolved
        expect(lockfile).toContain('rack (3.0.8)');
        // rack 3.1.0 (2024-01-16) is just after the cutoff and must not be resolved
        expect(lockfile).not.toContain('rack (3.1.0)');
      }, 60_000);

      it('exits zero and stays at the latest allowed version on a second run', async () => {
        await bundleUpdate(['rack']); // first run: upgrades 2.2.8 → latest allowed
        const { exitCode } = await bundleUpdate(['rack']); // second run: nothing to do
        expect(exitCode).toBe(0);

        const lockfile = readFileSync(join(tmpDir, 'Gemfile.lock'), 'utf-8');
        // rack 3.0.8 (2023-06-14) is the latest version before the cutoff
        expect(lockfile).toContain('rack (3.0.8)');
        expect(lockfile).not.toContain('rack (3.1.0)');
      }, 60_000);
    });
  });

  describe('/api/v1/versions metadata', () => {
    it('lists only versions published before the cutoff', async () => {
      const res = await fetch(`${registryUrl}/api/v1/versions/rack.json`);
      expect(res.status).toBe(200);
      const versions = (await res.json()) as Array<{ number: string }>;
      expect(versions.some((v) => v.number === '2.2.8')).toBe(true);
      expect(versions.some((v) => v.number === '3.1.0')).toBe(false);
    }, 30_000);

    it('returns 404 for a non-existent gem', async () => {
      const res = await fetch(
        `${registryUrl}/api/v1/versions/nonexistent-gem-xyz-1234567.json`,
      );
      expect(res.status).toBe(404);
    }, 30_000);
  });

  describe('/info compact index', () => {
    it('excludes versions published after the cutoff', async () => {
      const res = await fetch(`${registryUrl}/info/rack`);
      expect(res.status).toBe(200);
      const text = await res.text();
      expect(text).toContain('2.2.8');
      expect(text).not.toContain('3.1.0');
    }, 30_000);
  });

  describe('gem tarball download', () => {
    it('returns 302 for an allowed version', async () => {
      const res = await fetch(`${registryUrl}/gems/rack-2.2.8.gem`, {
        redirect: 'manual',
      });
      expect(res.status).toBe(302);
    }, 30_000);

    it('returns 404 for a blocked version', async () => {
      const res = await fetch(`${registryUrl}/gems/rack-3.1.0.gem`, {
        redirect: 'manual',
      });
      expect(res.status).toBe(404);
    }, 30_000);

    it('returns 404 for a non-existent gem', async () => {
      const res = await fetch(
        `${registryUrl}/gems/nonexistent-gem-xyz-1234567-1.0.0.gem`,
        { redirect: 'manual' },
      );
      expect(res.status).toBe(404);
    }, 30_000);
  });
});
