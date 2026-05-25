/**
 * Integration tests for the PyPI registry proxy as used by the poetry CLI.
 * Tests are split into two layers:
 *
 *   1. HTTP layer  – direct fetch() calls that verify what poetry would receive
 *                    from the proxy (Simple API filtering, tarball gating).
 *   2. CLI layer   – actual `poetry add` / `poetry lock` invocations that exercise
 *                    the full flow including real package downloads via the proxy's
 *                    redirect to pypi.org.
 *
 * Package version dates (cutoff = 2024-01-15):
 *   certifi-2023.7.22 – released 2023-07-25 → before cutoff, allowed
 *   certifi-2024.2.2  – released 2024-02-03 → after cutoff,  blocked
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
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
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

const poetryCmd = isAvailable('poetry') ? 'poetry' : null;

let ts: TestServer;
let server: http.Server;
let simpleIndexUrl: string;
let packagesBaseUrl: string;

beforeAll(async () => {
  ts = await startTestServer();
  server = ts.server;
  simpleIndexUrl = ts.url('pypi') + '/simple/';
  packagesBaseUrl = ts.url('pypi') + '/packages/';

  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
});

afterAll(async () => {
  vi.useRealTimers();
  await stopTestServer(server);
});

// ── HTTP: Simple API filtering ─────────────────────────────────────────────────
// Verifies the response poetry would receive when it queries available versions.

describe('Simple API filtering (what poetry sees)', () => {
  it('returns only pre-cutoff versions', async () => {
    const res = await fetch(`${simpleIndexUrl}certifi/`, {
      headers: { Accept: 'application/vnd.pypi.simple.v1+json' },
    });
    expect(res.ok).toBe(true);

    const data = (await res.json()) as { versions: string[] };
    expect(data.versions).toContain('2023.7.22');
    expect(data.versions).not.toContain('2024.2.2');
  }, 30_000);

  it('propagates 404 for an unknown package', async () => {
    const res = await fetch(`${simpleIndexUrl}nonexistent-pkg-xyz-1234567/`, {
      headers: { Accept: 'application/vnd.pypi.simple.v1+json' },
    });
    expect(res.status).toBe(404);
  }, 30_000);
});

// ── HTTP: Tarball download filtering ──────────────────────────────────────────
// Verifies that the download route gates package files on the cutoff date.

describe('tarball download', () => {
  it('returns 302 for an allowed version', async () => {
    const res = await fetch(`${packagesBaseUrl}certifi-2023.7.22.tar.gz`, {
      redirect: 'manual',
    });
    expect(res.status).toBe(302);
  }, 30_000);

  it('returns 404 for a blocked version', async () => {
    const res = await fetch(`${packagesBaseUrl}certifi-2024.2.2.tar.gz`, {
      redirect: 'manual',
    });
    expect(res.status).toBe(404);
  }, 30_000);

  it('returns 404 when upstream returns 404', async () => {
    const res = await fetch(
      `${packagesBaseUrl}nonexistent-pkg-xyz-1234567-1.0.0.tar.gz`,
      { redirect: 'manual' },
    );
    expect(res.status).toBe(404);
  }, 30_000);
});

// ── CLI: poetry add ───────────────────────────────────────────────────────────
// Tests that poetry correctly installs allowed versions and fails for blocked ones.

describe.skipIf(!poetryCmd)('poetry add', () => {
  let tmpDir: string;

  function createProject() {
    writeFileSync(
      join(tmpDir, 'pyproject.toml'),
      [
        '[tool.poetry]',
        'name = "test"',
        'version = "0.1.0"',
        'description = ""',
        'authors = []',
        '',
        '[tool.poetry.dependencies]',
        'python = "^3.9"',
        '',
        '[[tool.poetry.source]]',
        'name = "proxy"',
        `url = "${simpleIndexUrl}"`,
        'priority = "primary"',
        '',
        '[build-system]',
        'requires = ["poetry-core"]',
        'build-backend = "poetry.core.masonry.api"',
        '',
      ].join('\n'),
    );
    writeFileSync(
      join(tmpDir, 'poetry.toml'),
      '[virtualenvs]\nin-project = true\n',
    );
  }

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'tengen-poetry-add-'));
    createProject();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function poetryAdd(
    pkg: string,
  ): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    return runCommand(
      poetryCmd!,
      ['add', pkg, '--no-interaction'],
      {
        cwd: tmpDir,
        env: {
          POETRY_CACHE_DIR: join(tmpDir, '.poetry-cache'),
          POETRY_CONFIG_DIR: join(tmpDir, '.poetry-config'),
        },
      },
    );
  }

  it('exits zero and installs an allowed version (real download)', async () => {
    const { exitCode } = await poetryAdd('certifi==2023.7.22');
    expect(exitCode).toBe(0);
  }, 60_000);

  it('exits non-zero for a non-existent package', async () => {
    const { exitCode } = await poetryAdd('nonexistent-pkg-xyz-1234567');
    expect(exitCode).not.toBe(0);
  }, 30_000);

  it('exits non-zero when an explicitly pinned blocked version is requested', async () => {
    // 2024.2.2 is filtered out by the proxy; poetry cannot find it
    const { exitCode } = await poetryAdd('certifi==2024.2.2');
    expect(exitCode).not.toBe(0);
  }, 30_000);
});

// ── CLI: poetry install ───────────────────────────────────────────────────────
// Tests that poetry install fails when a pinned version is blocked by the proxy.

describe.skipIf(!poetryCmd)('poetry install', () => {
  let tmpDir: string;

  function createProject(certifiConstraint: string) {
    writeFileSync(
      join(tmpDir, 'pyproject.toml'),
      [
        '[tool.poetry]',
        'name = "test"',
        'version = "0.1.0"',
        'description = ""',
        'authors = []',
        '',
        '[tool.poetry.dependencies]',
        'python = "^3.9"',
        `certifi = "${certifiConstraint}"`,
        '',
        '[[tool.poetry.source]]',
        'name = "proxy"',
        `url = "${simpleIndexUrl}"`,
        'priority = "primary"',
        '',
        '[build-system]',
        'requires = ["poetry-core"]',
        'build-backend = "poetry.core.masonry.api"',
        '',
      ].join('\n'),
    );
    writeFileSync(
      join(tmpDir, 'poetry.toml'),
      '[virtualenvs]\nin-project = true\n',
    );
  }

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'tengen-poetry-install-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('exits non-zero when only a blocked version is pinned', async () => {
    createProject('2024.2.2');

    const { exitCode } = await runCommand(
      poetryCmd!,
      ['install', '--no-root', '--no-interaction'],
      {
        cwd: tmpDir,
        env: {
          POETRY_CACHE_DIR: join(tmpDir, '.poetry-cache'),
          POETRY_CONFIG_DIR: join(tmpDir, '.poetry-config'),
        },
      },
    );
    expect(exitCode).not.toBe(0);
  }, 30_000);
});

// ── CLI: poetry sync ──────────────────────────────────────────────────────────
// Tests that poetry sync installs allowed versions and fails for blocked ones.

describe.skipIf(!poetryCmd)('poetry sync', () => {
  let tmpDir: string;

  function createProject(certifiConstraint: string) {
    writeFileSync(
      join(tmpDir, 'pyproject.toml'),
      [
        '[tool.poetry]',
        'name = "test"',
        'version = "0.1.0"',
        'description = ""',
        'authors = []',
        '',
        '[tool.poetry.dependencies]',
        'python = "^3.9"',
        `certifi = "${certifiConstraint}"`,
        '',
        '[[tool.poetry.source]]',
        'name = "proxy"',
        `url = "${simpleIndexUrl}"`,
        'priority = "primary"',
        '',
        '[build-system]',
        'requires = ["poetry-core"]',
        'build-backend = "poetry.core.masonry.api"',
        '',
      ].join('\n'),
    );
    writeFileSync(
      join(tmpDir, 'poetry.toml'),
      '[virtualenvs]\nin-project = true\n',
    );
  }

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'tengen-poetry-sync-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('exits zero and syncs an allowed version (real download)', async () => {
    createProject('2023.7.22');

    const poetryEnv = {
      POETRY_CACHE_DIR: join(tmpDir, '.poetry-cache'),
      POETRY_CONFIG_DIR: join(tmpDir, '.poetry-config'),
    };

    // First generate the lockfile
    const lock = await runCommand(
      poetryCmd!,
      ['lock', '--no-interaction'],
      { cwd: tmpDir, env: poetryEnv },
    );
    expect(lock.exitCode).toBe(0);

    const { exitCode } = await runCommand(
      poetryCmd!,
      ['sync', '--no-root', '--no-interaction'],
      { cwd: tmpDir, env: poetryEnv },
    );
    expect(exitCode).toBe(0);
  }, 120_000);

  it('exits non-zero when the lock file pins a blocked version', async () => {
    // Use a range so that after we swap the lock entry to 2024.2.2 the
    // constraint is still satisfied and poetry does not reject the lock file.
    createProject('>=2023.7');

    const poetryEnv = {
      POETRY_CACHE_DIR: join(tmpDir, '.poetry-cache'),
      POETRY_CONFIG_DIR: join(tmpDir, '.poetry-config'),
    };

    // Generate a valid lock file resolving to the allowed version 2023.7.22.
    const lockResult = await runCommand(
      poetryCmd!,
      ['lock', '--no-interaction'],
      { cwd: tmpDir, env: poetryEnv },
    );
    expect(lockResult.exitCode).toBe(0);

    // Rewrite the lock file so it pins the blocked version 2024.2.2.
    // poetry sync will then attempt to download certifi-2024.2.2.tar.gz from
    // the proxy, which returns 404 — forcing a non-zero exit.
    const lockPath = join(tmpDir, 'poetry.lock');
    const lockContent = readFileSync(lockPath, 'utf8');

    // Detect the actual certifi version that was resolved (e.g. 2023.11.17,
    // not necessarily 2023.7.22 — any pre-cutoff release may be selected).
    const versionMatch =
      /\[\[package\]\][\s\S]*?name = "certifi"[\s\S]*?version = "([^"]+)"/.exec(
        lockContent,
      );
    const lockedVersion = versionMatch?.[1];
    expect(lockedVersion).toBeDefined();

    const escapedVersion = lockedVersion!.replace(/\./g, '\\.');
    writeFileSync(
      lockPath,
      lockContent
        .replace(
          new RegExp(`version = "${escapedVersion}"`, 'g'),
          'version = "2024.2.2"',
        )
        .replace(
          new RegExp(`certifi-${escapedVersion}`, 'g'),
          'certifi-2024.2.2',
        ),
    );

    const { exitCode } = await runCommand(
      poetryCmd!,
      ['sync', '--no-root', '--no-interaction'],
      { cwd: tmpDir, env: poetryEnv },
    );
    expect(exitCode).not.toBe(0);
  }, 60_000);
});

// ── CLI: poetry lock ──────────────────────────────────────────────────────────
// Tests that poetry lock fails when a pinned version is blocked by the proxy.

describe.skipIf(!poetryCmd)('poetry lock', () => {
  let tmpDir: string;

  function createProject(certifiConstraint: string) {
    writeFileSync(
      join(tmpDir, 'pyproject.toml'),
      [
        '[tool.poetry]',
        'name = "test"',
        'version = "0.1.0"',
        'description = ""',
        'authors = []',
        '',
        '[tool.poetry.dependencies]',
        'python = "^3.9"',
        `certifi = "${certifiConstraint}"`,
        '',
        '[[tool.poetry.source]]',
        'name = "proxy"',
        `url = "${simpleIndexUrl}"`,
        'priority = "primary"',
        '',
        '[build-system]',
        'requires = ["poetry-core"]',
        'build-backend = "poetry.core.masonry.api"',
        '',
      ].join('\n'),
    );
    writeFileSync(
      join(tmpDir, 'poetry.toml'),
      '[virtualenvs]\nin-project = true\n',
    );
  }

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'tengen-poetry-lock-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('exits non-zero when only a blocked version is pinned', async () => {
    createProject('2024.2.2');

    const { exitCode } = await runCommand(
      poetryCmd!,
      ['lock', '--no-interaction'],
      {
        cwd: tmpDir,
        env: {
          POETRY_CACHE_DIR: join(tmpDir, '.poetry-cache'),
          POETRY_CONFIG_DIR: join(tmpDir, '.poetry-config'),
        },
      },
    );
    expect(exitCode).not.toBe(0);
  }, 30_000);
});
