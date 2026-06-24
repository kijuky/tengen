/**
 * Integration tests for the Maven Central registry proxy.
 * API-level tests run unconditionally; mvn CLI tests are skipped if mvn is absent.
 *
 * Package version dates (cutoff = 2024-01-15):
 *   org.apache.commons:commons-lang3 3.13.0 – released 2023-06-28 → before cutoff, allowed
 *   org.apache.commons:commons-lang3 3.15.0 – released 2024-07-04 → after cutoff,  blocked
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
import { mkdtempSync, writeFileSync, rmSync, cpSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  startTestServer,
  stopTestServer,
  runCommand,
  isAvailable,
  NOW,
  UPSTREAM_ACCESS_MODES,
  expectAllowedDownload,
} from './helpers.ts';
import type { TestServer } from './helpers.ts';
import http from 'node:http';

const mvnExists = isAvailable('mvn');

describe.each(UPSTREAM_ACCESS_MODES)(
  'Maven proxy integration tests (%s mode)',
  (mode) => {
  let ts: TestServer;
  let server: http.Server;
  let registryUrl: string;

  beforeAll(async () => {
    ts = await startTestServer({ upstreamAccess: mode });
    server = ts.server;
    registryUrl = ts.url('maven');

    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
  });

  afterAll(async () => {
    vi.useRealTimers();
    await stopTestServer(server);
  });

  // ── maven-metadata.xml ────────────────────────────────────────────────────

  describe('maven-metadata.xml', () => {
    it('lists only versions published before the cutoff', async () => {
      const res = await fetch(
        `${registryUrl}/org/apache/commons/commons-lang3/maven-metadata.xml`,
      );
      expect(res.status).toBe(200);
      const xml = await res.text();
      expect(xml).toContain('<version>3.13.0</version>');
      expect(xml).not.toContain('<version>3.15.0</version>');
    }, 30_000);

    it('returns 200 with SHA1 checksum for .sha1 path', async () => {
      const res = await fetch(
        `${registryUrl}/org/apache/commons/commons-lang3/maven-metadata.xml.sha1`,
      );
      expect(res.status).toBe(200);
      const body = await res.text();
      expect(body).toMatch(/^[0-9a-f]{40}$/);
    }, 30_000);

    it('returns 200 with MD5 checksum for .md5 path', async () => {
      const res = await fetch(
        `${registryUrl}/org/apache/commons/commons-lang3/maven-metadata.xml.md5`,
      );
      expect(res.status).toBe(200);
      const body = await res.text();
      expect(body).toMatch(/^[0-9a-f]{32}$/);
    }, 30_000);

    it('propagates upstream 404 for a non-existent artifact', async () => {
      const res = await fetch(
        `${registryUrl}/nonexistent/group/nonexistent-artifact-xyz-1234/maven-metadata.xml`,
      );
      expect(res.status).toBe(404);
    }, 30_000);

    it('updates <release> and <latest> to the newest allowed version', async () => {
      const res = await fetch(
        `${registryUrl}/org/apache/commons/commons-lang3/maven-metadata.xml`,
      );
      expect(res.ok).toBe(true);
      const xml = await res.text();
      expect(xml).not.toMatch(/<release>3\.15/);
      expect(xml).not.toMatch(/<latest>3\.15/);
    }, 30_000);
  });

  // ── Artifact download ─────────────────────────────────────────────────────

  describe('artifact download', () => {
    it('serves an allowed version JAR', async () => {
      const res = await fetch(
        `${registryUrl}/org/apache/commons/commons-lang3/3.13.0/commons-lang3-3.13.0.jar`,
        { redirect: 'manual' },
      );
      await expectAllowedDownload(res, mode);
    }, 30_000);

    it('serves an allowed version POM', async () => {
      const res = await fetch(
        `${registryUrl}/org/apache/commons/commons-lang3/3.13.0/commons-lang3-3.13.0.pom`,
        { redirect: 'manual' },
      );
      await expectAllowedDownload(res, mode);
    }, 30_000);

    it('returns 404 for a blocked version JAR', async () => {
      const res = await fetch(
        `${registryUrl}/org/apache/commons/commons-lang3/3.15.0/commons-lang3-3.15.0.jar`,
        { redirect: 'manual' },
      );
      expect(res.status).toBe(404);
    }, 30_000);

    it('returns 404 for a blocked version POM', async () => {
      const res = await fetch(
        `${registryUrl}/org/apache/commons/commons-lang3/3.15.0/commons-lang3-3.15.0.pom`,
        { redirect: 'manual' },
      );
      expect(res.status).toBe(404);
    }, 30_000);

    it('returns 404 for a non-existent artifact', async () => {
      const res = await fetch(
        `${registryUrl}/nonexistent/group/artifact-xyz-1234/1.0.0/artifact-xyz-1234-1.0.0.jar`,
        { redirect: 'manual' },
      );
      expect(res.status).toBe(404);
    }, 30_000);

    it('serves an allowed version JAR SHA1 checksum', async () => {
      const res = await fetch(
        `${registryUrl}/org/apache/commons/commons-lang3/3.13.0/commons-lang3-3.13.0.jar.sha1`,
        { redirect: 'manual' },
      );
      await expectAllowedDownload(res, mode);
    }, 30_000);

    it('returns 404 for a blocked version JAR SHA1 checksum', async () => {
      const res = await fetch(
        `${registryUrl}/org/apache/commons/commons-lang3/3.15.0/commons-lang3-3.15.0.jar.sha1`,
        { redirect: 'manual' },
      );
      expect(res.status).toBe(404);
    }, 30_000);

    it('serves an allowed version POM MD5 checksum', async () => {
      const res = await fetch(
        `${registryUrl}/org/apache/commons/commons-lang3/3.13.0/commons-lang3-3.13.0.pom.md5`,
        { redirect: 'manual' },
      );
      await expectAllowedDownload(res, mode);
    }, 30_000);

    it('returns 404 for a blocked version POM MD5 checksum', async () => {
      const res = await fetch(
        `${registryUrl}/org/apache/commons/commons-lang3/3.15.0/commons-lang3-3.15.0.pom.md5`,
        { redirect: 'manual' },
      );
      expect(res.status).toBe(404);
    }, 30_000);
  });

  // ── mvn CLI tests (skipped if mvn is not installed) ───────────────────────

  describe.skipIf(!mvnExists)('mvn CLI', () => {
    // Use fully-qualified plugin coordinates so no pom.xml is needed for
    // project-free goals (dependency:get/copy have requiresProject=false).
    // Version 3.1.2 (2019-05-05, before cutoff) avoids the doxia/reporting
    // transitive deps added in later releases.
    const MVN_DEP_PLUGIN = 'org.apache.maven.plugins:maven-dependency-plugin:3.1.2';

    // A throwaway allowed artifact used only to pre-warm the plugin closure.
    // commons-io 2.11.0 (2021-09-27, before cutoff) is allowed and has no compile
    // dependencies, so warming with it never caches the test artifact.
    const WARMUP_ARTIFACT = 'commons-io:commons-io:2.11.0';

    // sharedM2 holds a pre-warmed local repo containing the dependency-plugin and
    // the *full transitive closure* every test goal (get/copy/resolve) needs.
    // Each test copies it as its starting .m2 so that closure is never re-fetched,
    // while the test artifact (commons-lang3) is absent and still resolved through
    // the proxy — keeping proxy behaviour under test per invocation. Without this
    // every invocation re-resolves ~600 plugin-closure artifacts through the
    // proxy, each triggering an upstream publish-date lookup, which blows past the
    // 60s per-test timeout.
    let sharedM2: string;
    let tmpDir: string;

    beforeAll(async () => {
      sharedM2 = mkdtempSync(join(tmpdir(), 'tengen-mvn-shared-'));
      const warmupRepo = join(sharedM2, 'repo');
      const warmupSettings = join(sharedM2, 'settings.xml');
      writeFileSync(
        warmupSettings,
        `<settings>
  <mirrors>
    <mirror>
      <id>tengen-proxy</id>
      <mirrorOf>central</mirrorOf>
      <url>${registryUrl}</url>
    </mirror>
  </mirrors>
</settings>`,
      );
      const baseArgs = [
        `-Dmaven.repo.local=${warmupRepo}`,
        '-s',
        warmupSettings,
        '--batch-mode',
        '--no-transfer-progress',
        '-q',
      ];
      // get/copy have requiresProject=false; resolve needs a pom, written below.
      await runCommand(
        'mvn',
        [`${MVN_DEP_PLUGIN}:get`, `-Dartifact=${WARMUP_ARTIFACT}`, ...baseArgs],
        { cwd: sharedM2, timeout: 120_000 },
      );
      await runCommand(
        'mvn',
        [
          `${MVN_DEP_PLUGIN}:copy`,
          `-Dartifact=${WARMUP_ARTIFACT}`,
          `-DoutputDirectory=${join(sharedM2, 'warmup-out')}`,
          ...baseArgs,
        ],
        { cwd: sharedM2, timeout: 120_000 },
      );
      writeFileSync(
        join(sharedM2, 'pom.xml'),
        `<?xml version="1.0" encoding="UTF-8"?>
<project>
  <modelVersion>4.0.0</modelVersion>
  <groupId>test</groupId>
  <artifactId>tengen-mvn-warmup</artifactId>
  <version>1.0-SNAPSHOT</version>
  <dependencies>
    <dependency>
      <groupId>commons-io</groupId>
      <artifactId>commons-io</artifactId>
      <version>2.11.0</version>
    </dependency>
  </dependencies>
</project>`,
      );
      await runCommand(
        'mvn',
        [`${MVN_DEP_PLUGIN}:resolve`, ...baseArgs],
        { cwd: sharedM2, timeout: 120_000 },
      );
    }, 600_000);

    afterAll(() => {
      rmSync(sharedM2, { recursive: true, force: true });
    });

    beforeEach(() => {
      tmpDir = mkdtempSync(join(tmpdir(), 'tengen-mvn-test-'));
      // Seed .m2 with the pre-warmed plugin cache only — no test artifacts.
      cpSync(join(sharedM2, 'repo'), join(tmpDir, '.m2'), { recursive: true });
      // Route all repository requests through our proxy
      writeFileSync(
        join(tmpDir, 'settings.xml'),
        `<settings>
  <mirrors>
    <mirror>
      <id>tengen-proxy</id>
      <mirrorOf>central</mirrorOf>
      <url>${registryUrl}</url>
    </mirror>
  </mirrors>
</settings>`,
      );
    });

    afterEach(() => {
      rmSync(tmpDir, { recursive: true, force: true });
    });

    function mvnGet(
      artifact: string,
    ): Promise<{ exitCode: number; stdout: string; stderr: string }> {
      const localRepo = join(tmpDir, '.m2');
      return runCommand(
        'mvn',
        [
          `${MVN_DEP_PLUGIN}:get`,
          `-Dartifact=${artifact}`,
          `-Dmaven.repo.local=${localRepo}`,
          '-s',
          join(tmpDir, 'settings.xml'),
          '--batch-mode',
          '--no-transfer-progress',
        ],
        { cwd: tmpDir, timeout: 60_000 },
      );
    }

    function mvnCopy(
      artifact: string,
    ): Promise<{ exitCode: number; stdout: string; stderr: string }> {
      const localRepo = join(tmpDir, '.m2');
      const outputDir = join(tmpDir, 'copied');
      return runCommand(
        'mvn',
        [
          `${MVN_DEP_PLUGIN}:copy`,
          `-Dartifact=${artifact}`,
          `-DoutputDirectory=${outputDir}`,
          `-Dmaven.repo.local=${localRepo}`,
          '-s',
          join(tmpDir, 'settings.xml'),
          '--batch-mode',
          '--no-transfer-progress',
        ],
        { cwd: tmpDir, timeout: 60_000 },
      );
    }

    function mvnResolve(
      version: string,
    ): Promise<{ exitCode: number; stdout: string; stderr: string }> {
      const localRepo = join(tmpDir, '.m2');
      writeFileSync(
        join(tmpDir, 'pom.xml'),
        `<?xml version="1.0" encoding="UTF-8"?>
<project>
  <modelVersion>4.0.0</modelVersion>
  <groupId>test</groupId>
  <artifactId>tengen-mvn-test</artifactId>
  <version>1.0-SNAPSHOT</version>
  <dependencies>
    <dependency>
      <groupId>org.apache.commons</groupId>
      <artifactId>commons-lang3</artifactId>
      <version>${version}</version>
    </dependency>
  </dependencies>
</project>`,
      );
      return runCommand(
        'mvn',
        [
          `${MVN_DEP_PLUGIN}:resolve`,
          `-Dmaven.repo.local=${localRepo}`,
          '-s',
          join(tmpDir, 'settings.xml'),
          '--batch-mode',
          '--no-transfer-progress',
        ],
        { cwd: tmpDir, timeout: 60_000 },
      );
    }

    it('downloads an allowed version', async () => {
      const { exitCode } = await mvnGet(
        'org.apache.commons:commons-lang3:3.13.0',
      );
      expect(exitCode).toBe(0);
    }, 60_000);

    it('fails to download a blocked version', async () => {
      const { exitCode } = await mvnGet(
        'org.apache.commons:commons-lang3:3.15.0',
      );
      expect(exitCode).not.toBe(0);
    }, 60_000);

    it('fails to download a non-existent artifact', async () => {
      const { exitCode } = await mvnGet(
        'nonexistent.group:nonexistent-artifact-xyz-1234:1.0.0',
      );
      expect(exitCode).not.toBe(0);
    }, 60_000);

    it('copies an allowed version', async () => {
      const { exitCode } = await mvnCopy(
        'org.apache.commons:commons-lang3:3.13.0',
      );
      expect(exitCode).toBe(0);
    }, 60_000);

    it('fails to copy a blocked version', async () => {
      const { exitCode } = await mvnCopy(
        'org.apache.commons:commons-lang3:3.15.0',
      );
      expect(exitCode).not.toBe(0);
    }, 60_000);

    it('resolves POM-declared allowed version', async () => {
      const { exitCode } = await mvnResolve('3.13.0');
      expect(exitCode).toBe(0);
    }, 60_000);

    it('fails to resolve POM-declared blocked version', async () => {
      const { exitCode } = await mvnResolve('3.15.0');
      expect(exitCode).not.toBe(0);
    }, 60_000);
  });
  },
);
