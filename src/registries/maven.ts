import type { Request, Response } from 'express';
import axios, { type AxiosResponse } from 'axios';
import { createHash } from 'node:crypto';
import {
  RegistryProxy,
  type RegistryConfig,
  type VersionMetadata,
} from './base.ts';
import { TtlCache } from './ttl-cache.ts';

interface DepsDevVersionEntry {
  versionKey: { system: string; name: string; version: string };
  publishedAt: string;
}

interface DepsDevPackageResponse {
  versions: DepsDevVersionEntry[];
}

interface DepsDevVersionResponse {
  versionKey: { system: string; name: string; version: string };
  publishedAt: string;
}

/** An upstream's maven-metadata.xml and the versions in it that may be offered. */
interface ResolvedMetadata {
  xml: string;
  allowed: VersionMetadata[];
}

interface MavenCoordinates {
  groupId: string;
  artifactId: string;
  version: string;
}

/** How many `Last-Modified` probes run at once. */
const PROBE_CONCURRENCY = 8;

/**
 * How long a probed timestamp is reused.
 *
 * Without a cache every metadata request re-probes every version. The window is
 * short because a repository can rewrite an artifact's mtime on re-sync, and a
 * stale value would keep serving a version whose timestamp has since moved
 * forward into the cooldown window.
 */
const PROBE_TTL_MS = 10 * 60 * 1000;

/** How many probed timestamps are kept before the oldest are dropped. */
const PROBE_CACHE_MAX = 10_000;

/** What a HEAD of a URL said, shared across registry instances. */
interface HeadResult {
  /** Whether the upstream has the file (answered 200). */
  found: boolean;
  /** Its `Last-Modified`, when it has the file and sent a readable one. */
  lastModified: Date | null;
}

/** `url -> HEAD result`, shared across registry instances. */
const probeCache = new TtlCache<HeadResult>(PROBE_TTL_MS, PROBE_CACHE_MAX);

/** @internal Reset the probe cache. Used by tests; not part of the public API. */
export function __resetProbeCacheForTesting() {
  probeCache.clear();
}

/** Upper bound on redirect hops when resolving metadata or probing a POM. */
const MAX_METADATA_REDIRECTS = 3;

/** Statuses that carry a `Location` worth following for a GET/HEAD. */
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/** One upstream of a Maven-layout registry. */
export interface MavenUpstream {
  url: string;
  /**
   * Where version publish timestamps are read from:
   * - "deps-dev": query the deps.dev API. A version deps.dev has no record of
   *   stays blocked (fail-closed). deps.dev only indexes Maven Central.
   * - "last-modified": HEAD the version's POM on the upstream and use its
   *   `Last-Modified` header.
   */
  timestamps: 'deps-dev' | 'last-modified';
}

export interface MavenRegistryConfig extends RegistryConfig {
  /**
   * The upstreams, searched in order. More than one makes a group: metadata
   * is merged across them and each artifact is served by the first upstream
   * that holds it. Unset means `upstream`, dated through deps.dev.
   */
  upstreams?: MavenUpstream[];
}

export class MavenRegistryProxy extends RegistryProxy {
  readonly name: string;

  constructor(config: MavenRegistryConfig) {
    super(config);
    this.name = config.name ?? 'maven';
  }

  /**
   * Read off `config` rather than held in a field: the base constructor calls
   * `setRouting()`, which runs before a subclass's own initialisers.
   */
  private get upstreams(): MavenUpstream[] {
    const configured = (this.config as MavenRegistryConfig).upstreams;
    if (configured && configured.length > 0) return configured;
    return [
      { url: this.config.upstream.replace(/\/$/, ''), timestamps: 'deps-dev' },
    ];
  }

  /** A `-SNAPSHOT` path can be redeployed with new contents. */
  protected override isCacheable(version: VersionMetadata): boolean {
    return !version.version.endsWith('-SNAPSHOT');
  }

