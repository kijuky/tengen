/**
 * Integration tests for the Gradle CLI resolving regular dependencies through
 * the Maven registry proxy (/maven, Maven Central upstream). This exercises
 * Gradle as a *consumer* of the Maven registry; the Gradle Plugin Portal proxy
 * (/gradle-plugins) is tested separately in gradle-plugins.test.ts.
 *
 * API-level tests run unconditionally; gradle CLI tests are skipped if gradle is absent.
 *
 * Package version dates (cutoff = 2024-01-15):
 *   com.google.code.gson:gson 2.10.1 – released 2022-12-13 → before cutoff, allowed (newest allowed)
 *   com.google.code.gson:gson 2.11.0 – released 2024-05-02 → after cutoff,  blocked
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
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  startTestServer,
  stopTestServer,
  runCommand,
  isAvailable,
  NOW,
  PASSTHROUGH_MODES,
  expectAllowedDownload,
} from './helpers.ts';
import type { TestServer } from './helpers.ts';
import http from 'node:http';

const gradleExists = isAvailable('gradle');

describe.each(PASSTHROUGH_MODES)(
  'Maven proxy integration tests (Gradle) (%s mode)',
  (mode) => {
  let ts: TestServer;
  let server: http.Server;
  let registryUrl: string;

  beforeAll(async () => {
    ts = await startTestServer({ passthroughMode: mode });
    server = ts.server;
    registryUrl = ts.url('maven');

    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
  });

  afterAll(async () => {
    vi.useRealTimers();
    await stopTestServer(server);
  });

  // ── Maven metadata API ─────────────────────────────────────────────────────

  describe('maven-metadata.xml', () => {
    it('lists only versions published before the cutoff', async () => {
      const res = await fetch(
        `${registryUrl}/com/google/code/gson/gson/maven-metadata.xml`,
      );
      expect(res.ok).toBe(true);
      const xml = await res.text();
      expect(xml).toContain('<version>2.10.1</version>');
      expect(xml).not.toContain('<version>2.11.0</version>');
    }, 30_000);

    it('updates <release> and <latest> to the newest allowed version', async () => {
      const res = await fetch(
        `${registryUrl}/com/google/code/gson/gson/maven-metadata.xml`,
      );
      expect(res.ok).toBe(true);
      const xml = await res.text();
      // <release> and <latest> must not point to a blocked version
      expect(xml).not.toMatch(/<release>2\.11/);
      expect(xml).not.toMatch(/<latest>2\.11/);
    }, 30_000);

    it('returns 404 for a non-existent artifact', async () => {
      const res = await fetch(
        `${registryUrl}/com/example/nonexistent-tengen-xyz/maven-metadata.xml`,
      );
      expect(res.status).toBe(404);
    }, 30_000);

    it('returns 200 with SHA1 checksum for .sha1 path', async () => {
      const res = await fetch(
        `${registryUrl}/com/google/code/gson/gson/maven-metadata.xml.sha1`,
      );
      expect(res.status).toBe(200);
      const body = await res.text();
      expect(body).toMatch(/^[0-9a-f]{40}$/);
    }, 30_000);

    it('returns 200 with MD5 checksum for .md5 path', async () => {
      const res = await fetch(
        `${registryUrl}/com/google/code/gson/gson/maven-metadata.xml.md5`,
      );
      expect(res.status).toBe(200);
      const body = await res.text();
      expect(body).toMatch(/^[0-9a-f]{32}$/);
    }, 30_000);
  });

  // ── Maven artifact download ────────────────────────────────────────────────

  describe('Maven artifact download', () => {
    it('serves an allowed version POM', async () => {
      const res = await fetch(
        `${registryUrl}/com/google/code/gson/gson/2.10.1/gson-2.10.1.pom`,
        { redirect: 'manual' },
      );
      await expectAllowedDownload(res, mode);
    }, 30_000);

    it('returns 404 for a blocked version POM', async () => {
      const res = await fetch(
        `${registryUrl}/com/google/code/gson/gson/2.11.0/gson-2.11.0.pom`,
        { redirect: 'manual' },
      );
      expect(res.status).toBe(404);
    }, 30_000);

    it('serves an allowed version JAR', async () => {
      const res = await fetch(
        `${registryUrl}/com/google/code/gson/gson/2.10.1/gson-2.10.1.jar`,
        { redirect: 'manual' },
      );
      await expectAllowedDownload(res, mode);
    }, 30_000);

    it('returns 404 for a blocked version JAR', async () => {
      const res = await fetch(
        `${registryUrl}/com/google/code/gson/gson/2.11.0/gson-2.11.0.jar`,
        { redirect: 'manual' },
      );
      expect(res.status).toBe(404);
    }, 30_000);

    it('returns 404 for a non-existent artifact', async () => {
      const res = await fetch(
        `${registryUrl}/com/example/nonexistent-tengen-xyz/1.0.0/nonexistent-tengen-xyz-1.0.0.jar`,
        { redirect: 'manual' },
      );
      expect(res.status).toBe(404);
    }, 30_000);

    it('serves an allowed version JAR SHA1 checksum', async () => {
      const res = await fetch(
        `${registryUrl}/com/google/code/gson/gson/2.10.1/gson-2.10.1.jar.sha1`,
        { redirect: 'manual' },
      );
      await expectAllowedDownload(res, mode);
    }, 30_000);

    it('returns 404 for a blocked version JAR SHA1 checksum', async () => {
      const res = await fetch(
        `${registryUrl}/com/google/code/gson/gson/2.11.0/gson-2.11.0.jar.sha1`,
        { redirect: 'manual' },
      );
      expect(res.status).toBe(404);
    }, 30_000);

    it('serves an allowed version POM MD5 checksum', async () => {
      const res = await fetch(
        `${registryUrl}/com/google/code/gson/gson/2.10.1/gson-2.10.1.pom.md5`,
        { redirect: 'manual' },
      );
      await expectAllowedDownload(res, mode);
    }, 30_000);

    it('returns 404 for a blocked version POM MD5 checksum', async () => {
      const res = await fetch(
        `${registryUrl}/com/google/code/gson/gson/2.11.0/gson-2.11.0.pom.md5`,
        { redirect: 'manual' },
      );
      expect(res.status).toBe(404);
    }, 30_000);
  });

  // ── Gradle CLI tests (skipped if gradle is not installed) ─────────────────

  describe.skipIf(!gradleExists)('gradle CLI', () => {
    let tmpDir: string;

    beforeEach(() => {
      tmpDir = mkdtempSync(join(tmpdir(), 'tengen-gradle-test-'));
      writeFileSync(
        join(tmpDir, 'settings.gradle'),
        "rootProject.name = 'tengen-test'\n",
      );
    });

    afterEach(() => {
      rmSync(tmpDir, { recursive: true, force: true });
    });

    function gradleResolve(
      coordinate: string,
    ): Promise<{ exitCode: number; stdout: string; stderr: string }> {
      writeFileSync(
        join(tmpDir, 'build.gradle'),
        [
          'configurations { tengenDeps }',
          'repositories {',
          `    maven { url '${registryUrl}' }`,
          '}',
          'dependencies {',
          `    tengenDeps '${coordinate}'`,
          '}',
          '// Force strict resolution: accessing .files throws if any artifact is missing',
          'task resolveAll {',
          '    doLast {',
          '        configurations.tengenDeps.files.each { println it.name }',
          '    }',
          '}',
          '',
        ].join('\n'),
      );
      return runCommand('gradle', ['resolveAll', '--no-daemon'], {
        cwd: tmpDir,
        env: { GRADLE_USER_HOME: join(tmpDir, '.gradle') },
      });
    }

    function gradleResolveGson(
      version: string,
    ): Promise<{ exitCode: number; stdout: string; stderr: string }> {
      return gradleResolve(`com.google.code.gson:gson:${version}`);
    }

    function gradleDependencies(
      version: string,
    ): Promise<{ exitCode: number; stdout: string; stderr: string }> {
      writeFileSync(
        join(tmpDir, 'build.gradle'),
        [
          'configurations { tengenDeps }',
          'repositories {',
          `    maven { url '${registryUrl}' }`,
          '}',
          'dependencies {',
          `    tengenDeps 'com.google.code.gson:gson:${version}'`,
          '}',
          '',
        ].join('\n'),
      );
      return runCommand(
        'gradle',
        ['dependencies', '--configuration', 'tengenDeps', '--no-daemon'],
        {
          cwd: tmpDir,
          env: { GRADLE_USER_HOME: join(tmpDir, '.gradle') },
        },
      );
    }

    it('resolves an allowed version', async () => {
      const { exitCode } = await gradleResolveGson('2.10.1');
      expect(exitCode).toBe(0);
    }, 120_000);

    it('fails to resolve a blocked version', async () => {
      const { exitCode } = await gradleResolveGson('2.11.0');
      expect(exitCode).not.toBe(0);
    }, 120_000);

    it('resolves the latest allowed version when using a dynamic version', async () => {
      const { exitCode, stdout } = await gradleResolveGson('+');
      expect(exitCode).toBe(0);
      // 2.11.0 (2024-05-02) is after the cutoff and must not be resolved
      expect(stdout).not.toContain('2.11.0');
    }, 120_000);

    it('resolves the correct version when using a version range', async () => {
      // [2.10.1,2.11.0) allows 2.10.1 but excludes 2.11.0 (after cutoff)
      const { exitCode, stdout } = await gradleResolveGson('[2.10.1,2.11.0)');
      expect(exitCode).toBe(0);
      expect(stdout).toContain('gson-2.10.1.jar');
      expect(stdout).not.toContain('2.11.0');
    }, 120_000);

    it('shows an allowed version in the dependency tree', async () => {
      const { exitCode, stdout } = await gradleDependencies('2.10.1');
      expect(exitCode).toBe(0);
      expect(stdout).toContain('com.google.code.gson:gson:2.10.1');
    }, 120_000);

    it('fails to show a blocked version in the dependency tree', async () => {
      const { stdout } = await gradleDependencies('2.11.0');
      // `gradle dependencies` exits 0 even when resolution fails; check for FAILED marker instead
      expect(stdout).toContain('FAILED');
    }, 120_000);

    it('fails to resolve a non-existent artifact', async () => {
      const { exitCode } = await gradleResolve(
        'com.example.nonexistent-tengen-xyz:nonexistent-artifact:1.0.0',
      );
      expect(exitCode).not.toBe(0);
    }, 120_000);
  });
  },
);
