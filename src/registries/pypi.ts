import { RegistryProxy } from './base.ts';

interface PyPiFile {
  upload_time_iso_8601: string;
  [key: string]: unknown;
}

interface PyPiMetadata {
  info: {
    name: string;
    version: string;
    [key: string]: unknown;
  };
  last_serial: number;
  releases: Record<string, PyPiFile[]>;
  urls: PyPiFile[];
  [key: string]: unknown;
}

export class PypiRegistryProxy extends RegistryProxy {
  readonly name = 'pypi';

  /**
   * Metadata paths:
   *   /pypi/{name}/json
   *   /pypi/{name}/{version}/json
   * Everything else (e.g. /packages/...) is a binary artifact.
   */
  isMetadataPath(path: string): boolean {
    return path.endsWith('/json');
  }

  filterMetadata(data: unknown, cutoffDate: Date): unknown | null {
    const pkg = data as PyPiMetadata;

    if (!pkg.releases) {
      return data;
    }

    // Filter releases: keep a version if its earliest upload is before or at cutoff
    const filteredReleases: Record<string, PyPiFile[]> = {};
    for (const [version, files] of Object.entries(pkg.releases)) {
      if (files.length === 0) continue;
      const uploadTime = files.reduce((earliest, file) => {
        const t = new Date(file.upload_time_iso_8601);
        return t < earliest ? t : earliest;
      }, new Date(files[0].upload_time_iso_8601));

      if (uploadTime <= cutoffDate) {
        filteredReleases[version] = files;
      }
    }

    if (Object.keys(filteredReleases).length === 0) {
      return null;
    }

    // Find the latest allowed version by upload time
    let latestVersion = '';
    let latestTime = new Date(0);
    for (const [version, files] of Object.entries(filteredReleases)) {
      if (files.length === 0) continue;
      const t = new Date(files[0].upload_time_iso_8601);
      if (t > latestTime) {
        latestTime = t;
        latestVersion = version;
      }
    }

    return {
      ...pkg,
      info: {
        ...pkg.info,
        version: latestVersion,
      },
      releases: filteredReleases,
      urls: filteredReleases[latestVersion] ?? [],
    };
  }
}
