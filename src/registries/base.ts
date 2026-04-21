import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Request, Response } from 'express';
import axios, { type AxiosResponse } from 'axios';
import type { EcosystemOutput } from '../types.ts';

const DATA_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'data',
  'malicious',
);

interface RegistryConfig {
  /** Upstream registry base URL */
  upstream: string;
  /** Filter out versions published within this many milliseconds */
  delayMs: number;
}

export interface VersionMetadata {
  packageName: string;
  version: string;
  published: Date;
}

interface DownloadRouting<
  VersionMetadataType extends VersionMetadata = VersionMetadata,
> {
  condition: (req: Request) => boolean;
  /**
   * Extract the VersionMetadata for the requested download.
   * Passed to filterVersions to check delay and malicious DB.
   * Return null to block the request (treated the same as a version that fails filtering).
   */
  getVersionMetadata: (
    req: Request,
  ) => Promise<VersionMetadataType | null> | VersionMetadataType | null;
  /** Called when the version is blocked (default: 404 JSON response) */
  respondBlocked?: (res: Response, req: Request) => void;
}

interface MetadataRouting<MetadataType, VersionMetadataType = VersionMetadata> {
  condition: (req: Request) => boolean;
  requestUpstream?: (
    originalReq: Request,
  ) => Promise<AxiosResponse<MetadataType, any, {}>>;
  getVersions: (
    metadata: MetadataType,
    req: Request,
  ) => Promise<VersionMetadataType[]> | VersionMetadataType[];
  filterMetadata: (
    metadata: MetadataType,
    allowedVersions: VersionMetadataType[],
    req: Request,
  ) => Promise<MetadataType> | MetadataType;
  respond?: (
    res: Response,
    filteredMetadata: MetadataType,
    req: Request,
  ) => void;
}

interface CustomRouting {
  condition: (req: Request) => boolean;
  handle: (req: Request, res: Response) => Promise<void> | void;
}

/**
 * Base class for registry proxies.
 *
 * To add a new registry, extend this class, override `setRouting()`, and register
 * routes with `addMetadataRoute()` or `addDownloadRoute()`. For special-case
 * behaviour, add additional routes in `setRouting()` with custom `requestUpstream`,
 * `filterMetadata`, and `respond` callbacks.
 */
export abstract class RegistryProxy {
  /** The human-readable name of this registry (e.g. "npm", "pypi") */
  abstract readonly name: string;
  protected readonly config: RegistryConfig;
  private readonly routing: CustomRouting[] = [];
  private cachedMaliciousDb:
    | { packages: Set<string>; versions: Map<string, Set<string>> }
    | null
    | undefined = undefined;

  constructor(config: RegistryConfig) {
    this.config = config;
    this.setRouting();
  }

  protected setRouting() {}

  protected addMetadataRoute<T, U extends VersionMetadata = VersionMetadata>(
    route: MetadataRouting<T, U>,
  ) {
    this.routing.push({
      condition: route.condition,
      handle: async (req, res) =>
        await this.handleMetadataRoute(route, req, res),
    });
  }

  protected addDownloadRoute<U extends VersionMetadata = VersionMetadata>(
    route: DownloadRouting<U>,
  ) {
    this.routing.push({
      condition: route.condition,
      handle: async (req, res) =>
        await this.handleDownloadRoute(route, req, res),
    });
  }

  protected addCustomRoute(route: CustomRouting) {
    this.routing.push(route);
  }

  /** Build the full upstream URL from an incoming request. */
  protected buildUpstreamUrl(req: Request): string {
    const base = this.config.upstream.replace(/\/$/, '');
    const reqUrl = new URL(req.url, 'http://dummy');
    return `${base}${reqUrl.pathname}${reqUrl.search}`;
  }

  /** Entry point called by the Express router for every incoming request. */
  async handleRequest(req: Request, res: Response) {
    for (const route of this.routing) {
      if (!route.condition(req)) continue;
      await route.handle(req, res);
      return;
    }
    this.handlePassthrough(req, res);
  }

  private async handleMetadataRoute(
    route: MetadataRouting<any, any>,
    req: Request,
    res: Response,
  ) {
    route.requestUpstream ??= (origReq) =>
      axios.get(this.buildUpstreamUrl(origReq), {
        validateStatus: () => true,
        maxRedirects: 0,
      });
    const response = await route.requestUpstream(req);
    if (response.status !== 200) {
      res
        .status(response.status)
        .type(response.headers['content-type'] || 'application/json')
        .send(response.data);
      return;
    }
    const metadata = response.data;
    const versions = await route.getVersions(metadata, req);
    const filteredVersions = this.filterVersions(versions);
    const filteredMetadata = await route.filterMetadata(
      metadata,
      filteredVersions,
      req,
    );
    if (route.respond) {
      route.respond(res, filteredMetadata, req);
    } else {
      res.status(200).json(filteredMetadata);
    }
  }

  private async handleDownloadRoute(
    route: DownloadRouting<any>,
    req: Request,
    res: Response,
  ) {
    const versionMeta = await route.getVersionMetadata(req);
    if (
      versionMeta === null ||
      this.filterVersions([versionMeta]).length === 0
    ) {
      if (route.respondBlocked) {
        route.respondBlocked(res, req);
      } else {
        res.status(404).json({ error: 'Version not allowed' });
      }
      return;
    }
    this.handlePassthrough(req, res);
  }

  protected handlePassthrough(req: Request, res: Response): void {
    res.redirect(302, this.buildUpstreamUrl(req));
  }

  private getMaliciousDB(): {
    packages: Set<string>;
    versions: Map<string, Set<string>>;
  } | null {
    if (this.cachedMaliciousDb !== undefined) return this.cachedMaliciousDb;
    try {
      const content = readFileSync(
        join(DATA_DIR, `${this.name}.json`),
        'utf-8',
      );
      const raw = JSON.parse(content) as EcosystemOutput;
      this.cachedMaliciousDb = {
        packages: new Set(raw.maliciousPackages),
        versions: new Map(
          Object.entries(raw.maliciousVersions).map(([pkg, vs]) => [
            pkg,
            new Set(vs),
          ]),
        ),
      };
    } catch {
      this.cachedMaliciousDb = null;
    }
    return this.cachedMaliciousDb;
  }

  protected filterVersions(versions: VersionMetadata[]) {
    const cutoffDate = new Date(Date.now() - this.config.delayMs);
    let filtered = versions.filter((v) => v.published <= cutoffDate);
    if (filtered.length === 0) return [];

    const packageName = filtered[0].packageName;
    const db = this.getMaliciousDB();
    if (db !== null) {
      if (db.packages.has(packageName)) {
        return [];
      }
      const maliciousVersionSet = db.versions.get(packageName);
      if (maliciousVersionSet !== undefined) {
        filtered = filtered.filter((v) => !maliciousVersionSet.has(v.version));
      }
    }

    return filtered;
  }
}
