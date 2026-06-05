/**
 * Shared helpers for integration tests.
 * Each test file starts its own server instance (vitest workers are isolated).
 */

import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { spawn, spawnSync } from 'node:child_process';
import { expect } from 'vitest';
import { createServer } from '../server.ts';

export const DELAY_DAYS = 7;
export const CUTOFF = new Date('2024-01-15T00:00:00Z');
export const NOW = new Date(
  CUTOFF.getTime() + DELAY_DAYS * 24 * 60 * 60 * 1000,
);

/**
 * The passthrough strategies every integration suite is exercised against, so
 * that download flows are verified both when the proxy redirects to the
 * upstream and when it pipes the upstream response back through itself.
 */
export const PASSTHROUGH_MODES = ['redirect', 'pipe'] as const;
export type PassthroughMode = (typeof PASSTHROUGH_MODES)[number];

/**
 * Expected HTTP status for an *allowed* download given the passthrough mode.
 * Redirect mode answers with a 307 to the upstream; pipe mode streams the
 * upstream response back, so the client sees the upstream's own 200.
 */
export function allowedDownloadStatus(mode: PassthroughMode): number {
  return mode === 'pipe' ? 200 : 307;
}

/**
 * Assert that a download was allowed under the given passthrough mode, then
 * release the response body.
 *
 * - redirect: the proxy answers 307 with no body (cancel the empty stream).
 * - pipe: the proxy streams the upstream artifact back as 200; the body must be
 *   drained so the proxy↔upstream stream completes, and is asserted non-empty
 *   for GET (HEAD has no body).
 */
export async function expectAllowedDownload(
  res: Response,
  mode: PassthroughMode,
  method: 'GET' | 'HEAD' = 'GET',
): Promise<void> {
  expect(res.status).toBe(allowedDownloadStatus(mode));
  if (mode === 'pipe' && method === 'GET') {
    const buf = await res.arrayBuffer();
    expect(buf.byteLength).toBeGreaterThan(0);
  } else {
    await res.body?.cancel().catch(() => {});
  }
}

const DEFAULT_UPSTREAMS = {
  npm: 'https://registry.npmjs.org',
  pypi: 'https://pypi.org',
  rubygems: 'https://rubygems.org',
  go: 'https://proxy.golang.org',
  composer: 'https://packagist.org',
  maven: 'https://maven-central.storage-download.googleapis.com/maven2',
  gradlePlugins: 'https://plugins.gradle.org/m2',
};

export interface TestServer {
  server: http.Server;
  /** Returns the proxy base URL for a given registry name. */
  url: (registry: string) => string;
}

export interface StartTestServerOptions {
  /** Passthrough/download serving strategy (default: "redirect"). */
  passthroughMode?: 'redirect' | 'pipe';
  /** Override individual upstream URLs (e.g. point npm at a fake server). */
  upstreams?: Partial<typeof DEFAULT_UPSTREAMS>;
}

export async function startTestServer(
  opts: StartTestServerOptions = {},
): Promise<TestServer> {
  const app = createServer({
    host: '127.0.0.1',
    port: 0,
    delayDays: DELAY_DAYS,
    maliciousDbPath: '/dev/null',
    upstreams: { ...DEFAULT_UPSTREAMS, ...opts.upstreams },
    passthroughMode: opts.passthroughMode ?? 'redirect',
  });

  const server = app.listen(0, '127.0.0.1') as unknown as http.Server;
  await new Promise<void>((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });

  const { port } = server.address() as AddressInfo;
  const base = `http://127.0.0.1:${port}`;

  return { server, url: (r) => `${base}/${r}` };
}

export async function stopTestServer(server: http.Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
}

export interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/**
 * Spawn a command asynchronously so the Node.js event loop stays alive to
 * serve the in-process proxy server while the child waits for responses.
 */
export function runCommand(
  cmd: string,
  args: string[],
  opts: { env?: Record<string, string>; cwd?: string; timeout?: number } = {},
): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, {
      timeout: opts.timeout ?? 15_000,
      env: { ...process.env, ...opts.env },
      cwd: opts.cwd,
    });

    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
    proc.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
    proc.on('close', (code) =>
      resolve({ exitCode: code ?? 1, stdout, stderr }),
    );
    proc.on('error', reject);
  });
}

/** Returns true if the command exists on PATH. */
export function isAvailable(command: string): boolean {
  const result = spawnSync('which', [command], { timeout: 2000 });
  return result.status === 0;
}
