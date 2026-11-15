import type { Request, Response } from 'express';
import axios from 'axios';
import escapeHtml from 'escape-html';
import {
  RegistryProxy,
  type RegistryConfig,
  type VersionMetadata,
} from './base.ts';
import { listFolders, type ArtifactoryEndpoint } from './artifactory.ts';
import { TtlCache } from './ttl-cache.ts';

/** Upper bound on redirect hops when probing a revision's ivy.xml. */
const MAX_REDIRECTS = 3;

/**
 * Dating a revision costs one request, and filtering a listing means dating
 * every revision in it — a module can have hundreds — so the requests are
 * bounded and their results held briefly. The same cache serves the download
 * gate, which asks the same question about one revision.
 */
const PROBE_CONCURRENCY = 8;
const CACHE_TTL_MS = 10 * 60 * 1000;
const CACHE_MAX_ENTRIES = 10_000;
/** What a HEAD of a revision's ivy.xml said. */
interface IvyXmlHead {
  /** Whether the upstream has the revision (its ivy.xml answered 200). */
  found: boolean;
  /** The ivy.xml's `Last-Modified`, when found and readable. */
  published: Date | null;
}
const probeCache = new TtlCache<IvyXmlHead>(CACHE_TTL_MS, CACHE_MAX_ENTRIES);
const listingCache = new TtlCache<string[]>(CACHE_TTL_MS, CACHE_MAX_ENTRIES);

/** How many children are inspected to tell a revision directory from any other. */
const SHAPE_SAMPLE = 3;

/** @internal Reset module-level caches. Used by tests; not part of the public API. */
export function __resetIvyCachesForTesting() {
  probeCache.clear();
  listingCache.clear();
}

/** One upstream of an Ivy-layout registry. */
export interface IvyUpstream {
  url: string;
  /**
   * Structured source for a module's revision listing, resolved at startup
   * when the upstream is given `#index=artifactory`. Unset means its dynamic
   * revisions are not filtered — see IvyRegistryProxy.
   */
  endpoint?: ArtifactoryEndpoint;
}

export interface IvyRegistryConfig extends RegistryConfig {
  /**
   * The upstreams, searched in order. More than one makes a group: revision
   * listings are merged across them and each file is served by the first
   * upstream that holds its revision. Unset means `upstream` with `endpoint`.
   */
  upstreams?: IvyUpstream[];
  /** The listing source of `upstream`, when `upstreams` is unset. */
  endpoint?: ArtifactoryEndpoint;
}

/**
 * Proxy for an Ivy-layout repository.
 *
 * Ivy lays artifacts out as
 * `{org}/{module}(/scala_{v})(/sbt_{v})/{revision}/{type}s/{artifact}(-{classifier}).{ext}`
 * — for example
 * `/ch.epfl.scala/sbt-bloop/scala_2.12/sbt_1.0/1.5.6/ivys/ivy.xml`.
 *
 * Every request for a file under a revision is gated on that revision's age,
 * read from the `Last-Modified` of its `ivys/ivy.xml`. Everything else is passed
 * through.
 *
 * **Dynamic revisions need `index`.** Ivy has no document listing a module's
 * revisions; a client discovers them by reading the repository's directory
 * index. Without a way to produce that list, a proxy can only refuse the
 * artifact once the client has chosen it — and the resolver does not then try
 * the next revision. Measured with Coursier 2.1.25 against sbt-plugin-releases:
 * it reads the listing, picks one revision, requests that revision's ivy.xml,
 * and stops at the 404. Nothing inside the cooldown window is served, but a
 * build on `latest.integration` breaks rather than settling for an older
 * revision.
 *
 * Configuring `index=artifactory` lets the proxy answer that listing itself,
 * filtered, so the resolver only ever sees revisions it is allowed to take. The
 * revision names come from Artifactory's storage API as JSON (see
 * ./artifactory.ts) and each one is dated exactly as the download gate dates it,
 * so the two can never disagree. The response is generated from that list:
 * nothing here reads the upstream's HTML, and the only HTML involved is the
 * document this proxy writes, because that is the shape a resolver expects.
 *
 * Which revision the resolver then picks is its own version ordering, not the
 * listing's order: in that run Coursier asked for `1.3.4+151-7c324c7c` while the
 * listing ended at `1.3.4+160-681434ff`.
 *
 * Malicious/allowlist lookups use the shared "maven" ecosystem, since OSV tracks
 * JVM artifacts there regardless of repository layout.
 */