  /**
   * Routes requests:
   *   /{groupId/as/path}/{artifactId}/maven-metadata.xml         → filtered XML metadata
   *   /{...}/maven-metadata.xml.{sha1,md5,sha256,sha512}         → checksum of filtered XML
   *   /{...}/{version}/maven-metadata.xml                        → filtered snapshot metadata
   *   /{groupId/as/path}/{artifactId}/{version}/{file}          → download check (403 if version blocked)
   *   everything else                                           → passthrough
   */
  public setRouting() {
    this.addCustomRoute({
      condition: (req) => isMavenMetadataPath(req.path),
      handle: (req, res) => this.respondMetadata(req, res),
    });

    this.addDownloadRoute({
      condition: (req) => isMavenDownloadPath(req.path),
      getVersionMetadata: (req) => this.getDownloadVersionMetadata(req),
    });
  }

  /**
   * Answer a maven-metadata.xml request (or one for its checksum) from every
   * upstream at once, each filtered with its own timestamps, then merged.
   */
  private async respondMetadata(req: Request, res: Response): Promise<void> {
    const xmlPath = getXmlPath(req.path);
    const upstreams = this.upstreams;
    const documents = await Promise.all(
      upstreams.map((upstream) => this.fetchMetadataDocument(upstream, xmlPath)),
    );

    // A version belongs to the first upstream listing it (see mergeMetadata),
    // so a later upstream's date for it would never be used. Not dating those
    // spares a later upstream that mirrors an earlier one — sbt-maven-releases
    // answers Central's metadata — a HEAD per version.
    const listedBefore: Set<string>[] = [];
    const listed = new Set<string>();
    for (const document of documents) {
      listedBefore.push(new Set(listed));
      if (document.status !== 200) continue;
      for (const version of parseVersionsFromXml(document.data)) {
        listed.add(version);
      }
    }

    const results = await Promise.all(
      documents.map((response, i) =>
        response.status === 200
          ? this.judgeMetadata(
              upstreams[i]!,
              response.data,
              xmlPath,
              listedBefore[i]!,
            )
          : { response },
      ),
    );
    const found = results.filter((r): r is ResolvedMetadata => 'xml' in r);
    if (found.length === 0) {
      // Nothing to serve. A failure other than "not here" says more than a
      // 404 would, so it is the one passed on.
      const { response } = (results.find(
        (r) => 'response' in r && r.response.status !== 404,
      ) ?? results[0]!) as { response: AxiosResponse<string> };
      res
        .status(response.status)
        .type(
          (response.headers['content-type'] as string | undefined) ||
            'application/json',
        )
        .send(response.data);
      return;
    }
    this.respondWithMetadata(res, this.mergeMetadata(found), req);
  }

  /**
   * One upstream's maven-metadata.xml, or the response it failed with.
   *
   * A transport failure — a reset connection, a truncated body — becomes a
   * 502 for that upstream alone, so the others still answer: one unreachable
   * member must not take the whole group down.
   */
  private async fetchMetadataDocument(
    upstream: MavenUpstream,
    xmlPath: string,
  ): Promise<AxiosResponse<string>> {
    try {
      return await this.fetchUpstreamXml(upstream, xmlPath);
    } catch (err) {
      console.error(
        `[${this.name}] ${upstream.url}${xmlPath} failed: ${String(err)}`,
      );
      return badGateway(`${upstream.url}${xmlPath}: ${String(err)}`);
    }
  }

  /**
   * Date and filter one upstream's document, leaving out the versions an
   * earlier upstream listed. A failure while dating is that upstream's alone,
   * as with fetching.
   */
  private async judgeMetadata(
    upstream: MavenUpstream,
    xml: string,
    xmlPath: string,
    listedBefore: Set<string>,
  ): Promise<ResolvedMetadata | { response: AxiosResponse<string> }> {
    try {
      const versions = await this.fetchVersions(
        upstream,
        xml,
        xmlPath,
        listedBefore,
      );
      return { xml, allowed: this.filterVersions(versions) };
    } catch (err) {
      console.error(
        `[${this.name}] dating ${upstream.url}${xmlPath} failed: ${String(err)}`,
      );
      return {
        response: badGateway(`${upstream.url}${xmlPath}: ${String(err)}`),
      };
    }
  }

