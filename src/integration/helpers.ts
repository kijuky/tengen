/**
 * Shared helpers for integration tests.
 * Each test file starts its own server instance (vitest workers are isolated).
 */

import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from '../server.ts';

export const DELAY_DAYS = 7;
export const CUTOFF = new Date('2024-01-15T00:00:00Z');
export const NOW = new Date(CUTOFF.getTime() + DELAY_DAYS * 24 * 60 * 60 * 1000);

const DEFAULT_UPSTREAMS = {
  npm: 'https://registry.npmjs.org',
  pypi: 'https://pypi.org',
  rubygems: 'https://rubygems.org',
  go: 'https://proxy.golang.org',
  composer: 'https://packagist.org',
  maven: 'https://repo.maven.apache.org/maven2',
};

export interface TestServer {
  server: http.Server;
  /** Returns the proxy base URL for a given registry name. */
  url: (registry: string) => string;
}

export async function startTestServer(): Promise<TestServer> {
  const app = createServer({
    host: '127.0.0.1',
    port: 0,
    delayDays: DELAY_DAYS,
    upstreams: DEFAULT_UPSTREAMS,
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
    proc.on('close', (code) => resolve({ exitCode: code ?? 1, stdout, stderr }));
    proc.on('error', reject);
  });
}

/** Returns true if the command exists on PATH. */
export function isAvailable(command: string): boolean {
  const result = spawnSync('which', [command], { timeout: 2000 });
  return result.status === 0;
}
