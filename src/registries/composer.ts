import { RegistryProxy } from "./base.ts";

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
  readonly name = "composer";

  /**
   * Metadata paths:
   *   /packages.json                     (registry root — contains metadata-url)
   *   /packages/{vendor}/{package}.json  (v1 API)
   *   /p2/{vendor}/{package}.json        (v2 API)
   *   /p2/{vendor}/{package}~dev.json    (v2 API, dev versions)
   */
  isMetadataPath(path: string): boolean {
    return (
      path === "/packages.json" ||
      (path.startsWith("/packages/") && path.endsWith(".json")) ||
      (path.startsWith("/p2/") && path.endsWith(".json"))
    );
  }

  filterMetadata(data: unknown, cutoffDate: Date): unknown | null {
    const obj = data as Record<string, unknown>;

    // Registry root (packages.json): rewrite URL fields so Composer resolves
    // them relative to the proxy instead of going directly to the upstream.
    if (typeof obj["metadata-url"] === "string") {
      return this.rewriteRootPackages(obj);
    }

    // v2 API: { packages: { "vendor/pkg": [...versions] } }
    if (
      obj.packages != null &&
      typeof obj.packages === "object" &&
      !Array.isArray(obj.packages)
    ) {
      return this.filterV2(obj as ComposerV2Response, cutoffDate);
    }

    // v1 API: { package: { name, versions: { "1.0.0": {...} } } }
    if (obj.package != null && typeof obj.package === "object") {
      return this.filterV1(obj as ComposerV1Response, cutoffDate);
    }

    return data;
  }

  /**
   * Strip the host from absolute URLs so every metadata path goes through
   * the proxy.  Relative URLs (already path-only) are left unchanged.
   */
  private toRelativePath(url: string): string {
    try {
      const parsed = new URL(url);
      return "/" + this.name + parsed.pathname + parsed.search;
    } catch {
      return "/" + this.name + url; // already relative
    }
  }

  private rewriteRootPackages(data: Record<string, unknown>): unknown {
    const result = { ...data };
    const topLevelUrlFields = [
      "metadata-url",
      "providers-url",
      "metadata-changes-url",
      "notify-batch",
      "search",
      "list",
      "providers-api",
    ];
    for (const key of topLevelUrlFields) {
      if (typeof result[key] === "string") {
        result[key] = this.toRelativePath(result[key] as string);
      }
    }
    // Rewrite nested URL fields
    if (
      result["security-advisories"] != null &&
      typeof result["security-advisories"] === "object"
    ) {
      const sa = result["security-advisories"] as Record<string, unknown>;
      if (typeof sa["api-url"] === "string") {
        result["security-advisories"] = {
          ...sa,
          "api-url": this.toRelativePath(sa["api-url"]),
        };
      }
    }
    return result;
  }

  private filterV1(data: ComposerV1Response, cutoffDate: Date): unknown | null {
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

  /**
   * Expand the minified diff-chain format used by Packagist v2.
   * Each entry only stores fields that changed from the previous entry;
   * expanding merges them so every entry has the full field set.
   */
  private expandMinified(versions: ComposerVersion[]): ComposerVersion[] {
    const result: ComposerVersion[] = [];
    let base: ComposerVersion = {} as ComposerVersion;
    for (const v of versions) {
      base = { ...base, ...v };
      result.push(base);
    }
    return result;
  }

  private filterV2(data: ComposerV2Response, cutoffDate: Date): unknown | null {
    const raw = data as Record<string, unknown>;
    const isMinified = raw["minified"] === "composer/2.0";
    const filteredPackages: Record<string, ComposerVersion[]> = {};

    for (const [pkgName, versions] of Object.entries(data.packages)) {
      const expanded = isMinified ? this.expandMinified(versions) : versions;
      const filtered = expanded.filter(
        (v) => !v.time || new Date(v.time) <= cutoffDate,
      );
      if (filtered.length > 0) {
        filteredPackages[pkgName] = filtered;
      }
    }

    if (Object.keys(filteredPackages).length === 0) return null;

    // Strip 'minified' since the packages are now fully expanded
    const { minified: _minified, ...rest } = raw;
    return { ...rest, packages: filteredPackages };
  }
}
