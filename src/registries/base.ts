import axios, { type AxiosResponse } from 'axios';
import type { Request, Response } from 'express';
import { readFileSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import type { AllowlistDb, MaliciousDb } from '../types.ts';
import {
  CACHED_HEADERS,
  DownloadCache,
  type CachedArtifact,
} from './download-cache.ts';

export interface RegistryConfig {
  /** Upstream registry base URL */
  upstream: string;
  /** Filter out versions published within this many milliseconds */
  delayMs: number;
  /** Path to a single combined malicious DB JSON file (all ecosystems) */
  maliciousDbPath: string;
  /**
   * Optional path to a single combined allowlist JSON file (all ecosystems).
   * Allowlisted entries bypass the age-delay filter; the malicious DB check
   * still applies so explicitly known-bad versions cannot be re-enabled.
   */
  allowlistDbPath?: string;
  /**
   * How passthrough/download requests are served. "direct" (default) responds
   * with a 307 to the upstream URL; "proxied" streams the upstream response
   * back through the proxy so clients never talk to the upstream directly.
   */
  upstreamAccess?: 'direct' | 'proxied';
  /**
   * Absolute base URL of the proxy (e.g. "https://tengen.example.com", no
   * trailing slash). In `proxied` mode it is used to rewrite upstream artifact URLs
   * embedded in metadata so clients fetch through the proxy; in `direct` mode,
   * or when unset, those URLs are left pointing at the upstream.
   */
  baseUrl?: string;
  /**
   * Overrides the registry's URL prefix and display name. Used to mount several
   * instances of the same proxy class at different paths — e.g. additional Maven
   * repositories declared with `--maven-repo <name>=<url>`. Registries with a
   * fixed name ignore this.
   */
  name?: string;
  /**
   * Where a Maven-layout registry reads version publish timestamps from:
   * - "deps-dev" (default): query the deps.dev API. A version deps.dev has no
   *   record of stays blocked (fail-closed).
   * - "last-modified": HEAD the version's POM on the upstream and use its
   *   `Last-Modified` header.
   *
   * The two are exclusive. deps.dev only indexes Maven Central, so a repository
   * other than Central must use "last-modified" — with "deps-dev" every version
   * would be unknown and its metadata would come back empty. Ignored by
   * non-Maven registries.
   */
  timestampSource?: 'deps-dev' | 'last-modified';
  /**
   * Directory to keep downloaded artifacts in. When set, an allowed download is
   * fetched through the proxy, stored, and served from disk afterwards. A
   * stored artifact is judged again on every request, so a version that later
   * lands in the malicious DB stops being served and is removed. Each registry
   * keeps its own subdirectory named after the registry.
   */
  cacheDir?: string;
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
let cachedCombinedDb: MaliciousDb | null | undefined;
let cachedCombinedAllowlist: AllowlistDb | null | undefined;

/**
 * Connection-level (hop-by-hop) headers that describe the proxy↔upstream socket
 * rather than the end-to-end payload. They must be dropped when piping a
 * response, otherwise Node re-frames the body and conflicting values (e.g. a
 * forwarded `transfer-encoding: chunked`) corrupt the client-facing response.
 */
const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'transfer-encoding',
  'te',
  'trailer',
  'proxy-authenticate',
  'proxy-authorization',
  'upgrade',
]);

/** @internal Reset module-level caches. Used by tests; not part of the public API. */
export function __resetCachesForTesting() {
  cachedCombinedDb = undefined;
  cachedCombinedAllowlist = undefined;
}

