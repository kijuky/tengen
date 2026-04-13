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
   * Routes requests:
   *   /versions                          → Compact Index versions list (proxied, not redirected)
   *   /info/{name}                       → Compact Index (filtered text)
   *   /api/v1/versions/{name}.json       → JSON versions API (filtered)
   *   everything else (/gems/*, /quick/) → passthrough
   */
  override async handleRequest(req: Request, res: Response): Promise<void> {
    if (req.path === '/versions') {
      await this.handleVersionsFile(req, res);
      return;
    }
    return super.handleRequest(req, res);
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