  /**
   * Combine the filtered documents of the upstreams that had one.
   *
   * A version belongs to the first upstream that lists it: that is the one a
   * download of it is served from, so it is also the one whose verdict counts —
   * a version blocked there is not offered on the strength of another
   * upstream's copy.
   */
  private mergeMetadata(found: ResolvedMetadata[]): string {
    if (found.length === 1) {
      return this.filterXml(found[0]!.xml, found[0]!.allowed);
    }

    const listings = found.filter((f) => f.xml.includes('<versions>'));
    if (listings.length === 0) {
      // A snapshot's version-level document describes one build, served by
      // the first upstream whose build is past the cooldown.
      if (found.some((f) => f.xml.includes('<snapshotVersions>'))) {
        const allowed = found.find(
          (f) => f.xml.includes('<snapshotVersions>') && f.allowed.length > 0,
        );
        return allowed?.xml ?? '';
      }
      // Group-level metadata (a plugin group's listing) carries no versions.
      return found[0]!.xml;
    }

    const merged: VersionMetadata[] = [];
    const seen = new Set<string>();
    for (const listing of listings) {
      const allowed = new Map(listing.allowed.map((v) => [v.version, v]));
      for (const version of parseVersionsFromXml(listing.xml)) {
        if (seen.has(version)) continue;
        seen.add(version);
        const meta = allowed.get(version);
        if (meta) merged.push(meta);
      }
    }
    if (merged.length === 0) return '';

    const order = new Map(merged.map((v, i) => [v.version, i] as const));
    const latest = merged.reduce((acc, v) => {
      if (v.published > acc.published) return v;
      if (v.published < acc.published) return acc;
      return order.get(v.version)! > order.get(acc.version)! ? v : acc;
    });
    const template = listings[0]!.xml.replace(
      /<versions>[\s\S]*?<\/versions>/,
      `<versions>${merged.map((v) => `<version>${v.version}</version>`).join('')}</versions>`,
    );
    return (
      filterMavenMetadataXml(
        template,
        new Set(merged.map((v) => v.version)),
        latest.version,
        latest.published,
      ) ?? ''
    );
  }

  /**
   * Date a download. A group serves it from the first upstream that holds the
   * file, and that upstream's timestamps decide; a single upstream is asked
   * directly, as it is the only place the file can come from.
   */
  private async getDownloadVersionMetadata(
    req: Request,
  ): Promise<VersionMetadata | null> {
    const parsed = parseMavenDownloadPath(req.path);
    if (!parsed) return null;
    const upstreams = this.upstreams;
    if (upstreams.length === 1) {
      return this.dateDownload(upstreams[0]!, req.path, parsed);
    }
    for (const upstream of upstreams) {
      const url = `${upstream.url}${req.path}`;
      // An upstream that cannot be reached is passed over like one without
      // the file, so the rest of the group still answers.
      let found: boolean;
      try {
        found = (await this.head(url)).found;
      } catch (err) {
        console.error(`[${this.name}] HEAD ${url} failed: ${String(err)}`);
        continue;
      }
      if (!found) continue;
      const meta = await this.dateDownload(upstream, req.path, parsed);
      return meta ? { ...meta, upstreamUrl: url } : null;
    }
    return null;
  }

  private async dateDownload(
    upstream: MavenUpstream,
    path: string,
    { groupId, artifactId, version }: MavenCoordinates,
  ): Promise<VersionMetadata | null> {
    const packageName = `${groupId}:${artifactId}`;

    // Probe the requested file itself rather than a constructed POM path: a
    // snapshot artifact is named {artifact}-{version}-{timestamp}-{build}.ext
    // and has no {artifact}-{version}.pom beside it, so deriving the POM name
    // would 404 and block every snapshot download.
    const viaLastModified = async (): Promise<VersionMetadata | null> => {
      const url = `${upstream.url}${path}`;
      // A probe that fails leaves the version undated, which blocks it.
      let published: Date | null;
      try {
        published = await this.fetchLastModified(url);
      } catch (err) {
        console.error(`[${this.name}] HEAD ${url} failed: ${String(err)}`);
        return null;
      }
      if (!published) return null;
      return { packageName, version, published };
    };

    if (upstream.timestamps === 'last-modified') {
      return viaLastModified();
    }

    const res = await axios.get<DepsDevVersionResponse>(
      `https://api.deps.dev/v3alpha/systems/maven/packages/${packageName}/versions/${encodeURIComponent(version)}`,
      { validateStatus: () => true, maxRedirects: 0 },
    );
    if (res.status !== 200 || !res.data?.publishedAt) {
      // deps.dev indexes some packages days or weeks after they reach Central.
      // Until it does, the upstream's own Last-Modified dates the file, so the
      // version is still held for the cooldown instead of being refused for good.
      return viaLastModified();
    }
    return {
      packageName,
      version: res.data.versionKey.version,
      published: new Date(res.data.publishedAt),
    };
  }

