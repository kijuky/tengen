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
  }
}

function getVersionMetadata(metadata: NpmPackageMetadata): VersionMetadata[] {
  const versions: VersionMetadata[] = [];
  for (const version of Object.keys(metadata.versions)) {
    const publishedStr = metadata.time[version];
    if (typeof publishedStr === 'string') {
      versions.push({ version, published: new Date(publishedStr) });
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

function filterDistTags(
  distTags: Record<string, string>,
  allowedVersions: VersionMetadata[],
): Record<string, string> {
  // Pre-compute the latest allowed version by publish date, used as fallback
  const latestAllowedVersion = allowedVersions.sort((a, b) => {
    return b.published.getTime() - a.published.getTime();
  })[0];

  const allowedVersionsSet = new Set(allowedVersions.map((v) => v.version));
  const result: Record<string, string> = {};
  for (const [tag, version] of Object.entries(distTags)) {
    if (allowedVersionsSet.has(version)) {
      result[tag] = version;
    } else if (tag == 'latest' && latestAllowedVersion !== undefined) {
      // Point the tag to the newest version that passed the delay filter
      result[tag] = latestAllowedVersion.version;
    } else {
      delete distTags[tag];
    }
  }
  return result;
}
