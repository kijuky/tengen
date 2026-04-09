import type { Request, Response } from 'express';
import axios from 'axios';
import { RegistryProxy } from './base.ts';

interface RubyGemVersion {
  number: string;
  created_at: string;
  [key: string]: unknown;
}

export class RubygemsRegistryProxy extends RegistryProxy {
  readonly name = 'rubygems';

  filterMetadata(data: unknown, cutoffDate: Date): unknown | null {
    if (!Array.isArray(data)) {
      return data;
    }

    const versions = data as RubyGemVersion[];
    const filtered = versions.filter(
      (v) => new Date(v.created_at) <= cutoffDate,
    );

    return filtered.length === 0 ? null : filtered;
  }

  /**
   * Routes requests:
   *   /info/{name}                       → Compact Index (filtered text)
   *   /api/v1/versions/{name}.json       → JSON versions API (filtered)
   *   everything else (/gems/*, /quick/) → passthrough
   */
  override async handleRequest(req: Request, res: Response): Promise<void> {
    if (req.path.startsWith('/info/')) {
      await this.handleCompactInfoRequest(req.path, res);
      return;
    }
    if (req.path.startsWith('/api/v1/versions/') && req.path.endsWith('.json')) {
      await this.handleVersionsJsonRequest(req, res);
      return;
    }
    await this.handlePassthrough(req, res);
  }

  private async handleVersionsJsonRequest(req: Request, res: Response): Promise<void> {
    const cutoffDate = new Date(Date.now() - this.config.delayMs);
    await this.handleFilteredJson(
      res,
      this.buildUpstreamUrl(req),
      (data) => this.filterMetadata(data, cutoffDate),
    );
  }

  private async handleCompactInfoRequest(
    path: string,
    res: Response,
  ): Promise<void> {
    const cutoffDate = new Date(Date.now() - this.config.delayMs);
    const upstreamBase = new URL(this.config.upstream);
    const gemName = path.slice('/info/'.length);

    // Fetch compact index text and JSON API timestamps in parallel
    const [infoRes, versionsRes] = await Promise.all([
      axios.get<string>(`${upstreamBase.origin}/info/${gemName}`, {
        responseType: 'text',
        validateStatus: () => true,
        maxRedirects: 0,
      }),
      axios.get<RubyGemVersion[]>(
        `${upstreamBase.origin}/api/v1/versions/${gemName}.json`,
        { validateStatus: () => true, maxRedirects: 0 },
      ),
    ]);

    if (infoRes.status !== 200) {
      res.status(infoRes.status).send(infoRes.data);
      return;
    }

    // If we can't get timestamps, treat the gem as not found
    if (versionsRes.status !== 200 || !Array.isArray(versionsRes.data)) {
      res.status(versionsRes.status === 404 ? 404 : 502).json({
        error: versionsRes.status === 404 ? 'Not found' : 'Bad Gateway',
      });
      return;
    }

    const allowedVersions = new Set<string>(
      versionsRes.data
        .filter((v) => new Date(v.created_at) <= cutoffDate)
        .map((v) => v.number),
    );

    const filtered = filterCompactInfo(infoRes.data, allowedVersions);
    if (filtered === null) {
      res.status(404).json({ error: 'Not found' });
      return;
    }

    res.status(200).type('text/plain').send(filtered);
  }
}

/**
 * Filter a compact index /info/{name} response to only include allowed versions.
 *
 * Format:
 *   ---
 *   1.0.0 dep:>= 1.0|ruby:>= 2.0,checksum:sha256:abc123
 *   1.1.0 |checksum:sha256:def456
 *
 * Returns null when all versions are filtered out.
 */
function filterCompactInfo(
  text: string,
  allowedVersions: Set<string>,
): string | null {
  const lines = text.split('\n');
  const separatorIdx = lines.indexOf('---');
  if (separatorIdx === -1) {
    // Unknown format — pass through unchanged
    return text;
  }

  const header = lines.slice(0, separatorIdx + 1);
  const versionLines = lines.slice(separatorIdx + 1);

  const filteredVersionLines = versionLines.filter((line) => {
    const trimmed = line.trim();
    if (!trimmed) return true; // preserve blank lines
    const version = trimmed.split(' ')[0];
    return allowedVersions.has(version);
  });

  const hasVersions = filteredVersionLines.some((l) => l.trim().length > 0);
  if (!hasVersions) return null;

  return [...header, ...filteredVersionLines].join('\n');
}