  /**
   * Fetch the upstream maven-metadata.xml, following redirects server-side.
   *
   * Several Maven repositories answer metadata with a redirect rather than the
   * document — `repo.scala-sbt.org/scalasbt/maven-releases` 302s to Central and
   * `maven.google.com` 301s to `dl.google.com`, for two. Handing that redirect
   * to the client would send it straight to the upstream and bypass the age and
   * malicious filters entirely, so the hops are followed here and the resolved
   * document is filtered as usual.
   */
  protected async fetchUpstreamXml(
    upstream: MavenUpstream,
    xmlPath: string,
  ): Promise<AxiosResponse<string>> {
    let url = `${upstream.url}${xmlPath}`;
    let res = await axios.get<string>(url, {
      responseType: 'text',
      validateStatus: () => true,
      maxRedirects: 0,
    });

    for (let hops = 0; hops < MAX_METADATA_REDIRECTS; hops++) {
      const location = res.headers['location'];
      if (!REDIRECT_STATUSES.has(res.status) || typeof location !== 'string') {
        return res;
      }
      try {
        url = new URL(location, url).toString();
      } catch {
        return res;
      }
      res = await axios.get<string>(url, {
        responseType: 'text',
        validateStatus: () => true,
        maxRedirects: 0,
      });
    }

    // Still redirecting after the cap. Handing this back would let the base
    // class forward the redirect, and the client would then fetch the metadata
    // from the upstream unfiltered — the very bypass the loop above exists to
    // close. Refuse instead.
    if (REDIRECT_STATUSES.has(res.status)) {
      return {
        ...res,
        status: 502,
        headers: { 'content-type': 'application/json' },
        data: JSON.stringify({
          error: 'Bad Gateway',
          message: `metadata for ${xmlPath} redirected more than ${MAX_METADATA_REDIRECTS} times`,
        }),
      };
    }
    return res;
  }

  /**
   * Date the versions of a document. `skip` lists versions not to date — ones
   * an earlier upstream of the group already decides — and only matters where
   * dating costs a request per version.
   */
  private async fetchVersions(
    upstream: MavenUpstream,
    metadata: string,
    xmlPath: string,
    skip: ReadonlySet<string> = new Set(),
  ): Promise<VersionMetadata[]> {
    // A version-level maven-metadata.xml describes one timestamped SNAPSHOT
    // build and carries its own timestamp, so it needs neither deps.dev nor a
    // probe.
    if (metadata.includes('<snapshotVersions>')) {
      return snapshotVersions(metadata, xmlPath);
    }

    // Group-level metadata lists plugins/artifacts without <versions> — skip search
    if (!metadata.includes('<versions>')) return [];

    const { groupId, artifactId } = parseMavenPath(xmlPath);
    const packageName = `${groupId}:${artifactId}`;

    if (upstream.timestamps === 'last-modified') {
      return this.fetchVersionsViaLastModified(
        upstream,
        metadata,
        groupId,
        artifactId,
        skip,
      );
    }

    const res = await axios.get<DepsDevPackageResponse>(
      `https://api.deps.dev/v3alpha/systems/maven/packages/${packageName}`,
      { validateStatus: () => true, maxRedirects: 0 },
    );
    if (res.status !== 200 || !res.data?.versions) {
      // deps.dev does not know the package yet: date it the way a non-Central
      // upstream is dated.
      return this.fetchVersionsViaLastModified(
        upstream,
        metadata,
        groupId,
        artifactId,
        skip,
      );
    }
    const dated: VersionMetadata[] = res.data.versions.map((v) => ({
      packageName,
      version: v.versionKey.version,
      published: new Date(v.publishedAt),
    }));
    // deps.dev can lag Central by days or weeks for a single version too. Those
    // listed in the metadata but missing there are probed on the upstream.
    const known = new Set(dated.map((v) => v.version));
    const missing = parseVersionsFromXml(metadata).filter(
      (v) => !known.has(v) && !skip.has(v),
    );
    if (missing.length === 0) return dated;
    const probed = await this.probeAll(upstream, groupId, artifactId, missing);
    for (const [version, published] of probed) {
      if (published) dated.push({ packageName, version, published });
    }
    return dated;
  }