export abstract class RegistryProxy {
  /** The human-readable name of this registry (e.g. "npm", "pypi"). Also the URL prefix. */
  abstract readonly name: string;
  /**
   * Ecosystem key used to look up entries in the malicious and allowlist DBs.
   * Defaults to `name`, but a registry whose artifacts are tracked under a
   * different ecosystem (e.g. Gradle plugins are Maven artifacts in OSV) can
   * override this to share another registry's DB section.
   */
  protected get dbKey(): string {
    return this.name;
  }
  protected readonly config: RegistryConfig;
  private readonly routing: CustomRouting[] = [];
  private cachedMaliciousDb:
    | { packages: Set<string>; versions: Map<string, Set<string>> }
    | null
    | undefined = undefined;
  private cachedAllowlist:
    | { packages: Set<string>; versions: Map<string, Set<string>> }
    | null
    | undefined = undefined;

  private downloadCacheInstance: DownloadCache | null | undefined = undefined;

  constructor(config: RegistryConfig) {
    this.config = config;
    this.setRouting();
  }

  /**
   * The download cache, or null when `cacheDir` is not configured. Created on
   * first use because `name` is an abstract field that a subclass assigns
   * after this class's constructor has run.
   */
  private get downloadCache(): DownloadCache | null {
    if (this.downloadCacheInstance === undefined) {
      this.downloadCacheInstance = this.config.cacheDir
        ? new DownloadCache(join(this.config.cacheDir, this.name))
        : null;
    }
    return this.downloadCacheInstance;
  }

