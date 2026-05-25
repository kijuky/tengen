import axios from 'axios';
import { RegistryProxy, type VersionMetadata } from './base.ts';

interface NpmPackageMetadata {
  name: string;
  'dist-tags': Record<string, string>;
  versions: Record<string, unknown>;
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
      filterMetadata,
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

function majorVersion(version: string): string | null {
  const major = version.split('.')[0];
  return major !== undefined && major !== '' ? major : null;
}

function filterDistTags(
  distTags: Record<string, string>,
  allowedVersions: VersionMetadata[],
): Record<string, string> {
  const sortedByDate = [...allowedVersions].sort(
    (a, b) => b.published.getTime() - a.published.getTime(),
  );

  const allowedVersionsSet = new Set(allowedVersions.map((v) => v.version));
  const result: Record<string, string> = {};
  for (const [tag, version] of Object.entries(distTags)) {
    if (allowedVersionsSet.has(version)) {
      result[tag] = version;
    } else if (tag === 'latest' && sortedByDate.length > 0) {
      // Prefer the newest allowed version within the same major version as the
      // original latest; fall back to the newest overall if none match.
      const originalMajor = majorVersion(version);
      const sameMajor =
        originalMajor !== null
          ? sortedByDate.find((v) => majorVersion(v.version) === originalMajor)
          : undefined;
      result[tag] = (sameMajor ?? sortedByDate[0]).version;
    }
  }
  return result;
}