  /**
   * Resolve publish timestamps from the upstream's `Last-Modified` headers.
   *
   * `maven-metadata.xml` carries no per-version timestamps, so each version has
   * to be probed — but `<lastUpdated>` records when the metadata was last
   * rewritten, which is the moment the newest version appeared. When that is
   * already past the cutoff, every version in the document is older still and
   * none need probing: the document's own timestamp answers for all of them,
   * and it is an upper bound on each version's publish time, so it is safe to
   * report as such.
   *
   * Otherwise something landed inside the cooldown window and every version is
   * probed, in parallel and through a short-lived cache. Versions whose
   * timestamp cannot be read are excluded rather than assumed old enough.
   *
   * Note that `<versions>` is *not* in publication order — a maintenance
   * release lands after the next minor's first prerelease, and
   * `org.apache.logging.log4j:log4j-core` ends its list at a 2024 prerelease
   * while its newest release is from 2026. Anything that walks the list and
   * stops early is therefore unsound.
   */
  private async fetchVersionsViaLastModified(
    upstream: MavenUpstream,
    metadata: string,
    groupId: string,
    artifactId: string,
    skip: ReadonlySet<string>,
  ): Promise<VersionMetadata[]> {
    const packageName = `${groupId}:${artifactId}`;
    const versions = parseVersionsFromXml(metadata).filter((v) => !skip.has(v));
    if (versions.length === 0) return [];

    const cutoff = new Date(Date.now() - this.config.delayMs);
    const lastUpdated = parseMetadataLastUpdated(metadata);
    if (lastUpdated && lastUpdated < cutoff) {
      return versions.map((version) => ({
        packageName,
        version,
        published: lastUpdated,
      }));
    }

    const probed = await this.probeAll(upstream, groupId, artifactId, versions);
    const resolved: VersionMetadata[] = [];
    for (const [version, published] of probed) {
      if (!published) continue;
      resolved.push({ packageName, version, published });
    }
    return resolved;
  }