  /**
   * Whether a download of this version may be stored. An artifact that can
   * change under the same path — a Maven `-SNAPSHOT` — must not be, or the
   * cache would keep serving an old build.
   */
  protected isCacheable(_version: VersionMetadata): boolean {
    return true;
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

  protected addPassthroughRoute(condition: (req: Request) => boolean) {
    this.routing.push({
      condition,
      handle: (req, res) => this.handlePassthrough(req, res),
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
    await this.handlePassthrough(req, res);
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
      if (response.headers['location']) {
        const location = response.headers['location'];
        try {
          const locationUrl = new URL(location);
          const upstreamUrl = new URL(this.config.upstream);
          if (locationUrl.origin === upstreamUrl.origin) {
            res.set(
              'location',
              '/' +
                this.name +
                locationUrl.pathname +
                locationUrl.search +
                locationUrl.hash,
            );
          } else {
            res.set('location', location);
          }
        } catch {
          res.set('location', location);
        }
      }
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
    const respondBlocked = () => {
      if (route.respondBlocked) {
        route.respondBlocked(res, req);
      } else {
        res.status(404).json({ error: 'Version not allowed' });
      }
    };
    const cache = this.downloadCache;
    const isRead = req.method === 'GET' || req.method === 'HEAD';

    if (cache !== null && isRead) {
      const cached = await cache.lookup(req.path);
      if (cached !== null) {
        // Judged again with what was stored, not with a fresh upstream lookup:
        // the malicious DB is local and a publish date does not change, so a
        // stored artifact stays servable while the upstream is unreachable.
        if (this.filterVersions([cached.version]).length === 0) {
          if (this.isKnownMalicious(cached.version)) {
            await cache.remove(req.path);
            console.log(
              `[${this.name}] removed ${req.path} from the cache: ` +
                `${cached.version.packageName}@${cached.version.version} is in the malicious DB`,
            );
          }
          respondBlocked();
          return;
        }
        await this.serveCached(cached, req, res);
        return;
      }
    }

    const versionMeta = await route.getVersionMetadata(req);
    if (
      versionMeta === null ||
      this.filterVersions([versionMeta]).length === 0
    ) {
      respondBlocked();
      return;
    }
    if (cache !== null && req.method === 'GET' && this.isCacheable(versionMeta)) {
      await this.fetchIntoCache(cache, versionMeta, req, res);
      return;
    }
    await this.handlePassthrough(req, res);
  }

  /** Answer a download from the cache. */
  private async serveCached(
    cached: CachedArtifact,
    req: Request,
    res: Response,
  ): Promise<void> {
    res.status(200);
    for (const [key, value] of Object.entries(cached.headers)) {
      if (value !== undefined) res.setHeader(key, value);
    }
    res.setHeader('content-length', String(cached.size));
    if (req.method === 'HEAD') {
      res.end();
      return;
    }
    const handle = await open(cached.dataFile, 'r');
    const stream = handle.createReadStream();
    stream.on('error', (err) => res.destroy(err));
    stream.pipe(res);
  }

  /**
   * Fetch an allowed download from the upstream, stream it to the client and
   * store it at the same time.
   *
   * The upstream is followed through redirects here, unlike the passthrough:
   * the bytes have to pass through the proxy to be stored, whichever
   * `upstreamAccess` is configured.
   */
  private async fetchIntoCache(
    cache: DownloadCache,
    version: VersionMetadata,
    req: Request,
    res: Response,
  ): Promise<void> {
    const upstream = await axios.get(this.buildUpstreamUrl(req), {
      responseType: 'stream',
      decompress: false,
      validateStatus: () => true,
    });
    const body = upstream.data as NodeJS.ReadableStream;

    res.status(upstream.status);
    for (const [key, value] of Object.entries(upstream.headers)) {
      if (value === undefined) continue;
      if (HOP_BY_HOP_HEADERS.has(key.toLowerCase())) continue;
      res.setHeader(key, value as string | string[]);
    }

    if (upstream.status === 200) {
      const headers: Partial<Record<(typeof CACHED_HEADERS)[number], string>> =
        {};
      for (const key of CACHED_HEADERS) {
        const value = upstream.headers[key];
        if (typeof value === 'string') headers[key] = value;
      }
      const length = Number(upstream.headers['content-length']);
      const toCache = new PassThrough();
      body.pipe(toCache);
      // Storing is independent of the client: an artifact it stopped reading
      // half way is still kept whole, and a failed store does not fail the
      // response.
      cache
        .store(req.path, toCache, {
          expectedSize: Number.isFinite(length) ? length : undefined,
          headers,
          version,
        })
        .catch((err) => {
          console.error(
            `[${this.name}] could not cache ${req.path}: ${String(err)}`,
          );
        });
    }

    body.on('error', (err) => {
      if (res.headersSent) {
        res.destroy(err instanceof Error ? err : new Error(String(err)));
      } else {
        res.status(502).json({ error: 'Bad Gateway', message: String(err) });
      }
    });
    body.pipe(res);
  }

  /**
   * Remove every cached artifact whose version is now in the malicious DB.
   *
   * A request for such an artifact already removes it, but one nobody asks for
   * again would stay on disk; the malicious DB is read once per process, so a
   * sweep at startup covers each update of it.
   *
   * @returns the number of artifacts removed
   */
  async purgeMaliciousFromCache(): Promise<number> {
    const cache = this.downloadCache;
    if (cache === null) return 0;
    let removed = 0;
    for await (const entry of cache.entries()) {
      if (!this.isKnownMalicious(entry.version)) continue;
      await cache.remove(entry.path);
      removed++;
      console.log(
        `[${this.name}] removed ${entry.path} from the cache: ` +
          `${entry.version.packageName}@${entry.version.version} is in the malicious DB`,
      );
    }
    return removed;
  }

  protected async handlePassthrough(
    req: Request,
    res: Response,
  ): Promise<void> {
    if (this.config.upstreamAccess === 'proxied') {
      await this.pipePassthrough(req, res);
      return;
    }
    const url = this.buildUpstreamUrl(req);
    // Always use 307 so the client preserves the original HTTP method (e.g.
    // POST for npm audit). 302 allows clients to switch to GET, which causes
    // upstream to return 405 Method Not Allowed.
    res.redirect(307, url);
  }

  /**
   * Stream the upstream response back through the proxy instead of redirecting.
   * Used when clients can only reach the proxy directly (not the upstream).
   */
  private async pipePassthrough(req: Request, res: Response): Promise<void> {
    const url = this.buildUpstreamUrl(req);
    const hasBody = req.method !== 'GET' && req.method !== 'HEAD';
    // Forward the client's request headers (e.g. content-encoding for npm
    // audit's gzipped POST body) except hop-by-hop headers and host, which
    // must reflect the upstream target rather than the proxy.
    const headers: Record<string, string | string[]> = {};
    for (const [key, value] of Object.entries(req.headers)) {
      if (value === undefined) continue;
      const lower = key.toLowerCase();
      if (lower === 'host') continue;
      if (HOP_BY_HOP_HEADERS.has(lower)) continue;
      headers[key] = value;
    }

    const upstream = await axios.request({
      url,
      method: req.method,
      headers,
      data: hasBody ? req : undefined,
      responseType: 'stream',
      decompress: false,
      validateStatus: () => true,
    });

    res.status(upstream.status);
    for (const [key, value] of Object.entries(upstream.headers)) {
      if (value === undefined) continue;
      if (HOP_BY_HOP_HEADERS.has(key.toLowerCase())) continue;
      res.setHeader(key, value as string | string[]);
    }

    const stream = upstream.data as NodeJS.ReadableStream;
    stream.on('error', (err) => {
      if (res.headersSent) {
        res.destroy(err instanceof Error ? err : new Error(String(err)));
      } else {
        res.status(502).json({ error: 'Bad Gateway', message: String(err) });
      }
    });
    stream.pipe(res);
  }

  private getMaliciousDB(): {
    packages: Set<string>;
    versions: Map<string, Set<string>>;
  } | null {
    if (this.cachedMaliciousDb !== undefined) return this.cachedMaliciousDb;
    try {
      const dbPath = this.config.maliciousDbPath;
      if (cachedCombinedDb === undefined) {
        const content = readFileSync(dbPath, 'utf-8');
        cachedCombinedDb = JSON.parse(content) as MaliciousDb;
      }
      const raw = cachedCombinedDb?.[this.dbKey];
      if (!raw) {
        this.cachedMaliciousDb = null;
        return null;
      }
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

  private getAllowlistDB(): {
    packages: Set<string>;
    versions: Map<string, Set<string>>;
  } | null {
    if (this.cachedAllowlist !== undefined) return this.cachedAllowlist;
    const dbPath = this.config.allowlistDbPath;
    if (!dbPath) {
      this.cachedAllowlist = null;
      return null;
    }
    try {
      if (cachedCombinedAllowlist === undefined) {
        const content = readFileSync(dbPath, 'utf-8');
        cachedCombinedAllowlist = JSON.parse(content) as AllowlistDb;
      }
      const raw = cachedCombinedAllowlist?.[this.dbKey];
      if (!raw) {
        this.cachedAllowlist = null;
        return null;
      }
      this.cachedAllowlist = {
        packages: new Set(raw.allowlistedPackages),
        versions: new Map(
          Object.entries(raw.allowlistedVersions).map(([pkg, vs]) => [
            pkg,
            new Set(vs),
          ]),
        ),
      };
    } catch {
      this.cachedAllowlist = null;
    }
    return this.cachedAllowlist;
  }

  /**
   * Whether the malicious DB lists this version, ignoring the age filter and
   * the allowlist — the allowlist only exempts from the age filter.
   */
  protected isKnownMalicious(version: VersionMetadata): boolean {
    const db = this.getMaliciousDB();
    if (db === null) return false;
    return (
      db.packages.has(version.packageName) ||
      db.versions.get(version.packageName)?.has(version.version) === true
    );
  }

  protected filterVersions(versions: VersionMetadata[]) {
    if (versions.length === 0) return [];

    const allowlist = this.getAllowlistDB();
    const packageName = versions[0].packageName;
    const isPackageAllowlisted =
      allowlist !== null && allowlist.packages.has(packageName);
    const allowlistedVersionSet = allowlist?.versions.get(packageName);

    const cutoffDate = new Date(Date.now() - this.config.delayMs);
    let filtered = versions.filter(
      (v) =>
        v.published <= cutoffDate ||
        isPackageAllowlisted ||
        allowlistedVersionSet?.has(v.version) === true,
    );
    if (filtered.length === 0) return [];

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
