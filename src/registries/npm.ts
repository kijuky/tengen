import axios from 'axios';
import { RegistryProxy, type VersionMetadata } from './base.ts';

interface NpmVersion {
  dist?: { tarball?: string; [key: string]: unknown };
  [key: string]: unknown;
}

interface NpmPackageMetadata {
  name: string;
  'dist-tags': Record<string, string>;
  versions: Record<string, NpmVersion>;
  /** Keys: version strings + "created" + "modified" */
  time: Record<string, string>;
  [key: string]: unknown;
}

export class NpmRegistryProxy extends RegistryProxy {
  readonly name = 'npm';

  public setRouting() {
    this.addMetadataRoute<NpmPackageMetadata>({
      condition: (req) => !req.path.includes('/-/'),
      getVersions: getVersionMetadata,
      filterMetadata: async (metadata, allowedVersions) => {
        const filtered = await filterMetadata(metadata, allowedVersions);
        // In "proxied" mode the upstream is unreachable, so repoint each version's
        // tarball at this proxy to fetch artifacts through it. The npm CLI
        // rewrites the host itself, but yarn/pnpm and other clients use
        // dist.tarball verbatim and would fail against the un-reachable
        // upstream. Requires --base-url; without it the upstream tarball URL is
        // left intact. In "direct" mode the upstream is reachable, so the URL
        // is left as-is.
        const tarballBaseUrl =
          this.config.upstreamAccess === 'proxied'
            ? (this.config.baseUrl ?? null)
            : null;
        rewriteTarballUrls(filtered, tarballBaseUrl, this.name);
        return filtered;
      },
    });

    this.addDownloadRoute({
      condition: (req) => req.path.includes('/-/') && !req.path.startsWith('/-/'),
      getVersionMetadata: async (req) => {
        const parsed = parseDownloadUrl(req.path);
        if (!parsed) return null;
        const { packageName, version } = parsed;

        const upstream = this.config.upstream.replace(/\/$/, '');
        const response = await axios.get<NpmPackageMetadata>(
          `${upstream}/${packageName}`,
          { validateStatus: () => true, maxRedirects: 0 },
        );
        if (response.status !== 200) return null;

        const publishedStr = response.data.time?.[version];
        if (typeof publishedStr !== 'string') return null;

        return { packageName, version, published: new Date(publishedStr) };
      },
    });
  }
}

/**
 * Parse an npm tarball download path into package name and version.
 *
 * Handles both regular and scoped packages:
 *   /lodash/-/lodash-4.17.21.tgz         → { packageName: 'lodash',      version: '4.17.21' }
 *   /@babel/core/-/core-7.0.0.tgz        → { packageName: '@babel/core', version: '7.0.0' }
 */
function parseDownloadUrl(
  path: string,
): { packageName: string; version: string } | null {
  const separatorIdx = path.indexOf('/-/');
  if (separatorIdx === -1) return null;

  const packageName = path.slice(1, separatorIdx); // strip leading '/'
  const filename = path.slice(separatorIdx + 3); // after '/-/'

  if (!filename.endsWith('.tgz')) return null;

  const baseName = packageName.includes('/')
    ? packageName.slice(packageName.lastIndexOf('/') + 1)
    : packageName;

  const nameWithVersion = filename.slice(0, -4); // remove '.tgz'
  if (!nameWithVersion.startsWith(`${baseName}-`)) return null;

  const version = nameWithVersion.slice(baseName.length + 1);
  if (!version) return null;

  return { packageName, version };
}

function getVersionMetadata(metadata: NpmPackageMetadata): VersionMetadata[] {
  const versions: VersionMetadata[] = [];
  for (const version of Object.keys(metadata.versions)) {
    const publishedStr = metadata.time[version];
    if (typeof publishedStr === 'string') {
      versions.push({
        packageName: metadata.name,
        version,
        published: new Date(publishedStr),
      });
    }
  }
  return versions;
}

async function filterMetadata(
  metadata: NpmPackageMetadata,
  allowedVersions: VersionMetadata[],
) {
  for (const version of Object.keys(metadata.versions)) {
    if (!allowedVersions.some((v) => v.version === version)) {
      delete metadata.versions[version];
    }
  }
  for (const key of Object.keys(metadata.time)) {
    if (
      key !== 'created' &&
      key !== 'modified' &&
      !allowedVersions.some((v) => v.version === key)
    ) {
      delete metadata.time[key];
    }
  }
  metadata['dist-tags'] = filterDistTags(
    metadata['dist-tags'],
    allowedVersions,
  );
  return metadata;
}

/**
 * Rewrite the `dist.tarball` URL of every (already filtered) version to an
 * absolute URL under this proxy, so downloads are served by the proxy instead
 * of the upstream:
 *
 *   https://registry.npmjs.org/lodash/-/lodash-4.17.21.tgz
 *   → {baseUrl}/npm/lodash/-/lodash-4.17.21.tgz
 *
 * The result must be absolute: npm treats a relative `dist.tarball` as a local
 * file path, so a root-absolute path would not work. No-ops when no base URL is
 * given (leaving the upstream URL intact — the caller passes null outside
 * proxied mode), or for any tarball value that isn't a parseable absolute URL.
 */
function rewriteTarballUrls(
  metadata: NpmPackageMetadata,
  baseUrl: string | null,
  registryName: string,
): void {
  if (!baseUrl) return;
  for (const version of Object.values(metadata.versions)) {
    const tarball = version?.dist?.tarball;
    if (typeof tarball !== 'string') continue;
    try {
      const u = new URL(tarball);
      version.dist!.tarball = `${baseUrl}/${registryName}${u.pathname}${u.search}`;
    } catch {
      // Not an absolute URL — leave it untouched.
    }
  }
}

function majorVersion(version: string): string | null {
  const major = version.split('.')[0];
  return major !== undefined && major !== '' ? major : null;
}

/**
 * Whether a version string carries a semver prerelease identifier, e.g.
 * "2.0.0-beta.1", "2.0.0-rc.2", or "19.2.0-canary-3f52beea-20250314".
 * Build metadata (the "+..." suffix) is ignored since it isn't a prerelease marker.
 */
function isPrereleaseVersion(version: string): boolean {
  return version.split('+')[0]!.includes('-');
}

function filterDistTags(
  distTags: Record<string, string>,
  allowedVersions: VersionMetadata[],
): Record<string, string> {
  const sortedByDate = [...allowedVersions].sort(
    (a, b) => b.published.getTime() - a.published.getTime(),
  );
  // Candidates for re-pointing "latest": prefer stable (non-prerelease)
  // versions so a beta/rc/canary release never becomes the resolved latest;
  // fall back to the full (prerelease-inclusive) list only if nothing else
  // is allowed.
  const stableByDate = sortedByDate.filter((v) => !isPrereleaseVersion(v.version));

  const allowedVersionsSet = new Set(allowedVersions.map((v) => v.version));
  const result: Record<string, string> = {};
  for (const [tag, version] of Object.entries(distTags)) {
    if (allowedVersionsSet.has(version)) {
      result[tag] = version;
    } else if (tag === 'latest') {
      const candidates =
        stableByDate.length > 0 ? stableByDate : sortedByDate;
      if (candidates.length === 0) continue;
      // Prefer the newest allowed version within the same major version as the
      // original latest; fall back to the newest overall if none match.
      const originalMajor = majorVersion(version);
      const sameMajor =
        originalMajor !== null
          ? candidates.find((v) => majorVersion(v.version) === originalMajor)
          : undefined;
      result[tag] = (sameMajor ?? candidates[0]).version;
    }
  }
  return result;
}