  /** Probe every version's timestamp, bounded to PROBE_CONCURRENCY at a time. */
  private async probeAll(
    upstream: MavenUpstream,
    groupId: string,
    artifactId: string,
    versions: string[],
  ): Promise<[string, Date | null][]> {
    const out: [string, Date | null][] = new Array(versions.length);
    let next = 0;
    const worker = async () => {
      for (;;) {
        const i = next++;
        if (i >= versions.length) return;
        const version = versions[i]!;
        out[i] = [
          version,
          await this.fetchPublishedViaLastModified(
            upstream,
            groupId,
            artifactId,
            version,
          ),
        ];
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(PROBE_CONCURRENCY, versions.length) }, worker),
    );
    return out;
  }

  /**
   * Read a version's publish time from the upstream's `Last-Modified` header.
   *
   * The POM is the file every release has, so it is the probe target. A
   * `-SNAPSHOT` version has no `{artifact}-{version}.pom` — its artifacts are
   * timestamped — but its version directory carries a `maven-metadata.xml`
   * that is rewritten on every build, so that stands in as the probe.
   */
  private async fetchPublishedViaLastModified(
    upstream: MavenUpstream,
    groupId: string,
    artifactId: string,
    version: string,
  ): Promise<Date | null> {
    const groupPath = groupId.split('.').join('/');
    const dir = `${upstream.url}/${groupPath}/${artifactId}/${version}`;
    const file = version.endsWith('-SNAPSHOT')
      ? 'maven-metadata.xml'
      : `${artifactId}-${version}.pom`;
    // A probe that fails leaves the version undated, which keeps it out —
    // the same as a missing Last-Modified — rather than failing the document.
    try {
      return await this.fetchLastModified(`${dir}/${file}`);
    } catch (err) {
      console.error(`[${this.name}] HEAD ${dir}/${file} failed: ${String(err)}`);
      return null;
    }
  }

  /** A URL's `Last-Modified`, or null when it is missing or unreadable. */
  private async fetchLastModified(url: string): Promise<Date | null> {
    return (await this.head(url)).lastModified;
  }

  /** HEAD a URL, cached for PROBE_TTL_MS. */
  private async head(url: string): Promise<HeadResult> {
    const hit = probeCache.get(url);
    if (hit !== undefined) return hit;
    // Follow redirects: a repository may point at where the artifact really
    // lives (e.g. repo.scala-sbt.org 302s to Central), and that is the file
    // whose timestamp matters.
    const res = await axios.head(url, {
      validateStatus: () => true,
      maxRedirects: MAX_METADATA_REDIRECTS,
    });
    const result: HeadResult = {
      found: res.status === 200,
      lastModified: null,
    };
    const lastModified = res.headers['last-modified'];
    if (result.found && typeof lastModified === 'string') {
      const published = new Date(lastModified);
      if (!Number.isNaN(published.getTime())) result.lastModified = published;
    }
    probeCache.set(url, result);
    return result;
  }

  private filterXml(
    metadata: string,
    allowedVersions: VersionMetadata[],
  ): string {
    // A snapshot's metadata describes a single build (one entry per extension
    // and classifier), so it is served whole or not at all. An empty
    // allowedVersions means that build is inside the cooldown window.
    if (metadata.includes('<snapshotVersions>')) {
      return allowedVersions.length > 0 ? metadata : '';
    }

    if (!metadata.includes('<versions>')) return metadata;
    // Ties on `published` are normal with the last-modified source — a
    // repository that re-syncs stamps every file with the same mtime, and one
    // observed Ivy module has all 382 of its revisions at the same minute. Fall
    // back to the document's own ordering, where Maven puts the newest last.
    const order = new Map(
      parseVersionsFromXml(metadata).map((v, i) => [v, i] as const),
    );
    const latestEntry = allowedVersions.reduce<VersionMetadata | null>(
      (acc, v) => {
        if (!acc) return v;
        if (v.published > acc.published) return v;
        if (v.published < acc.published) return acc;
        return (order.get(v.version) ?? -1) > (order.get(acc.version) ?? -1)
          ? v
          : acc;
      },
      null,
    );
    const allowed = new Set(allowedVersions.map((v) => v.version));
    return (
      filterMavenMetadataXml(
        metadata,
        allowed,
        latestEntry?.version ?? '',
        latestEntry?.published,
      ) ?? ''
    );
  }

  private respondWithMetadata(
    res: Response,
    filteredMetadata: string,
    req: Request,
  ): void {
    if (filteredMetadata === '') {
      res.status(404).json({ error: 'Not found' });
      return;
    }
    const suffix = metadataChecksum(req.path);
    if (suffix) {
      const hash = createHash(suffix).update(filteredMetadata).digest('hex');
      res.status(200).type('text/plain').send(hash);
    } else {
      res.status(200).type('application/xml').send(filteredMetadata);
    }
  }
}

/**
 * Checksums a Maven client may ask for alongside maven-metadata.xml.
 *
 * The metadata served here is filtered, so its checksums have to be recomputed
 * over the filtered document — returning the upstream's checksum would not
 * match what the client just received. Maven 3.9 and Gradle both use sha256 and
 * sha512, so limiting this to sha1/md5 breaks them.
 */
const METADATA_CHECKSUMS = ['sha1', 'md5', 'sha256', 'sha512'] as const;

type MetadataChecksum = (typeof METADATA_CHECKSUMS)[number];

