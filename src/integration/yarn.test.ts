/**
 * Integration tests for the npm registry proxy using the yarn CLI.
 * Yarn uses the same npm registry protocol as npm.
 *
 * Tests are split into two describe blocks:
 *   - classic (v1): uses .npmrc, --registry flag, --frozen-lockfile, yarn.lock v1 format
 *   - berry (v2+):  uses .yarnrc.yml, --immutable, berry lockfile format
 *
 * Both patterns run regardless of which yarn version is currently installed.
 * Version switching uses `yarn set version` (yarn built-in, no corepack required):
 *
 *   classic system → berry tests:
 *     `yarn set version berry` downloads the berry CJS bundle into a shared temp dir.
 *     Tests invoke it directly as `node <path-to-berry.cjs>`.
 *
 *   berry system  → classic tests:
 *     `yarn set version 1.22.22` downloads classic into a shared temp dir.
 *     `.yarnrc.yml` in each test dir sets `yarnPath`; berry then delegates to classic.
 *
 * Package version dates (cutoff = 2024-01-15):
 *   semver@7.5.4  – released 2023-07-21  → before cutoff, allowed
 *   semver@7.6.0  – released 2024-02-03  → after cutoff,  blocked
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
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { startTestServer, stopTestServer, runCommand, isAvailable, NOW } from './helpers.ts';
import type { TestServer } from './helpers.ts';
import http from 'node:http';

const CLASSIC_VERSION = '1.22.22';

const yarnExists = isAvailable('yarn');

const yarnVersionStr = (() => {
  if (!yarnExists) return null;
  try {
    return execSync('yarn --version', { encoding: 'utf-8' }).trim();
  } catch {
    return null;
  }
})();

/** true when the system `yarn` binary is classic (v1). */
const isSystemClassic = yarnVersionStr?.startsWith('1.') ?? false;

/** Parse the `yarnPath` entry from a .yarnrc.yml and resolve it against dir. */
function resolveYarnPath(dir: string): string {
  const content = readFileSync(join(dir, '.yarnrc.yml'), 'utf-8');
  const match = content.match(/^yarnPath:\s*(.+)$/m);
  if (!match) throw new Error(`yarnPath not found in ${join(dir, '.yarnrc.yml')}`);
  return join(dir, match[1].trim());
}

