import type { Request, Response } from 'express';
import { RegistryProxy, type VersionMetadata } from './base.ts';
import axios from 'axios';

interface ComposerVersion {
  version: string;
  time?: string;
  [key: string]: unknown;
}

interface ComposerPackagesResponse {
  packages: Record<string, ComposerVersion[]>;
  [key: string]: unknown;
}

interface ComposerRootResponse {
  'metadata-url': string;
  'providers-url': string;
  'metadata-changes-url': string;
  'notify-batch': string;
  search: string;
  list: string;
  'providers-api': string;
  'security-advisories'?: {
    'api-url': string;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export class ComposerRegistryProxy extends RegistryProxy {
  readonly name = 'composer';

  public setRouting() {
    this.addCustomRoute({
      condition: (req) => req.path === '/packages.json',
      handle: (req, res) => this.handleRootMetadataRequest(req, res),
    });

    this.addMetadataRoute<ComposerPackagesResponse>({
      condition: (req) =>
        req.path.startsWith('/p2/') && req.path.endsWith('.json'),
      getVersions: (metadata) => {
        const versions: VersionMetadata[] = [];
        for (const [pkgName, pkgVersions] of Object.entries(metadata.packages)) {
          const expandedVersions = expandVersions(pkgVersions);
          for (const v of expandedVersions) {
            if (v.time) {
              versions.push({
                packageName: pkgName,
                version: v.version,
                published: new Date(v.time),
              });
            }
          }
        }
        return versions;
      },
      filterMetadata: filterComposerPackages,
    });
  }

  private async handleRootMetadataRequest(
    req: Request,
    res: Response,
  ): Promise<void> {
    const response = await axios.get<ComposerRootResponse>(
      this.buildUpstreamUrl(req),
      {
        validateStatus: () => true,
      },
    );
    const root = response.data;
    const rewrited = rewriteRootPackages(root, this.name);
    res.status(response.status).json(rewrited);
  }
}

/**
 * Strip the host from absolute URLs so every metadata path goes through
 * the proxy.  Relative URLs (already path-only) are left unchanged.
 */
function toRelativePath(url: string, name: string): string {
  try {
    const parsed = new URL(url);
    return '/' + name + parsed.pathname + parsed.search;
  } catch {
    return '/' + name + url; // already relative
  }
}

function rewriteRootPackages(
  data: Record<string, unknown>,
  name: string,
): unknown {
  const result = { ...data };
  const topLevelUrlFields = [
    'metadata-url',
    'providers-url',
    'metadata-changes-url',
    'notify-batch',
    'search',
    'list',
    'providers-api',
  ];
  for (const key of topLevelUrlFields) {
    if (typeof result[key] === 'string') {
      result[key] = toRelativePath(result[key] as string, name);
    }
  }
  // Rewrite nested URL fields
  if (
    result['security-advisories'] != null &&
    typeof result['security-advisories'] === 'object'
  ) {
    const sa = result['security-advisories'] as Record<string, unknown>;
    if (typeof sa['api-url'] === 'string') {
      result['security-advisories'] = {
        ...sa,
        'api-url': toRelativePath(sa['api-url'], name),
      };
    }
  }
  return result;
}

/**
 * Expand Packagist's minified diff-chain format.
 * Each entry only stores fields that changed from the previous entry, so
 * missing fields are inherited from the accumulated state of prior entries.
 */
function expandVersions(versions: ComposerVersion[]): ComposerVersion[] {
  let accumulated: ComposerVersion = { version: '' };
  return versions.map((v) => {
    accumulated = { ...accumulated, ...v };
    return { ...accumulated };
  });
}

/**
 * Re-minify expanded versions back to diff-chain format by stripping fields
 * that are identical to the previous entry.  The first entry is kept as-is.
 */
function minifyVersions(versions: ComposerVersion[]): ComposerVersion[] {
  let prev: ComposerVersion | undefined;
  return versions.map((v) => {
    if (prev === undefined) {
      prev = v;
      return { ...v };
    }
    const diff: ComposerVersion = { version: v.version };
    for (const key of Object.keys(v) as (keyof ComposerVersion)[]) {
      if (
        key !== 'version' &&
        JSON.stringify(v[key]) !== JSON.stringify(prev[key])
      ) {
        diff[key] = v[key];
      }
    }
    prev = v;
    return diff;
  });
}

function filterComposerPackages(
  metadata: ComposerPackagesResponse,
  allowedVersions: VersionMetadata[],
) {
  const filteredPackages: Record<string, ComposerVersion[]> = {};
  const allowedVersionsSet = new Set(allowedVersions.map((v) => v.version));

  for (const [pkgName, versions] of Object.entries(metadata.packages)) {
    const expanded = expandVersions(versions);
    const filtered = expanded.filter((v: ComposerVersion) =>
      allowedVersionsSet.has(v.version),
    );
    filteredPackages[pkgName] = minifyVersions(filtered);
  }

  return { ...metadata, packages: filteredPackages };
}
