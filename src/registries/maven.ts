import type { Request, Response } from 'express';
import axios from 'axios';
import { createHash } from 'node:crypto';
import { RegistryProxy, type VersionMetadata } from './base.ts';

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

/** Upper bound on redirect hops when resolving metadata. */
const MAX_METADATA_REDIRECTS = 3;

/** Statuses that carry a `Location` worth following for a GET. */
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

export class MavenRegistryProxy extends RegistryProxy {
  readonly name: string = 'maven';

  /**
   * Routes requests:
   *   /{groupId/as/path}/{artifactId}/maven-metadata.xml         → filtered XML metadata
   *   /{...}/maven-metadata.xml.{sha1,md5,sha256,sha512}         → checksum of filtered XML
   *   /{...}/{version}/maven-metadata.xml                        → filtered snapshot metadata
   *   /{groupId/as/path}/{artifactId}/{version}/{file}          → download check (403 if version blocked)
   *   everything else                                           → passthrough
   */
  public setRouting() {
    this.addMetadataRoute<string>({
      condition: (req) => isMavenMetadataPath(req.path),
      requestUpstream: (req) => this.fetchUpstreamXml(req),
      getVersions: (metadata, req) => this.fetchVersions(metadata, req),
      filterMetadata: (metadata, allowedVersions) =>
        this.filterXml(metadata, allowedVersions),
      respond: (res, filteredMetadata, req) =>
        this.respondWithMetadata(res, filteredMetadata, req),
    });

    this.addDownloadRoute({
      condition: (req) => isMavenDownloadPath(req.path),
      getVersionMetadata: (req) => this.getDownloadVersionMetadata(req),
    });
  }

  private async getDownloadVersionMetadata(
    req: Request,
  ): Promise<VersionMetadata | null> {
    const parsed = parseMavenDownloadPath(req.path);
    if (!parsed) return null;
    const { groupId, artifactId, version } = parsed;
    const packageName = `${groupId}:${artifactId}`;
    const res = await axios.get<DepsDevVersionResponse>(
      `https://api.deps.dev/v3alpha/systems/maven/packages/${packageName}/versions/${encodeURIComponent(version)}`,
      { validateStatus: () => true, maxRedirects: 0 },
    );
    if (res.status !== 200 || !res.data?.publishedAt) return null;
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
  protected async fetchUpstreamXml(req: Request) {
    const base = this.config.upstream.replace(/\/$/, '');
    let url = `${base}${getXmlPath(req.path)}`;
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
          message: `metadata for ${getXmlPath(req.path)} redirected more than ${MAX_METADATA_REDIRECTS} times`,
        }),
      };
    }
    return res;
  }

  private async fetchVersions(
    metadata: string,
    req: Request,
  ): Promise<VersionMetadata[]> {
    // A version-level maven-metadata.xml describes one timestamped SNAPSHOT
    // build and carries its own timestamp, so it needs no external lookup.
    if (metadata.includes('<snapshotVersions>')) {
      return snapshotVersions(metadata, getXmlPath(req.path));
    }

    // Group-level metadata lists plugins/artifacts without <versions> — skip search
    if (!metadata.includes('<versions>')) return [];

    const { groupId, artifactId } = parseMavenPath(getXmlPath(req.path));
    const packageName = `${groupId}:${artifactId}`;
    const res = await axios.get<DepsDevPackageResponse>(
      `https://api.deps.dev/v3alpha/systems/maven/packages/${packageName}`,
      { validateStatus: () => true, maxRedirects: 0 },
    );
    if (res.status !== 200 || !res.data?.versions) return [];
    return res.data.versions.map((v) => ({
      packageName,
      version: v.versionKey.version,
      published: new Date(v.publishedAt),
    }));
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
    const latestEntry = allowedVersions.reduce<VersionMetadata | null>(
      (acc, v) => (!acc || v.published > acc.published ? v : acc),
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
