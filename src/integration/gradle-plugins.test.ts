/**
 * Integration tests for the Gradle Plugin Portal proxy (plugins.gradle.org/m2).
 *
 * The portal serves marker artifacts ({pluginId}.gradle.plugin) in Maven m2
 * layout; publish dates come from deps.dev's Maven ecosystem. These tests hit
 * the real portal + deps.dev, so they assert against a stable plugin whose
 * versions straddle the cutoff. Gradle CLI is intentionally not exercised here:
 * resolving a plugin pulls transitive dependencies that the portal does not
 * host, so end-to-end CLI resolution is covered by the Maven suite instead.
 *
 * Plugin: com.diffplug.spotless (marker com.diffplug.spotless.gradle.plugin)
 * Cutoff = 2024-01-15 (NOW 2024-01-22, delay 7d):
 *   6.23.3 – released 2023-12-04 → before cutoff, allowed (newest allowed)
 *   6.24.0 – released 2024-01-15T01:00 → after cutoff, blocked
 *   6.25.0 – released 2024-01-23 → after cutoff, blocked
 */

import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import {
  startTestServer,
  stopTestServer,
  NOW,
  UPSTREAM_ACCESS_MODES,
  expectAllowedDownload,
} from './helpers.ts';
import type { TestServer } from './helpers.ts';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

const MARKER =
  'com/diffplug/spotless/com.diffplug.spotless.gradle.plugin';
const ALLOWED = '6.23.3';
const BLOCKED = '6.25.0';

describe.each(UPSTREAM_ACCESS_MODES)(
  'Gradle Plugin Portal proxy integration tests (%s mode)',
  (mode) => {
    let ts: TestServer;
    let server: http.Server;
    let registryUrl: string;

    beforeAll(async () => {
      ts = await startTestServer({ upstreamAccess: mode });
      server = ts.server;
      registryUrl = ts.url('gradle-plugins');

      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(NOW);
    });

    afterAll(async () => {
      vi.useRealTimers();
      await stopTestServer(server);
    });

    // ── marker maven-metadata.xml ──────────────────────────────────────────

    describe('maven-metadata.xml', () => {
      it('lists only versions published before the cutoff', async () => {
        const res = await fetch(`${registryUrl}/${MARKER}/maven-metadata.xml`);
        expect(res.ok).toBe(true);
        const xml = await res.text();
        expect(xml).toContain(`<version>${ALLOWED}</version>`);
        expect(xml).not.toContain(`<version>${BLOCKED}</version>`);
        expect(xml).not.toContain('<version>6.24.0</version>');
      }, 30_000);

      it('updates <release> and <latest> away from blocked versions', async () => {
        const res = await fetch(`${registryUrl}/${MARKER}/maven-metadata.xml`);
        expect(res.ok).toBe(true);
        const xml = await res.text();
        expect(xml).not.toMatch(/<release>6\.2[45]/);
        expect(xml).not.toMatch(/<latest>6\.2[45]/);
      }, 30_000);

      it('returns 200 with SHA1 checksum for .sha1 path', async () => {
        const res = await fetch(
          `${registryUrl}/${MARKER}/maven-metadata.xml.sha1`,
        );
        expect(res.status).toBe(200);
        expect((await res.text()).trim()).toMatch(/^[0-9a-f]{40}$/);
      }, 30_000);

      it('propagates upstream 404 for a non-existent marker', async () => {
        // The live portal answers an unknown plugin's maven-metadata.xml with a
        // 303 to Maven Central (repo.maven.apache.org), which fetchUpstreamXml
        // follows server-side; the genuine 404 only comes back from an
        // un-throttled IP. The shared CI runner IP is rate-limited by Maven
        // Central, so that follow yields 429 instead of 404 — making the live
        // portal a flaky upstream for a 404 assertion. The 303-follow path
        // itself is covered by gradle-plugins.test.ts unit tests; here we point
        // a throwaway proxy at a local upstream returning a genuine 404 and
        // verify the proxy surfaces it unchanged.
        const upstream = http.createServer((_req, res) => {
          res.statusCode = 404;
          res.end('not found');
        });
        await new Promise<void>((resolve) =>
          upstream.listen(0, '127.0.0.1', resolve),
        );
        const { port } = upstream.address() as AddressInfo;
        const fakeTs = await startTestServer({
          upstreamAccess: mode,
          upstreams: { gradlePlugins: `http://127.0.0.1:${port}` },
        });
        try {
          const res = await fetch(
            `${fakeTs.url('gradle-plugins')}/com/example/nonexistent-tengen-xyz/com.example.nonexistent-tengen-xyz.gradle.plugin/maven-metadata.xml`,
          );
          expect(res.status).toBe(404);
        } finally {
          await stopTestServer(fakeTs.server);
          await new Promise<void>((resolve) => upstream.close(() => resolve()));
        }
      }, 30_000);
    });

    // ── marker artifact downloads ──────────────────────────────────────────

    describe('marker artifact download', () => {
      it('serves an allowed version POM', async () => {
        const res = await fetch(
          `${registryUrl}/${MARKER}/${ALLOWED}/com.diffplug.spotless.gradle.plugin-${ALLOWED}.pom`,
          { redirect: 'manual' },
        );
        await expectAllowedDownload(res, mode);
      }, 30_000);

      it('returns 404 for a blocked version POM', async () => {
        const res = await fetch(
          `${registryUrl}/${MARKER}/${BLOCKED}/com.diffplug.spotless.gradle.plugin-${BLOCKED}.pom`,
          { redirect: 'manual' },
        );
        expect(res.status).toBe(404);
      }, 30_000);

      it('returns 404 for a non-existent version', async () => {
        const res = await fetch(
          `${registryUrl}/${MARKER}/0.0.0-tengen/com.diffplug.spotless.gradle.plugin-0.0.0-tengen.pom`,
          { redirect: 'manual' },
        );
        expect(res.status).toBe(404);
      }, 30_000);
    });
  },
);
