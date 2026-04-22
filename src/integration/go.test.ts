/**
 * Integration tests for the Go module proxy using real proxy.golang.org data.
 * These tests fetch real module metadata from the upstream Go proxy.
 *
 * Module version dates (cutoff = 2024-01-15):
 *   golang.org/x/text@v0.14.0    – released 2023-12-14  → before cutoff, allowed
 *   golang.org/x/text@v0.15.0    – released 2024-05-09  → after cutoff,  blocked
 *   github.com/google/uuid@v1.5.0 – released 2023-12-27 → before cutoff, allowed
 *   github.com/google/uuid@v1.6.0 – released 2024-01-16 → after cutoff,  blocked
 */

import {
  describe,
  it,
  expect,
  vi,
  beforeAll,
  afterAll,
  beforeEach,
  afterEach,
} from 'vitest';
import { execSync } from 'node:child_process';
import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  existsSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { startTestServer, stopTestServer, runCommand, NOW } from './helpers.ts';
import type { TestServer } from './helpers.ts';
import http from 'node:http';

const goExists = (() => {
  try {
    execSync('go version', { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

describe('go module proxy integration tests', () => {
  let ts: TestServer;
  let server: http.Server;
  let proxyUrl: string;

  beforeAll(async () => {
    ts = await startTestServer();
    server = ts.server;
    proxyUrl = ts.url('go');

    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
  });

  afterAll(async () => {
    vi.useRealTimers();
    await stopTestServer(server);
  });

  describe('/@v/list', () => {
    it('returns only versions published before the cutoff', async () => {
      const res = await fetch(`${proxyUrl}/golang.org/x/text/@v/list`);
      expect(res.status).toBe(200);
      const body = await res.text();
      const versions = body.split('\n').filter(Boolean);
      expect(versions).toContain('v0.14.0');
      expect(versions).not.toContain('v0.15.0');
    }, 30_000);

    it('returns only versions published before the cutoff for a github module', async () => {
      const res = await fetch(`${proxyUrl}/github.com/google/uuid/@v/list`);
      expect(res.status).toBe(200);
      const body = await res.text();
      const versions = body.split('\n').filter(Boolean);
      expect(versions).toContain('v1.5.0');
      expect(versions).not.toContain('v1.6.0');
    }, 30_000);

    it('returns 404 for a non-existent module', async () => {
      const res = await fetch(
        `${proxyUrl}/github.com/nonexistent-xyz-tengen-12345/@v/list`,
      );
      expect(res.status).toBe(404);
    }, 30_000);
  });

  describe('/@latest', () => {
    it('remaps to newest allowed version when upstream latest is after cutoff', async () => {
      const res = await fetch(`${proxyUrl}/golang.org/x/text/@latest`);
      expect(res.status).toBe(200);
      const data = (await res.json()) as { Version: string; Time: string };
      expect(new Date(data.Time).getTime()).toBeLessThanOrEqual(
        new Date('2024-01-15T00:00:00Z').getTime(),
      );
    }, 30_000);

    it('remaps to newest allowed version for a github module when latest is blocked', async () => {
      const res = await fetch(`${proxyUrl}/github.com/google/uuid/@latest`);
      expect(res.status).toBe(200);
      const data = (await res.json()) as { Version: string; Time: string };
      // v1.6.0 (2024-01-16) is blocked; expect v1.5.0 or earlier
      expect(data.Version).not.toBe('v1.6.0');
      expect(new Date(data.Time).getTime()).toBeLessThanOrEqual(
        new Date('2024-01-15T00:00:00Z').getTime(),
      );
    }, 30_000);
  });

  describe('/@v/{version}.info (passthrough)', () => {
    it('redirects .info for an allowed version', async () => {
      const res = await fetch(
        `${proxyUrl}/golang.org/x/text/@v/v0.14.0.info`,
        { redirect: 'manual' },
      );
      expect(res.status).toBe(302);
    }, 30_000);

    it('redirects .info for a blocked version (always passthrough)', async () => {
      const res = await fetch(
        `${proxyUrl}/golang.org/x/text/@v/v0.15.0.info`,
        { redirect: 'manual' },
      );
      expect(res.status).toBe(302);
    }, 30_000);
  });

  describe('/@v/{version}.mod', () => {
    it('returns 302 for an allowed version', async () => {
      const res = await fetch(
        `${proxyUrl}/golang.org/x/text/@v/v0.14.0.mod`,
        { redirect: 'manual' },
      );
      expect(res.status).toBe(302);
    }, 30_000);

    it('returns 404 for a blocked version', async () => {
      const res = await fetch(
        `${proxyUrl}/golang.org/x/text/@v/v0.15.0.mod`,
        { redirect: 'manual' },
      );
      expect(res.status).toBe(404);
    }, 30_000);
  });

  describe('/@v/{version}.zip', () => {
    it('returns 302 for an allowed version', async () => {
      const res = await fetch(
        `${proxyUrl}/github.com/google/uuid/@v/v1.5.0.zip`,
        { redirect: 'manual' },
      );
      expect(res.status).toBe(302);
    }, 30_000);

    it('returns 404 for a blocked version', async () => {
      const res = await fetch(
        `${proxyUrl}/github.com/google/uuid/@v/v1.6.0.zip`,
        { redirect: 'manual' },
      );
      expect(res.status).toBe(404);
    }, 30_000);

    it('returns 404 for a non-existent module', async () => {
      const res = await fetch(
        `${proxyUrl}/github.com/nonexistent-xyz-tengen-12345/@v/v1.0.0.zip`,
        { redirect: 'manual' },
      );
      expect(res.status).toBe(404);
    }, 30_000);
  });

  describe.skipIf(!goExists)('go CLI', () => {
    let tmpDir: string;

    beforeEach(() => {
      tmpDir = mkdtempSync(join(tmpdir(), 'tengen-go-test-'));
      writeFileSync(join(tmpDir, 'go.mod'), 'module tengen-test\n\ngo 1.21\n');
      writeFileSync(join(tmpDir, 'go.sum'), '');
    });

    afterEach(() => {
      // Go marks module cache files read-only; chmod is required before removal
      execSync(`chmod -R u+w "${tmpDir}" && rm -rf "${tmpDir}"`);
    });

    function goRun(
      args: string[],
    ): Promise<{ exitCode: number; stdout: string; stderr: string }> {
      return runCommand('go', args, {
        cwd: tmpDir,
        env: {
          // No ',direct' fallback — blocked versions must stay blocked via 404
          GOPROXY: proxyUrl,
          GONOSUMDB: '*',
          // Per-test cache inside tmpDir ensures each test hits the proxy fresh
          GOMODCACHE: join(tmpDir, '.gomodcache'),
        },
      });
    }

    function goGet(pkg: string) {
      return goRun(['get', pkg]);
    }

    it('succeeds for an allowed version', async () => {
      const { exitCode } = await goGet('golang.org/x/text@v0.14.0');
      expect(exitCode).toBe(0);
      const goMod = readFileSync(join(tmpDir, 'go.mod'), 'utf-8');
      expect(goMod).toMatch(/golang\.org\/x\/text v0\.14\.0/);
    }, 60_000);

    it('exits non-zero for a blocked version', async () => {
      const { exitCode } = await goGet('golang.org/x/text@v0.15.0');
      expect(exitCode).not.toBe(0);
      const goMod = readFileSync(join(tmpDir, 'go.mod'), 'utf-8');
      expect(goMod).not.toMatch(/golang\.org\/x\/text v0\.15\.0/);
    }, 60_000);

    it('installs the latest allowed version when @latest is specified', async () => {
      const { exitCode } = await goGet('golang.org/x/text@latest');
      expect(exitCode).toBe(0);
      const goMod = readFileSync(join(tmpDir, 'go.mod'), 'utf-8');
      expect(goMod).toContain('golang.org/x/text');
      // v0.15.0 and later are blocked; the pinned version must be before the cutoff
      const match = goMod.match(/golang\.org\/x\/text v(\S+)/);
      expect(match).not.toBeNull();
      const version = match![1];
      expect(version).not.toBe('v0.15.0');
    }, 60_000);

    it('succeeds for an allowed github module version', async () => {
      const { exitCode } = await goGet('github.com/google/uuid@v1.5.0');
      expect(exitCode).toBe(0);
      const goMod = readFileSync(join(tmpDir, 'go.mod'), 'utf-8');
      expect(goMod).toMatch(/github\.com\/google\/uuid v1\.5\.0/);
    }, 60_000);

    it('exits non-zero for a blocked github module version', async () => {
      const { exitCode } = await goGet('github.com/google/uuid@v1.6.0');
      expect(exitCode).not.toBe(0);
      const goMod = readFileSync(join(tmpDir, 'go.mod'), 'utf-8');
      expect(goMod).not.toMatch(/github\.com\/google\/uuid v1\.6\.0/);
    }, 60_000);

    describe('go mod download', () => {
      it('succeeds for an allowed version', async () => {
        const { exitCode } = await goRun([
          'mod',
          'download',
          'golang.org/x/text@v0.14.0',
        ]);
        expect(exitCode).toBe(0);
        const zipPath = join(tmpDir, '.gomodcache', 'cache', 'download', 'golang.org', 'x', 'text', '@v', 'v0.14.0.zip');
        expect(existsSync(zipPath)).toBe(true);
      }, 60_000);

      it('exits non-zero for a blocked version', async () => {
        const { exitCode } = await goRun([
          'mod',
          'download',
          'golang.org/x/text@v0.15.0',
        ]);
        expect(exitCode).not.toBe(0);
        const zipPath = join(tmpDir, '.gomodcache', 'cache', 'download', 'golang.org', 'x', 'text', '@v', 'v0.15.0.zip');
        expect(existsSync(zipPath)).toBe(false);
      }, 60_000);

      it('succeeds for an allowed github module version', async () => {
        const { exitCode } = await goRun([
          'mod',
          'download',
          'github.com/google/uuid@v1.5.0',
        ]);
        expect(exitCode).toBe(0);
        const zipPath = join(tmpDir, '.gomodcache', 'cache', 'download', 'github.com', 'google', 'uuid', '@v', 'v1.5.0.zip');
        expect(existsSync(zipPath)).toBe(true);
      }, 60_000);

      it('exits non-zero for a blocked github module version', async () => {
        const { exitCode } = await goRun([
          'mod',
          'download',
          'github.com/google/uuid@v1.6.0',
        ]);
        expect(exitCode).not.toBe(0);
        const zipPath = join(tmpDir, '.gomodcache', 'cache', 'download', 'github.com', 'google', 'uuid', '@v', 'v1.6.0.zip');
        expect(existsSync(zipPath)).toBe(false);
      }, 60_000);
    });

    describe('go list -m -versions', () => {
      it('excludes blocked versions from the version list', async () => {
        const { exitCode, stdout } = await goRun([
          'list',
          '-m',
          '-versions',
          'golang.org/x/text',
        ]);
        expect(exitCode).toBe(0);
        const versions = stdout.trim().split(/\s+/);
        expect(versions).toContain('v0.14.0');
        expect(versions).not.toContain('v0.15.0');
      }, 60_000);

      it('excludes blocked versions for a github module', async () => {
        const { exitCode, stdout } = await goRun([
          'list',
          '-m',
          '-versions',
          'github.com/google/uuid',
        ]);
        expect(exitCode).toBe(0);
        const versions = stdout.trim().split(/\s+/);
        expect(versions).toContain('v1.5.0');
        expect(versions).not.toContain('v1.6.0');
      }, 60_000);
    });

    describe('go mod tidy', () => {
      it('resolves to the latest allowed version when no version is pinned', async () => {
        writeFileSync(
          join(tmpDir, 'main.go'),
          'package main\n\nimport _ "golang.org/x/text/language"\n\nfunc main() {}\n',
        );
        const { exitCode } = await goRun(['mod', 'tidy']);
        expect(exitCode).toBe(0);
        const goMod = readFileSync(join(tmpDir, 'go.mod'), 'utf-8');
        expect(goMod).toContain('golang.org/x/text');
        const match = goMod.match(/golang\.org\/x\/text v(\S+)/);
        expect(match).not.toBeNull();
        // v0.15.0 and later are blocked; tidy must pin a version before the cutoff
        expect(match![1]).not.toBe('v0.15.0');
      }, 90_000);
    });
  });
}); // describe('go module proxy integration tests')
