import axios from 'axios';
import type { Request, Response } from 'express';
import { RegistryProxy, type VersionMetadata } from './base.ts';

interface RubyGemVersion {
  number: string;
  created_at: string;
  [key: string]: unknown;
}
type CompactIndexMetadata = string;

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
        const parsed = parseGemDownloadUrl(req.path);
        if (!parsed) return null;
        const { gemName, version } = parsed;

        const upstreamBase = new URL(this.config.upstream);
        const response = await axios.get<RubyGemVersion[]>(
          `${upstreamBase.origin}/api/v1/versions/${gemName}.json`,
          { validateStatus: () => true, maxRedirects: 0 },
        );
        if (response.status !== 200) return null;

        const versionData = response.data.find((v) => v.number === version);
        if (!versionData) return null;

        return {
          packageName: gemName,
          version,
          published: new Date(versionData.created_at),
        };
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
        return metadata.filter((v) =>
          allowedVersions.some((av) => av.version === v.number),
        );
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
 * Parse a RubyGems gem download path into gem name and version.
 *   /gems/rack-2.2.4.gem       → { gemName: 'rack',       version: '2.2.4' }
 *   /gems/aws-sdk-s3-1.0.0.gem → { gemName: 'aws-sdk-s3', version: '1.0.0' }
 */
function parseGemDownloadUrl(
  path: string,
): { gemName: string; version: string } | null {
  const filename = path.slice('/gems/'.length, -'.gem'.length);
  const parts = filename.split('-');
  // Gem names never start with a digit; versions always do.
  const versionStartIdx = parts.findIndex((p) => /^\d/.test(p));
  if (versionStartIdx <= 0) return null;
  return {
    gemName: parts.slice(0, versionStartIdx).join('-'),
    version: parts.slice(versionStartIdx).join('-'),
  };
}

function getVersions(metadata: RubyGemVersion[], gemName: string): VersionMetadata[] {
  return metadata.map((v) => ({
    packageName: gemName,
    version: v.number,
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
