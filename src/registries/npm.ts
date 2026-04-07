import { RegistryProxy } from './base.ts';

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

  /**
   * Tarball paths look like:  /lodash/-/lodash-4.17.21.tgz
   *                       or  /@scope/pkg/-/pkg-1.0.0.tgz
   * Everything else is treated as metadata.
   */
  isMetadataPath(path: string): boolean {
    return !path.includes('/-/');
  }

  filterMetadata(data: unknown, cutoffDate: Date): unknown | null {
    const pkg = data as NpmPackageMetadata;

    if (!pkg.versions || !pkg.time) {
      return data;
    }

    // Collect versions that were published before the cutoff
    const allowedVersions = new Set<string>();
    for (const [key, publishedAt] of Object.entries(pkg.time)) {
      if (key === 'created' || key === 'modified') continue;
      if (new Date(publishedAt) <= cutoffDate) {
        allowedVersions.add(key);
      }
    }

    // If all versions are filtered out, treat as if the package doesn't exist
    if (allowedVersions.size === 0) {
      return null;
    }

    // Filter versions object
    const filteredVersions: Record<string, unknown> = {};
    for (const [version, info] of Object.entries(pkg.versions)) {
      if (allowedVersions.has(version)) {
        filteredVersions[version] = info;
      }
    }

    // Filter time object (keep special keys)
    const filteredTime: Record<string, string> = {};
    for (const [key, value] of Object.entries(pkg.time)) {
      if (key === 'created' || key === 'modified' || allowedVersions.has(key)) {
        filteredTime[key] = value;
      }
    }

    // Update dist-tags: if a tag points to a filtered version,
    // fall back to the most recently published allowed version.
    const filteredDistTags = this.filterDistTags(
      pkg['dist-tags'],
      allowedVersions,
      pkg.time,
    );

    return {
      ...pkg,
      versions: filteredVersions,
      time: filteredTime,
      'dist-tags': filteredDistTags,
    };
  }

  private filterDistTags(
    distTags: Record<string, string>,
    allowedVersions: Set<string>,
    time: Record<string, string>,
  ): Record<string, string> {
    // Pre-compute the latest allowed version by publish date, used as fallback
    const latestAllowedVersion = [...allowedVersions].sort((a, b) => {
      const ta = time[a] ? new Date(time[a]).getTime() : 0;
      const tb = time[b] ? new Date(time[b]).getTime() : 0;
      return tb - ta;
    })[0];

    const result: Record<string, string> = {};
    for (const [tag, version] of Object.entries(distTags)) {
      if (allowedVersions.has(version)) {
        result[tag] = version;
      } else if (latestAllowedVersion !== undefined) {
        // Point the tag to the newest version that passed the delay filter
        result[tag] = latestAllowedVersion;
      }
      // If there are no allowed versions at all, drop the tag entirely
    }
    return result;
  }
}