describe.skipIf(!yarnExists)('yarn integration tests', () => {
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

  // ── yarn classic (v1) ─────────────────────────────────────────────────────

  describe('classic (v1)', () => {
    /**
     * When the system yarn is berry we pre-download classic once and reuse the
     * binary path across all tests via `yarnPath` in each test dir's .yarnrc.yml.
     */
    let classicDownloadDir = '';
    let classicBinPath = ''; // only set when isSystemClassic === false

    beforeAll(async () => {
      if (!isSystemClassic) {
        classicDownloadDir = mkdtempSync(join(tmpdir(), 'tengen-yarn-classic-dl-'));
        writeFileSync(
          join(classicDownloadDir, 'package.json'),
          JSON.stringify({ name: 'dl', version: '1.0.0', private: true }),
        );
        await runCommand('yarn', ['set', 'version', CLASSIC_VERSION], {
          cwd: classicDownloadDir,
          timeout: 60_000,
        });
        classicBinPath = resolveYarnPath(classicDownloadDir);
      }
    });

    afterAll(() => {
      if (classicDownloadDir) rmSync(classicDownloadDir, { recursive: true, force: true });
    });

    function createProject(dir: string, deps: Record<string, string> = {}): void {
      writeFileSync(
        join(dir, 'package.json'),
        JSON.stringify({
          name: 'test',
          version: '1.0.0',
          private: true,
          ...(Object.keys(deps).length ? { dependencies: deps } : {}),
        }, null, 2),
      );
      writeFileSync(join(dir, '.npmrc'), `registry=${registryUrl}\n`);
      // .yarnrc must also set registry so it overrides any user-level ~/.yarnrc
      writeFileSync(join(dir, '.yarnrc'), `registry "${registryUrl}"\n`);
      if (!isSystemClassic) {
        writeFileSync(join(dir, '.yarnrc.yml'), `yarnPath: "${classicBinPath}"\n`);
      }
    }

    // ── yarn add (classic) ──────────────────────────────────────────────────

    describe('yarn add', () => {
      let tmpDir: string;

      beforeEach(() => {
        tmpDir = mkdtempSync(join(tmpdir(), 'tengen-yarn-classic-add-'));
        createProject(tmpDir);
      });

      afterEach(() => {
        rmSync(tmpDir, { recursive: true, force: true });
      });

      // Classic: use `yarn` regardless of system version.
      // - System is classic: runs directly.
      // - System is berry:   reads yarnPath from .yarnrc.yml and delegates to classic.
      function yarnAdd(pkg: string): Promise<{ exitCode: number; stdout: string; stderr: string }> {
        return runCommand(
          'yarn',
          [
            'add',
            pkg,
            '--registry',
            registryUrl,
            '--non-interactive',
            '--no-progress',
            '--ignore-scripts',
            '--cache-folder',
            join(tmpDir, '.yarn-cache'),
          ],
          { cwd: tmpDir },
        );
      }

      it('installs an allowed version', async () => {
        const { exitCode } = await yarnAdd('semver@7.5.4');
        expect(exitCode).toBe(0);

        const pkgJson = JSON.parse(
          readFileSync(join(tmpDir, 'node_modules', 'semver', 'package.json'), 'utf-8'),
        ) as { version: string };
        expect(pkgJson.version).toBe('7.5.4');
      }, 30_000);

      it('installs the latest allowed version when no version is specified', async () => {
        const { exitCode } = await yarnAdd('semver');
        expect(exitCode).toBe(0);

        const pkgJson = JSON.parse(
          readFileSync(join(tmpDir, 'node_modules', 'semver', 'package.json'), 'utf-8'),
        ) as { version: string };
        // 7.5.4 is the last pre-cutoff release; 7.6.0 (2024-02-03) is blocked
        expect(pkgJson.version).toBe('7.5.4');
      }, 30_000);

      it('exits non-zero for a blocked version', async () => {
        const { exitCode } = await yarnAdd('semver@7.6.0');
        expect(exitCode).not.toBe(0);
      }, 30_000);

      it('exits non-zero for a non-existent package', async () => {
        const { exitCode } = await yarnAdd('nonexistent-pkg-xyz-1234567');
        expect(exitCode).not.toBe(0);
      }, 30_000);
    });

    // ── yarn install (classic) ──────────────────────────────────────────────

    describe('yarn install', () => {
      let tmpDir: string;

      beforeEach(async () => {
        tmpDir = mkdtempSync(join(tmpdir(), 'tengen-yarn-classic-install-'));
        createProject(tmpDir, { semver: '7.5.4' });
        await runCommand(
          'yarn',
          [
            'install',
            '--registry',
            registryUrl,
            '--non-interactive',
            '--no-progress',
            '--ignore-scripts',
            '--cache-folder',
            join(tmpDir, '.yarn-cache'),
          ],
          { cwd: tmpDir },
        );
      });

      afterEach(() => {
        rmSync(tmpDir, { recursive: true, force: true });
      });

      it('installs from lockfile when all versions are allowed', async () => {
        rmSync(join(tmpDir, 'node_modules'), { recursive: true, force: true });

        const { exitCode } = await runCommand(
          'yarn',
          [
            'install',
            '--frozen-lockfile',
            '--registry',
            registryUrl,
            '--non-interactive',
            '--no-progress',
            '--ignore-scripts',
            '--cache-folder',
            join(tmpDir, '.yarn-cache'),
          ],
          { cwd: tmpDir },
        );
        expect(exitCode).toBe(0);

        const pkgJson = JSON.parse(
          readFileSync(join(tmpDir, 'node_modules', 'semver', 'package.json'), 'utf-8'),
        ) as { version: string };
        expect(pkgJson.version).toBe('7.5.4');
      }, 30_000);

      it('exits non-zero when lockfile references a blocked version', async () => {
        // Use a range so the lockfile entry is self-consistent (yarn validates
        // that the locked version satisfies the range before downloading).
        writeFileSync(
          join(tmpDir, 'package.json'),
          JSON.stringify({
            name: 'test',
            version: '1.0.0',
            private: true,
            dependencies: { semver: '^7.0.0' },
          }),
        );
        // Manually craft a v1 lockfile whose resolved URL points to the blocked
        // semver-7.6.0.tgz. The proxy returns 404 for it, so yarn fails.
        writeFileSync(
          join(tmpDir, 'yarn.lock'),
          [
            '# THIS IS AN AUTOGENERATED FILE. DO NOT EDIT THIS FILE DIRECTLY.',
            '# yarn lockfile v1',
            '',
            'semver@^7.0.0:',
            '  version "7.6.0"',
            `  resolved "${registryUrl}/semver/-/semver-7.6.0.tgz#0000000000000000000000000000000000000000"`,
            '  integrity sha512-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==',
            '',
          ].join('\n'),
        );
        rmSync(join(tmpDir, 'node_modules'), { recursive: true, force: true });
        // Clear local cache so yarn must re-download from the proxy
        rmSync(join(tmpDir, '.yarn-cache'), { recursive: true, force: true });

        const { exitCode } = await runCommand(
          'yarn',
          [
            'install',
            '--frozen-lockfile',
            '--registry',
            registryUrl,
            '--non-interactive',
            '--no-progress',
            '--ignore-scripts',
            '--cache-folder',
            join(tmpDir, '.yarn-cache'),
          ],
          { cwd: tmpDir },
        );
        expect(exitCode).not.toBe(0);
      }, 30_000);
    });
  });

  // ── yarn berry (v2+) ──────────────────────────────────────────────────────

  describe('berry (v2+)', () => {
    /**
     * When the system yarn is classic we pre-download berry once via
     * `yarn set version berry` and invoke the CJS bundle directly with `node`.
     * Classic does not read .yarnrc.yml, so we cannot rely on yarnPath delegation.
     */
    let berryDownloadDir = '';
    let berryBin = 'yarn'; // 'node' when classic system
    let berryBinArgs: string[] = []; // [path-to-berry.cjs] when classic system

    beforeAll(async () => {
      if (isSystemClassic) {
        berryDownloadDir = mkdtempSync(join(tmpdir(), 'tengen-yarn-berry-dl-'));
        writeFileSync(
          join(berryDownloadDir, 'package.json'),
          JSON.stringify({ name: 'dl', version: '1.0.0', private: true }),
        );
        await runCommand('yarn', ['set', 'version', 'berry'], {
          cwd: berryDownloadDir,
          timeout: 60_000,
        });
        const berryBinPath = resolveYarnPath(berryDownloadDir);
        berryBin = 'node';
        berryBinArgs = [berryBinPath];
      }
    });

    afterAll(() => {
      if (berryDownloadDir) rmSync(berryDownloadDir, { recursive: true, force: true });
    });

    function createProject(dir: string, deps: Record<string, string> = {}): void {
      writeFileSync(
        join(dir, 'package.json'),
        JSON.stringify({
          name: 'test',
          version: '1.0.0',
          private: true,
          ...(Object.keys(deps).length ? { dependencies: deps } : {}),
        }, null, 2),
      );
      // berry reads registry and other settings from .yarnrc.yml, not .npmrc.
      // No yarnPath here: berry invoked directly (classic system) or is already
      // the system yarn (berry system) and will just use itself.
      //
      // unsafeHttpWhitelist is required for berry to allow plain HTTP registries
      // (127.0.0.1 in tests). enableStrictSsl is a classic-only setting; berry
      // uses unsafeHttpWhitelist instead.
      writeFileSync(
        join(dir, '.yarnrc.yml'),
        [
          `npmRegistryServer: "${registryUrl}"`,
          `unsafeHttpWhitelist: ["127.0.0.1"]`,
          'nodeLinker: node-modules',
          'cacheFolder: "./.yarn-cache"',
          'enableScripts: false',
        ].join('\n') + '\n',
      );
    }

    /** Run yarn berry in dir, using the right binary for the current system. */
    function runBerry(
      args: string[],
      cwd: string,
    ): Promise<{ exitCode: number; stdout: string; stderr: string }> {
      return runCommand(berryBin, [...berryBinArgs, ...args], { cwd });
    }

    // ── yarn add (berry) ────────────────────────────────────────────────────

    describe('yarn add', () => {
      let tmpDir: string;

      beforeEach(() => {
        tmpDir = mkdtempSync(join(tmpdir(), 'tengen-yarn-berry-add-'));
        createProject(tmpDir);
      });

      afterEach(() => {
        rmSync(tmpDir, { recursive: true, force: true });
      });

      // berry reads registry from .yarnrc.yml; --registry flag is not available
      function yarnAdd(pkg: string): Promise<{ exitCode: number; stdout: string; stderr: string }> {
        return runBerry(['add', pkg], tmpDir);
      }

      it('installs an allowed version', async () => {
        const { exitCode } = await yarnAdd('semver@7.5.4');
        expect(exitCode).toBe(0);

        const pkgJson = JSON.parse(
          readFileSync(join(tmpDir, 'node_modules', 'semver', 'package.json'), 'utf-8'),
        ) as { version: string };
        expect(pkgJson.version).toBe('7.5.4');
      }, 30_000);

      it('installs the latest allowed version when no version is specified', async () => {
        const { exitCode } = await yarnAdd('semver');
        expect(exitCode).toBe(0);

        const pkgJson = JSON.parse(
          readFileSync(join(tmpDir, 'node_modules', 'semver', 'package.json'), 'utf-8'),
        ) as { version: string };
        // 7.5.4 is the last pre-cutoff release; 7.6.0 (2024-02-03) is blocked
        expect(pkgJson.version).toBe('7.5.4');
      }, 30_000);

      it('exits non-zero for a blocked version', async () => {
        const { exitCode } = await yarnAdd('semver@7.6.0');
        expect(exitCode).not.toBe(0);
      }, 30_000);

      it('exits non-zero for a non-existent package', async () => {
        const { exitCode } = await yarnAdd('nonexistent-pkg-xyz-1234567');
        expect(exitCode).not.toBe(0);
      }, 30_000);
    });

    // ── yarn install (berry) ────────────────────────────────────────────────

    describe('yarn install', () => {
      let tmpDir: string;

      beforeEach(async () => {
        tmpDir = mkdtempSync(join(tmpdir(), 'tengen-yarn-berry-install-'));
        createProject(tmpDir, { semver: '7.5.4' });
        // Generate yarn.lock via the proxy
        await runBerry(['install'], tmpDir);
      });

      afterEach(() => {
        rmSync(tmpDir, { recursive: true, force: true });
      });

      it('installs from lockfile when all versions are allowed', async () => {
        rmSync(join(tmpDir, 'node_modules'), { recursive: true, force: true });

        const { exitCode } = await runBerry(['install', '--immutable'], tmpDir);
        expect(exitCode).toBe(0);

        const pkgJson = JSON.parse(
          readFileSync(join(tmpDir, 'node_modules', 'semver', 'package.json'), 'utf-8'),
        ) as { version: string };
        expect(pkgJson.version).toBe('7.5.4');
      }, 30_000);

      it('exits non-zero when lockfile references a blocked version', async () => {
        writeFileSync(
          join(tmpDir, 'package.json'),
          JSON.stringify({
            name: 'test',
            version: '1.0.0',
            private: true,
            dependencies: { semver: '^7.0.0' },
          }),
        );
        // Craft a berry-format lockfile that resolves semver@^7.0.0 to blocked 7.6.0.
        // The proxy returns 404 for 7.6.0, so yarn fails to fetch the tarball.
        writeFileSync(
          join(tmpDir, 'yarn.lock'),
          [
            '__metadata:',
            '  version: 6',
            '  cacheKey: 8',
            '',
            '"semver@npm:^7.0.0":',
            '  version: 7.6.0',
            '  resolution: "semver@npm:7.6.0"',
            '  checksum: 10c0/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa==',
            '  languageName: node',
            '  linkType: hard',
            '',
          ].join('\n'),
        );
        rmSync(join(tmpDir, 'node_modules'), { recursive: true, force: true });
        // Clear local cache so yarn must re-download from the proxy
        rmSync(join(tmpDir, '.yarn-cache'), { recursive: true, force: true });

        const { exitCode } = await runBerry(['install', '--immutable'], tmpDir);
        expect(exitCode).not.toBe(0);
      }, 30_000);
    });
  });
});