export class IvyRegistryProxy extends RegistryProxy {
  readonly name: string;

  constructor(config: IvyRegistryConfig) {
    super(config);
    this.name = config.name ?? 'ivy';
  }

  /**
   * Read off `config` rather than held in a field: the base constructor calls
   * `setRouting()`, which runs before a subclass's own initialisers, so a field
   * would still be undefined when the routes are registered.
   */
  private get upstreams(): IvyUpstream[] {
    const config = this.config as IvyRegistryConfig;
    if (config.upstreams && config.upstreams.length > 0) return config.upstreams;
    return [
      { url: config.upstream.replace(/\/$/, ''), endpoint: config.endpoint },
    ];
  }

  protected override get dbKey(): string {
    return 'maven';
  }

  /** A `-SNAPSHOT` revision can be republished with new contents. */
  protected override isCacheable(version: VersionMetadata): boolean {
    return !version.version.endsWith('-SNAPSHOT');
  }

  protected setRouting() {
    this.addDownloadRoute({
      condition: (req) => isIvyDownloadPath(req.path),
      getVersionMetadata: (req) => this.getDownloadVersionMetadata(req),
    });

    this.addCustomRoute({
      condition: (req) =>
        this.upstreams.some((u) => u.endpoint !== undefined) &&
        isRevisionListingPath(req.path),
      handle: (req, res) => this.respondRevisionListing(req, res),
    });
  }

  /**
   * Answer a module's revision listing with only the revisions past the
   * cooldown.
   *
   * A path's shape cannot tell a directory of revisions from any other
   * directory: `/ch.epfl.scala/sbt-bloop/` holds `scala_2.12`, and `…/1.5.6/`
   * holds `ivys` and `jars`. Filtering either as if its children were revisions
   * would hide them all, so the children decide. A child that dates is a
   * revision; if none date, the storage API is asked whether any child holds an
   * artifact-type directory — which says the children *are* revisions whose
   * `ivy.xml` cannot be read, and that is refused rather than passed through.
   */
  private async respondRevisionListing(
    req: Request,
    res: Response,
  ): Promise<void> {
    const modulePath = req.path.replace(/\/+$/, '');
    const indexed = this.upstreams.filter(
      (u): u is IvyUpstream & { endpoint: ArtifactoryEndpoint } =>
        u.endpoint !== undefined,
    );
    const listings = await Promise.all(
      indexed.map((u) => this.listRevisions(u, modulePath)),
    );

    // In a group an upstream that cannot list the module contributes nothing:
    // the storage API answers a module it does not hold the same way as a
    // failure, and offering fewer revisions never lets a new one through. With
    // nothing listed anywhere, though, there is no listing to serve.
    if (listings.every((l) => l === 'unlisted')) {
      this.refuseListing(res, modulePath, 'could not be listed');
      return;
    }
    if (listings.includes('undatable')) {
      this.refuseListing(
        res,
        modulePath,
        'holds revisions whose ivy.xml could not be read, so none of them ' +
          'can be shown to be past the cooldown',
      );
      return;
    }

    const offered: string[] = [];
    const seen = new Set<string>();
    let anyRevisions = false;
    for (const listing of listings) {
      if (typeof listing === 'string') continue;
      anyRevisions = true;
      for (const revision of listing) {
        if (seen.has(revision)) continue;
        seen.add(revision);
        offered.push(revision);
      }
    }
    if (!anyRevisions) {
      // Not a revision directory — it has no revisions to filter, so it is none
      // of this route's business.
      await this.handlePassthrough(req, res);
      return;
    }
    res.status(200).type('text/html').send(renderListing(offered));
  }

