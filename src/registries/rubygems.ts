import axios from 'axios';
import type { Request, Response } from 'express';
import { RegistryProxy, type VersionMetadata } from './base.ts';

interface RubyGemVersion {
  number: string;
  platform?: string;
  created_at: string;
  [key: string]: unknown;
}
type CompactIndexMetadata = string;

/**
 * Build the compact-index version key for a gem JSON entry.
 *   { number: '1.17.4', platform: 'ruby' }        → '1.17.4'
 *   { number: '1.17.4', platform: 'arm64-darwin' } → '1.17.4-arm64-darwin'
 * This key matches both the leading token of compact-index `/info/` lines and
 * the version segment of gem download filenames.
 */
function compactVersionKey(v: RubyGemVersion): string {
  const platform = v.platform ?? 'ruby';
  return platform === 'ruby' ? v.number : `${v.number}-${platform}`;
}

export class RubygemsRegistryProxy extends RegistryProxy {
  readonly name = 'rubygems';

  public setRouting() {
    this.addCustomRoute({
      condition: (req) => req.path === '/versions',
      handle: (req, res) => this.handleVersionsFile(req, res),
    });

    this.addDownloadRoute({
      condition: (req) =>
        req.path.startsWith('/gems/') && req.path.endsWith('.gem'),
      getVersionMetadata: async (req) => {
        const candidates = gemDownloadCandidates(req.path);
        const upstreamBase = new URL(this.config.upstream);
        for (const { gemName, version } of candidates) {
          const response = await axios.get<RubyGemVersion[]>(
            `${upstreamBase.origin}/api/v1/versions/${gemName}.json`,
            { validateStatus: () => true, maxRedirects: 0 },
          );
          if (response.status !== 200) continue;

          const versionData = response.data.find(
            (v) => compactVersionKey(v) === version,
          );
          if (!versionData) continue;

          return {
            packageName: gemName,
            version,
            published: new Date(versionData.created_at),
          };
        }
        return null;
      },
    });

    this.addMetadataRoute<CompactIndexMetadata>({
      condition: (req) => req.path.startsWith('/info/'),
      getVersions: (metadata, req) =>
        this.getCompactIndexVersions(metadata, req),
      filterMetadata: filterCompactIndexMetadata,
      respond: (res, filteredMetadata) => {
        res.status(200).type('text/plain').send(filteredMetadata);
      },
    });
    this.addMetadataRoute<RubyGemVersion[]>({
      condition: (req) =>
        req.path.startsWith('/api/v1/versions/') && req.path.endsWith('.json'),
      getVersions: (metadata, req) => {
        const gemName = req.path
          .slice('/api/v1/versions/'.length)
          .replace(/\.json$/, '');
        return getVersions(metadata, gemName);
      },
      filterMetadata: async (metadata, allowedVersions) => {
        const allowedKeys = new Set(allowedVersions.map((av) => av.version));
        return metadata.filter((v) => allowedKeys.has(compactVersionKey(v)));
      },
    });
  }

  /**
   * Proxy HEAD/GET /versions to upstream without redirecting.
   * Redirecting breaks the compact index protocol because Ruby's Net::HTTP
   * does not automatically follow redirects for HEAD requests, causing clients
   * to incorrectly conclude that compact index is unsupported.
   */
  private async handleVersionsFile(req: Request, res: Response): Promise<void> {
    const upstreamBase = new URL(this.config.upstream);
    const response = await axios({
      method: req.method,
      url: `${upstreamBase.origin}/versions`,
      validateStatus: () => true,
      responseType: 'text',
    });

    res.status(response.status);
    for (const header of ['content-type', 'etag', 'last-modified']) {
      const value = response.headers[header];
      if (value !== undefined) res.setHeader(header, value as string);
    }
    if (req.method === 'HEAD') {
      res.end();
    } else {
      res.send(response.data);
    }
  }
  private async getCompactIndexVersions(
    _metadata: CompactIndexMetadata,
    req: Request,
  ): Promise<VersionMetadata[]> {
    const upstreamBase = new URL(this.config.upstream);
    const gemName = req.path.slice('/info/'.length);

    const response = await axios.get<RubyGemVersion[]>(
      `${upstreamBase.origin}/api/v1/versions/${gemName}.json`,
      { validateStatus: () => true, maxRedirects: 0 },
    );

    if (response.status !== 200) {
      return [];
    }
    return getVersions(response.data, gemName);
  }
}

/**
 * Enumerate possible (gemName, version) splits for a gem download path.
 *   /gems/rack-2.2.4.gem            → [{ rack, 2.2.4 }]
 *   /gems/aws-sdk-s3-1.0.0.gem      → [{ aws-sdk-s3, 1.0.0 }]
 *   /gems/mail-iso-2022-jp-2.1.0.gem → [{ mail-iso-2022-jp, 2.1.0 }, { mail-iso, 2022-jp-2.1.0 }]
 *
 * Versions start with a digit, but gem names may also contain digit-prefixed
 * parts (e.g. "iso-2022-jp"), making the split ambiguous from the URL alone.
 * Candidates are ordered right-to-left so the most plausible split (version
 * closer to the end) is tried first; callers verify each against upstream.
 */
function gemDownloadCandidates(
  path: string,
): Array<{ gemName: string; version: string }> {
  const filename = path.slice('/gems/'.length, -'.gem'.length);
  const parts = filename.split('-');
  const candidates: Array<{ gemName: string; version: string }> = [];
  for (let i = parts.length - 1; i >= 1; i--) {
    if (!/^\d/.test(parts[i])) continue;
    candidates.push({
      gemName: parts.slice(0, i).join('-'),
      version: parts.slice(i).join('-'),
    });
  }
  return candidates;
}

function getVersions(metadata: RubyGemVersion[], gemName: string): VersionMetadata[] {
  return metadata.map((v) => ({
    packageName: gemName,
    version: compactVersionKey(v),
    published: new Date(v.created_at),
  }));
}

function filterCompactIndexMetadata(
  text: CompactIndexMetadata,
  allowedVersions: VersionMetadata[],
) {
  const lines = text.split('\n');
  const separatorIdx = lines.indexOf('---');
  if (separatorIdx === -1) {
    // Unknown format — pass through unchanged
    return text;
  }

  const allowedVersionsSet = new Set(allowedVersions.map((v) => v.version));
  const header = lines.slice(0, separatorIdx + 1);
  const versionLines = lines.slice(separatorIdx + 1);

  const filteredVersionLines = versionLines.filter((line) => {
    const trimmed = line.trim();
    if (!trimmed) return true; // preserve blank lines
    const version = trimmed.split(' ')[0];
    return allowedVersionsSet.has(version);
  });

  return [...header, ...filteredVersionLines].join('\n');
}
