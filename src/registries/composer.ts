import type { Request, Response } from "express";
import { RegistryProxy } from "./base.ts";

interface ComposerVersion {
  version: string;
  time?: string;
  [key: string]: unknown;
}

interface ComposerPackagesResponse {
  packages: Record<string, ComposerVersion[]>;
  [key: string]: unknown;
}

export class ComposerRegistryProxy extends RegistryProxy {
  readonly name = "composer";

  /**
   * Routes requests:
   *   /packages.json                     → registry root (URL rewrite)
   *   /p2/{vendor}/{package}.json        → metadata (filtered)
   *   /p2/{vendor}/{package}~dev.json    → metadata (filtered)
   *   everything else                    → passthrough
   */
  override async handleRequest(req: Request, res: Response): Promise<void> {
    const isMetadata =
      req.path === "/packages.json" ||
      (req.path.startsWith("/p2/") && req.path.endsWith(".json"));

    if (isMetadata) {
      await this.handleMetadataRequest(req, res);
    } else {
      await this.handlePassthrough(req, res);
    }
  }

  private async handleMetadataRequest(
    req: Request,
    res: Response,
  ): Promise<void> {
    const cutoffDate = new Date(Date.now() - this.config.delayMs);
    await this.handleFilteredJson(res, this.buildUpstreamUrl(req), (data) =>
      this.filterMetadata(data, cutoffDate),
    );
  }

  private filterMetadata(data: unknown, cutoffDate: Date): unknown | null {
    const obj = data as Record<string, unknown>;

    // Registry root (packages.json): rewrite URL fields so Composer resolves
    // them relative to the proxy instead of going directly to the upstream.
    if (typeof obj["metadata-url"] === "string") {
      return this.rewriteRootPackages(obj);
    }

    // packages API: { packages: { "vendor/pkg": [...versions] } }
    if (
      obj.packages != null &&
      typeof obj.packages === "object" &&
      !Array.isArray(obj.packages)
    ) {
      return filterComposerPackages(obj as ComposerPackagesResponse, cutoffDate);
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
}

/**
 * Propagate `time` through Packagist's minified diff-chain format.
 * Each entry only stores fields that changed from the previous entry, so
 * entries without `time` inherit the last seen value.
 */
function propagateTime(versions: ComposerVersion[]): ComposerVersion[] {
  let lastTime: string | undefined;
  return versions.map((v) => {
    if (v.time !== undefined) lastTime = v.time;
    return lastTime !== undefined && v.time === undefined
      ? { ...v, time: lastTime }
      : v;
  });
}

function filterComposerPackages(
  data: ComposerPackagesResponse,
  cutoffDate: Date,
): unknown | null {
  const raw = data as Record<string, unknown>;
  const filteredPackages: Record<string, ComposerVersion[]> = {};

  for (const [pkgName, versions] of Object.entries(data.packages)) {
    const expanded = propagateTime(versions);
    const filtered = expanded.filter(
      (v) => v.time && new Date(v.time) <= cutoffDate,
    );
    if (filtered.length > 0) {
      filteredPackages[pkgName] = filtered;
    }
  }

  if (Object.keys(filteredPackages).length === 0) return null;

  return { ...raw, packages: filteredPackages };
}
