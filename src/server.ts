import express from 'express';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadConfig, type Config } from './config.ts';
import { MavenRegistryProxy } from './registries/maven.ts';
import { IvyRegistryProxy, type IvyUpstream } from './registries/ivy.ts';
import type { RegistryProxy, RegistryConfig } from './registries/base.ts';
import type { RegistrySpec } from './registry-spec.ts';
import {
  resolveArtifactoryEndpoint,
  type ArtifactoryEndpoint,
} from './registries/artifactory.ts';
import { GradlePluginsRegistryProxy } from './registries/gradle-plugins.ts';
import { NpmRegistryProxy } from './registries/npm.ts';
import { PypiRegistryProxy } from './registries/pypi.ts';
import { RubygemsRegistryProxy } from './registries/rubygems.ts';
import { GoRegistryProxy } from './registries/go.ts';
import { ComposerRegistryProxy } from './registries/composer.ts';
import { buildMaliciousDB } from './scripts/build-malicious-db.ts';

/** A resolved `#index=artifactory`: where its API lives and what answered. */
interface IvyIndex {
  endpoint: ArtifactoryEndpoint;
  version: string;
}

/** Key of an upstream within the registries, for the resolved indexes. */
function upstreamKey(spec: RegistrySpec, i: number): string {
  return `${spec.name}#${i}`;
}

/**
 * Resolve and verify the storage API endpoint for every Ivy upstream that
 * asked for one.
 *
 * Done at startup, and fatal on failure: a listing is what a resolver picks a
 * dynamic revision from, so a repository configured to filter it either can or
 * the proxy should not pretend to.
 */
async function resolveIvyIndexes(
  config: Config,
): Promise<Map<string, IvyIndex>> {
  const indexes = new Map<string, IvyIndex>();
  for (const spec of config.registries) {
    for (const [i, upstream] of spec.upstreams.entries()) {
      if (upstream.index !== 'artifactory') continue;
      const resolved = await resolveArtifactoryEndpoint(upstream.url);
      if ('error' in resolved) {
        console.error(
          `Error: ${upstream.url} in registry '${spec.name}' has ` +
            `#index=artifactory but its storage API is unusable: ${resolved.error}`,
        );
        process.exit(1);
      }
      indexes.set(upstreamKey(spec, i), resolved);
    }
  }
  return indexes;
}

export function createServer(
  config: Config,
  ivyIndexes: Map<string, IvyIndex> = new Map(),
): express.Express {
  const app = express();

  const delayMs = config.delayDays * 24 * 60 * 60 * 1000;

  const registries = config.registries.map((spec): RegistryProxy => {
    const common: RegistryConfig = {
      name: spec.name,
      upstream: spec.upstreams[0]!.url,
      publicUrl: spec.publicUrl,
      delayMs,
      maliciousDbPath: config.maliciousDbPath,
      allowlistDbPath: config.allowlistDbPath,
      upstreamAccess: config.upstreamAccess,
      baseUrl: config.baseUrl,
      cacheDir: config.cacheDir,
    };
    const mavenUpstreams = spec.upstreams.map((u) => ({
      url: u.url,
      timestamps: u.timestamps ?? 'deps-dev',
    }));
    switch (spec.type) {
      case 'npm':
        return new NpmRegistryProxy(common);
      case 'pypi':
        return new PypiRegistryProxy(common);
      case 'rubygems':
        return new RubygemsRegistryProxy(common);
      case 'go':
        return new GoRegistryProxy(common);
      case 'composer':
        return new ComposerRegistryProxy(common);
      case 'maven':
        return new MavenRegistryProxy({ ...common, upstreams: mavenUpstreams });
      case 'gradle-plugins':
        return new GradlePluginsRegistryProxy({
          ...common,
          upstreams: mavenUpstreams,
        });
      case 'ivy':
        return new IvyRegistryProxy({
          ...common,
          upstreams: spec.upstreams.map(
            (u, i): IvyUpstream => ({
              url: u.url,
              endpoint: ivyIndexes.get(upstreamKey(spec, i))?.endpoint,
            }),
          ),
        });
    }
  });

  const cacheDir = config.cacheDir;
  if (cacheDir) {
    // The malicious DB is read once per process, so each start is when an
    // updated DB first applies; sweep what it now lists out of the cache.
    for (const registry of registries) {
      registry.purgeMaliciousFromCache().catch((err) => {
        console.error(
          `[${registry.name}] could not sweep the cache: ${String(err)}`,
        );
      });
    }
  }

  for (const registry of registries) {
    app.use(`/${registry.name}`, (req, res) => {
      const start = Date.now();
      console.log(`[${registry.name}] ${req.method} ${req.path}`);

      res.on('finish', () => {
        const ms = Date.now() - start;
        console.log(
          `[${registry.name}] ${req.method} ${req.path} -> ${res.statusCode} (${ms}ms)`,
        );
      });

      registry.handleRequest(req, res).catch((err) => {
        console.error(
          `[${registry.name}] ${req.method} ${req.path} error:`,
          err,
        );
        if (!res.headersSent) {
          res
            .status(500)
            .json({ error: 'Internal Server Error', message: String(err) });
        }
      });
    });
  }

  return app;
}

export async function startServer(
  argv: string[] = process.argv.slice(2),
): Promise<void> {
  const config = loadConfig(argv);

  if (config.maliciousDbPath) {
    if (!existsSync(config.maliciousDbPath)) {
      console.error(
        `Error: malicious DB not found at ${config.maliciousDbPath}`,
      );
      process.exit(1);
    }
  } else {
    config.maliciousDbPath = join(tmpdir(), 'tengen-malicious-db.json');
    console.log(
      `No malicious DB path specified, building into ${config.maliciousDbPath}…`,
    );
    await buildMaliciousDB(config.maliciousDbPath);
    console.log(`Malicious DB built successfully at ${config.maliciousDbPath}`);
  }

  const ivyIndexes = await resolveIvyIndexes(config);
  const app = createServer(config, ivyIndexes);
  app.listen(config.port, config.host, () => {
    console.log(`tengen registry proxy started`);
    for (const spec of config.registries) {
      const label = spec.type === spec.name ? spec.name : `${spec.name} (${spec.type})`;
      console.log(`  /${label}`);
      for (const [i, upstream] of spec.upstreams.entries()) {
        const notes = [
          upstream.timestamps && `timestamps=${upstream.timestamps}`,
          ivyIndexes.has(upstreamKey(spec, i)) &&
            `index=artifactory via ${ivyIndexes.get(upstreamKey(spec, i))!.endpoint.apiBase} ` +
              `(Artifactory ${ivyIndexes.get(upstreamKey(spec, i))!.version})`,
        ].filter(Boolean);
        console.log(
          `    ${upstream.url}${notes.length > 0 ? ` (${notes.join(', ')})` : ''}`,
        );
      }
      if (spec.publicUrl) console.log(`    public-url: ${spec.publicUrl}`);
    }
    console.log(`  delay:      ${config.delayDays} day(s)`);
    console.log(`  upstream-access: ${config.upstreamAccess}`);
    if (config.baseUrl) {
      console.log(`  base-url:   ${config.baseUrl}`);
    }
    console.log(`  malicious:  ${config.maliciousDbPath}`);
    if (config.cacheDir) {
      console.log(`  cache:      ${config.cacheDir}`);
    }
    if (config.allowlistDbPath) {
      console.log(`  allowlist:  ${config.allowlistDbPath}`);
    }
    console.log(`  listening:  http://${config.host}:${config.port}`);
  });
}
