import { RegistryProxy } from './base.ts';

interface ComposerVersion {
  version: string;
  time?: string;
  [key: string]: unknown;
}

interface ComposerV1Package {
  name: string;
  versions: Record<string, ComposerVersion>;
  [key: string]: unknown;
}

interface ComposerV1Response {
  package: ComposerV1Package;
  [key: string]: unknown;
}

interface ComposerV2Response {
  packages: Record<string, ComposerVersion[]>;
  [key: string]: unknown;
}

export class ComposerRegistryProxy extends RegistryProxy {
  readonly name = 'composer';

  /**
   * Metadata paths:
   *   /packages/{vendor}/{package}.json  (v1 API)
   *   /p2/{vendor}/{package}.json        (v2 API)
   *   /p2/{vendor}/{package}~dev.json    (v2 API, dev versions)
   */
  isMetadataPath(path: string): boolean {
    return (
      (path.startsWith('/packages/') && path.endsWith('.json')) ||
      (path.startsWith('/p2/') && path.endsWith('.json'))
    );
  }

  filterMetadata(data: unknown, cutoffDate: Date): unknown | null {
    const obj = data as Record<string, unknown>;

    // v2 API: { packages: { "vendor/pkg": [...versions] } }
    if (
      obj.packages != null &&
      typeof obj.packages === 'object' &&
      !Array.isArray(obj.packages)
    ) {
      return this.filterV2(obj as ComposerV2Response, cutoffDate);
    }

    // v1 API: { package: { name, versions: { "1.0.0": {...} } } }
    if (obj.package != null && typeof obj.package === 'object') {
      return this.filterV1(obj as ComposerV1Response, cutoffDate);
    }

    return data;
  }

  private filterV1(
    data: ComposerV1Response,
    cutoffDate: Date,
  ): unknown | null {
    const { versions, ...restPkg } = data.package;
    const filteredVersions: Record<string, ComposerVersion> = {};

    for (const [versionKey, version] of Object.entries(versions)) {
      if (!version.time || new Date(version.time) <= cutoffDate) {
        filteredVersions[versionKey] = version;
      }
    }

    if (Object.keys(filteredVersions).length === 0) return null;

    return { ...data, package: { ...restPkg, versions: filteredVersions } };
  }

  private filterV2(
    data: ComposerV2Response,
    cutoffDate: Date,
  ): unknown | null {
    const filteredPackages: Record<string, ComposerVersion[]> = {};

    for (const [pkgName, versions] of Object.entries(data.packages)) {
      const filtered = versions.filter(
        (v) => !v.time || new Date(v.time) <= cutoffDate,
      );
      if (filtered.length > 0) {
        filteredPackages[pkgName] = filtered;
      }
    }

    if (Object.keys(filteredPackages).length === 0) return null;

    return { ...data, packages: filteredPackages };
  }
}