  /**
   * One upstream's revisions of a module that are past the cooldown, in its
   * listing order.
   *
   * A path's shape cannot tell a directory of revisions from any other
   * directory: `/ch.epfl.scala/sbt-bloop/` holds `scala_2.12`, and `…/1.5.6/`
   * holds `ivys` and `jars`. Filtering either as if its children were revisions
   * would hide them all, so the children decide. A child that dates is a
   * revision; if none date, the storage API is asked whether any child holds an
   * artifact-type directory — which says the children *are* revisions whose
   * `ivy.xml` cannot be read (`undatable`), rather than no revisions at all
   * (`not-revisions`).
   */
  private async listRevisions(
    upstream: IvyUpstream & { endpoint: ArtifactoryEndpoint },
    modulePath: string,
  ): Promise<string[] | 'unlisted' | 'undatable' | 'not-revisions'> {
    const children = await this.listChildren(upstream, modulePath);
    if (children === null) return 'unlisted';
    const dated = await this.dateRevisions(upstream, modulePath, children);
    if (dated.length === 0) {
      return (await this.holdsRevisions(upstream, modulePath, children))
        ? 'undatable'
        : 'not-revisions';
    }
    const allowed = new Set(this.filterVersions(dated).map((v) => v.version));
    return children.filter((c) => allowed.has(c));
  }

  private refuseListing(res: Response, path: string, why: string): void {
    res.status(502).json({
      error: 'Bad Gateway',
      message: `${path} ${why} via the Artifactory storage API`,
    });
  }

  /**
   * True when a directory's children are revisions rather than, say,
   * cross-version qualifiers: a revision contains Ivy's artifact-type
   * directories (`ivys`, `jars`, …), and nothing else in the layout does.
   *
   * Only the first few children are checked — one answer settles it, and this
   * runs only when no child could be dated.
   */
  private async holdsRevisions(
    upstream: IvyUpstream & { endpoint: ArtifactoryEndpoint },
    modulePath: string,
    children: string[],
  ): Promise<boolean> {
    for (const child of children.slice(0, SHAPE_SAMPLE)) {
      const grandchildren = await this.listChildren(
        upstream,
        `${modulePath}/${child}`,
      );
      if (grandchildren?.some(isArtifactTypeDirectory)) return true;
    }
    return false;
  }

  /** The child folders of a path, cached for CACHE_TTL_MS. */
  private async listChildren(
    upstream: IvyUpstream & { endpoint: ArtifactoryEndpoint },
    path: string,
  ): Promise<string[] | null> {
    const key = `${upstream.url}${path}`;
    const cached = listingCache.get(key);
    if (cached !== undefined) return cached;
    const children = await listFolders(upstream.endpoint, path);
    if (children === null) return null;
    listingCache.set(key, children);
    return children;
  }

  /**
   * Date every candidate revision the way a download of it would be dated.
   *
   * A candidate whose timestamp cannot be read is left out: either it is not a
   * revision at all, or its age is unknown, and neither may be offered.
   */
  private async dateRevisions(
    upstream: IvyUpstream,
    modulePath: string,
    candidates: string[],
  ): Promise<VersionMetadata[]> {
    const dated: VersionMetadata[] = [];
    let next = 0;
    const workers = Math.min(PROBE_CONCURRENCY, candidates.length);
    await Promise.all(
      Array.from({ length: workers }, async () => {
        while (next < candidates.length) {
          const revision = candidates[next++]!;
          const published = await this.revisionPublished(
            upstream,
            modulePath,
            revision,
          );
          if (!published) continue;
          dated.push({
            packageName: packageNameFromPath(modulePath),
            version: revision,
            published,
          });
        }
      }),
    );
    return dated;
  }

  /**
   * Date a download from the first upstream holding its revision, which is
   * the one it is then served from.
   */
  private async getDownloadVersionMetadata(
    req: Request,
  ): Promise<VersionMetadata | null> {
    const parsed = parseIvyDownloadPath(req.path);
    if (!parsed) return null;
    const { modulePath, revision } = parsed;
    const upstreams = this.upstreams;
    for (const upstream of upstreams) {
      const { found, published } = await this.headIvyXml(
        upstream,
        modulePath,
        revision,
      );
      if (!found) continue;
      // This upstream holds the revision and serves it, so an unreadable date
      // blocks it here rather than passing it to another upstream's copy.
      if (!published) return null;
      return {
        packageName: packageNameFromPath(modulePath),
        version: revision,
        published,
        // A single upstream is the registry's own, reached the usual way.
        ...(upstreams.length > 1 && { upstreamUrl: `${upstream.url}${req.path}` }),
      };
    }
    return null;
  }

  /**
   * When a revision was published, from the `Last-Modified` of its
   * `ivys/ivy.xml`. The one date both the download gate and the listing use, so
   * a revision the listing offers is a revision the gate will pass.
   */
  private async revisionPublished(
    upstream: IvyUpstream,
    modulePath: string,
    revision: string,
  ): Promise<Date | null> {
    return (await this.headIvyXml(upstream, modulePath, revision)).published;
  }

