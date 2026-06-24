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
  PASSTHROUGH_MODES,
  expectAllowedDownload,
} from './helpers.ts';
import type { TestServer } from './helpers.ts';
import http from 'node:http';

const MARKER =
  'com/diffplug/spotless/com.diffplug.spotless.gradle.plugin';
const ALLOWED = '6.23.3';
const BLOCKED = '6.25.0';

describe.each(PASSTHROUGH_MODES)(
  'Gradle Plugin Portal proxy integration tests (%s mode)',
  (mode) => {
    let ts: TestServer;
    let server: http.Server;
    let registryUrl: string;

    beforeAll(async () => {
      ts = await startTestServer({ passthroughMode: mode });
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

      it('returns 404 for a non-existent marker', async () => {
        const res = await fetch(
          `${registryUrl}/com/example/nonexistent-tengen-xyz/com.example.nonexistent-tengen-xyz.gradle.plugin/maven-metadata.xml`,
        );
        expect(res.status).toBe(404);
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