const METADATA_PATH = new RegExp(
  `/maven-metadata\\.xml(\\.(?:${METADATA_CHECKSUMS.join('|')}))?$`,
);

function isMavenMetadataPath(path: string): boolean {
  return METADATA_PATH.test(path);
}

/** The checksum a metadata request asks for, or null for the document itself. */
function metadataChecksum(path: string): MetadataChecksum | null {
  const match = METADATA_PATH.exec(path);
  const suffix = match?.[1];
  return suffix ? (suffix.slice(1) as MetadataChecksum) : null;
}

/**
 * Returns true for version-specific artifact paths:
 * `/{groupId}/{artifactId}/{version}/{file}`.
 *
 * maven-metadata.xml and its checksums live at the same depth but are not
 * artifacts — treating `/org/apache/commons/commons-lang3/maven-metadata.xml.sha512`
 * as a download parsed `commons-lang3` as the version and 404'd the request.
 */
function isMavenDownloadPath(path: string): boolean {
  if (isMavenMetadataPath(path)) return false;
  return path.split('/').filter(Boolean).length >= 4;
}

/**
 * Parse groupId, artifactId, and version from a Maven artifact download path.
 *
 * Example:
 *   /com/example/mylib/1.0.0/mylib-1.0.0.jar
 *   -> groupId: "com.example", artifactId: "mylib", version: "1.0.0"
 */
function parseMavenDownloadPath(path: string): {
  groupId: string;
  artifactId: string;
  version: string;
} | null {
  const parts = path.split('/').filter(Boolean);
  if (parts.length < 4) return null;
  const version = parts[parts.length - 2];
  const artifactId = parts[parts.length - 3];
  const groupId = parts.slice(0, -3).join('.');
  return { groupId, artifactId, version };
}

/**
 * Extract version strings from the `<versions>` block of a maven-metadata.xml,
 * preserving document order (Maven appends, so this is ascending publication
 * order).
 */
function parseVersionsFromXml(xml: string): string[] {
  const block = /<versions>([\s\S]*?)<\/versions>/.exec(xml);
  if (!block) return [];
  return [...block[1]!.matchAll(/<version>([^<]*)<\/version>/g)]
    .map((m) => m[1]!.trim())
    .filter(Boolean);
}

/**
 * Read the build timestamp out of a version-level (snapshot) maven-metadata.xml.
 *
 * The document describes one timestamped build — `<snapshotVersions>` lists it
 * once per extension and classifier — so a single VersionMetadata represents
 * the whole file. `<lastUpdated>` (yyyyMMddHHmmss, UTC) is the build's time;
 * `<snapshot><timestamp>` (yyyyMMdd.HHmmss) is the same instant and is used as
 * a fallback.
 *
 * Returns an empty list when no timestamp can be read, which blocks the
 * metadata rather than serving a build of unknown age.
 */
function snapshotVersions(xml: string, path: string): VersionMetadata[] {
  const { groupId, artifactId } = parseSnapshotPath(path);
  const version = /<version>([^<]+)<\/version>/.exec(xml)?.[1]?.trim() ?? '';
  const published = parseSnapshotTimestamp(xml);
  if (!published) return [];
  return [{ packageName: `${groupId}:${artifactId}`, version, published }];
}

/**
 * Parse the `<lastUpdated>` of an artifact-level maven-metadata.xml.
 *
 * It records when the document was last rewritten, i.e. when its newest version
 * appeared, so it is an upper bound on every listed version's publish time.
 */
function parseMetadataLastUpdated(xml: string): Date | null {
  const raw = /<lastUpdated>(\d{14})<\/lastUpdated>/.exec(xml)?.[1];
  return raw ? parseCompactUtc(raw) : null;
}

/** Parse `<lastUpdated>`, falling back to `<snapshot><timestamp>`. */
function parseSnapshotTimestamp(xml: string): Date | null {
  const lastUpdated = /<lastUpdated>(\d{14})<\/lastUpdated>/.exec(xml)?.[1];
  if (lastUpdated) return parseCompactUtc(lastUpdated);
  const stamp = /<timestamp>(\d{8})\.(\d{6})<\/timestamp>/.exec(xml);
  if (stamp) return parseCompactUtc(`${stamp[1]}${stamp[2]}`);
  return null;
}