  /** HEAD a revision's `ivys/ivy.xml`, cached for CACHE_TTL_MS. */
  private async headIvyXml(
    upstream: IvyUpstream,
    modulePath: string,
    revision: string,
  ): Promise<IvyXmlHead> {
    const url = `${upstream.url}${modulePath}/${revision}/ivys/ivy.xml`;
    const cached = probeCache.get(url);
    if (cached !== undefined) return cached;
    // Follow redirects: repo.scala-sbt.org and repo.typesafe.com both 302 to
    // the Artifactory instance that actually holds the file.
    const res = await axios.head(url, {
      validateStatus: () => true,
      maxRedirects: MAX_REDIRECTS,
    });
    const head: IvyXmlHead = { found: res.status === 200, published: null };
    const lastModified = res.headers['last-modified'];
    if (head.found && typeof lastModified === 'string') {
      const published = new Date(lastModified);
      if (!Number.isNaN(published.getTime())) head.published = published;
    }
    probeCache.set(url, head);
    return head;
  }
}

/**
 * True for a path that *may* be a directory of revisions: a trailing-slash path
 * that is not itself an artifact-type directory.
 *
 * Only the handler can decide whether it really is one, by looking at the
 * children — see respondRevisionListing.
 */
function isRevisionListingPath(path: string): boolean {
  if (!path.endsWith('/') || path === '/') return false;
  const parts = path.split('/').filter(Boolean);
  if (parts.length < 2) return false;
  return !isArtifactTypeDirectory(parts[parts.length - 1]!);
}

/**
 * Render a directory index listing the given entries.
 *
 * A resolver only reads the hrefs, so this is deliberately minimal: a generated
 * document, not a rewrite of the upstream's.
 *
 * Revision names go in as they came out of the upstream, escaped for HTML and
 * nothing more. Percent-encoding them looks more correct and is not: Artifactory
 * writes `href="1.0.0-RC1+4-c5e24b66/"` literally, and Coursier 2.1.25 reads the
 * href as written — given `%2B` it finds no revisions at all.
 */
function renderListing(entries: string[]): string {
  const links = entries
    .map((e) => `<a href="${escapeHtml(e)}/">${escapeHtml(e)}/</a>`)
    .join('\n');
  return `<html>\n<body>\n<pre>\n<a href="../">../</a>\n${links}\n</pre>\n</body>\n</html>\n`;
}

/**
 * True for `{...}/{revision}/{type}s/{file}` — the shape of every Ivy artifact
 * fetch. The `{type}s` segment is Ivy's artifact-type directory (`ivys`, `jars`,
 * `poms`, `srcs`, `docs`, …).
 */
function isIvyDownloadPath(path: string): boolean {
  const parts = path.split('/').filter(Boolean);
  if (parts.length < 4) return false;
  return isArtifactTypeDirectory(parts[parts.length - 2]!);
}

/** Ivy's artifact-type directory, one level below a revision: `ivys`, `jars`, … */
function isArtifactTypeDirectory(segment: string): boolean {
  return /^[a-z]+s$/.test(segment);
}

/**
 * Split an Ivy artifact path into the module directory and the revision.
 *
 * `/ch.epfl.scala/sbt-bloop/scala_2.12/sbt_1.0/1.5.6/ivys/ivy.xml`
 *   -> modulePath: "/ch.epfl.scala/sbt-bloop/scala_2.12/sbt_1.0", revision: "1.5.6"
 */
function parseIvyDownloadPath(
  path: string,
): { modulePath: string; revision: string } | null {
  const parts = path.split('/').filter(Boolean);
  if (parts.length < 4) return null;
  const revision = parts[parts.length - 3]!;
  const modulePath = `/${parts.slice(0, -3).join('/')}`;
  return { modulePath, revision };
}

/**
 * Build the malicious/allowlist lookup key from a module path.
 *
 * Ivy's first two segments are the organisation and the module; the optional
 * `scala_*` / `sbt_*` segments are cross-version qualifiers, not part of the
 * coordinate OSV records.
 */
function packageNameFromPath(path: string): string {
  const parts = path.split('/').filter(Boolean);
  const org = parts[0] ?? '';
  const module = parts[1] ?? '';
  return `${org}:${module}`;
}