/** Parse a `yyyyMMddHHmmss` string as UTC. */
function parseCompactUtc(v: string): Date | null {
  const m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/.exec(v);
  if (!m) return null;
  const d = new Date(
    Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!, +m[4]!, +m[5]!, +m[6]!),
  );
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Parse groupId and artifactId from a version-level metadata path.
 *
 * `/org/apache/maven/maven-core/4.1.0-SNAPSHOT/maven-metadata.xml`
 *   -> groupId "org.apache.maven", artifactId "maven-core"
 *
 * The plain parseMavenPath would read the version as the artifactId here.
 */
function parseSnapshotPath(path: string): {
  groupId: string;
  artifactId: string;
} {
  const parts = path
    .replace(/\/maven-metadata\.xml$/, '')
    .split('/')
    .filter(Boolean);
  const artifactId = parts[parts.length - 2] ?? '';
  const groupId = parts.slice(0, -2).join('.');
  return { groupId, artifactId };
}

/** Strip a checksum suffix to get the path of the metadata document itself. */
function getXmlPath(path: string): string {
  const checksum = metadataChecksum(path);
  return checksum ? path.slice(0, -(checksum.length + 1)) : path;
}

/**
 * Parse groupId and artifactId from a Maven path.
 *
 * Example:
 *   /com/example/mylib/maven-metadata.xml
 *   -> groupId: "com.example", artifactId: "mylib"
 */
function parseMavenPath(path: string): {
  groupId: string;
  artifactId: string;
} {
  const withoutFile = path.replace(/\/maven-metadata\.xml$/, '');
  const parts = withoutFile.split('/').filter(Boolean);
  const artifactId = parts[parts.length - 1] ?? '';
  const groupId = parts.slice(0, -1).join('.');
  return { groupId, artifactId };
}

/**
 * Filter a maven-metadata.xml string to only include allowed versions.
 *
 * Updates <versions>, <release>, <latest>, and <lastUpdated> fields.
 * Returns null when no versions remain after filtering.
 */
function filterMavenMetadataXml(
  xml: string,
  allowedVersions: Set<string>,
  latestVersion: string,
  lastUpdated?: Date,
): string | null {
  let hasAllowedVersions = false;

  // Filter <version> entries inside the <versions> block
  const filtered = xml.replace(
    /(<versions>)([\s\S]*?)(<\/versions>)/,
    (_, open: string, content: string, close: string) => {
      const filteredContent = content.replace(
        /<version>([^<]*)<\/version>/g,
        (match: string, v: string) => {
          if (allowedVersions.has(v.trim())) {
            hasAllowedVersions = true;
            return match;
          }
          return '';
        },
      );
      return `${open}${filteredContent}${close}`;
    },
  );

  if (!hasAllowedVersions) return null;

  // Update <release>, <latest>, and <lastUpdated> to reflect the filtered state
  let result = filtered
    .replace(/<release>[^<]*<\/release>/, `<release>${latestVersion}</release>`)
    .replace(/<latest>[^<]*<\/latest>/, `<latest>${latestVersion}</latest>`);
  if (lastUpdated) {
    result = result.replace(
      /<lastUpdated>[^<]*<\/lastUpdated>/,
      `<lastUpdated>${formatMavenTimestamp(lastUpdated)}</lastUpdated>`,
    );
  }
  return result;
}

/** Format a Date as Maven's `lastUpdated` timestamp: `yyyyMMddHHmmss` in UTC. */
function formatMavenTimestamp(date: Date): string {
  return date.toISOString().replace(/[-:T]/g, '').slice(0, 14);
}

/** A 502 standing in for an upstream that could not be reached. */
function badGateway(message: string): AxiosResponse<string> {
  return {
    status: 502,
    statusText: 'Bad Gateway',
    headers: { 'content-type': 'application/json' },
    data: JSON.stringify({ error: 'Bad Gateway', message }),
    config: {} as AxiosResponse['config'],
  };
}
