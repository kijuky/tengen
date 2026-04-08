import type { Request, Response } from 'express';
import axios from 'axios';
import { RegistryProxy } from './base.ts';

interface MavenSearchDoc {
  v: string;
  timestamp: number;
  [key: string]: unknown;
}

interface MavenSearchResponse {
  response: {
    docs: MavenSearchDoc[];
    numFound: number;
  };
}

export class MavenRegistryProxy extends RegistryProxy {
  readonly name = 'maven';

  /**
   * Metadata paths:
   *   /{groupId/as/path}/{artifactId}/maven-metadata.xml
   *
   * Everything else (JARs, POMs, sources, checksums, etc.) is passed through.
   */
  isMetadataPath(path: string): boolean {
    return path.endsWith('/maven-metadata.xml');
  }

  filterMetadata(data: unknown, _cutoffDate: Date): unknown | null {
    // Maven metadata is XML and requires a separate timestamp lookup via the
    // Maven Central Search API. Filtering happens in handleRequest instead.
    return data;
  }

  override async handleRequest(req: Request, res: Response): Promise<void> {
    if (this.isMetadataPath(req.path)) {
      try {
        await this.handleMavenMetadataRequest(req.path, res);
      } catch (err) {
        if (!res.headersSent) {
          res.status(502).json({ error: 'Bad Gateway', message: String(err) });
        }
      }
      return;
    }
    await super.handleRequest(req, res);
  }

  private async handleMavenMetadataRequest(
    path: string,
    res: Response,
  ): Promise<void> {
    const cutoffDate = new Date(Date.now() - this.config.delayMs);
    const upstreamBase = new URL(this.config.upstream);
    const { groupId, artifactId } = parseMavenPath(path);

    // Fetch maven-metadata.xml and Maven Central Search API timestamps in parallel
    const [metadataRes, searchRes] = await Promise.all([
      axios.get<string>(`${upstreamBase.origin}${path}`, {
        responseType: 'text',
        validateStatus: () => true,
        maxRedirects: 0,
      }),
      axios.get<MavenSearchResponse>(
        'https://search.maven.org/solrsearch/select',
        {
          params: {
            q: `g:"${groupId}" AND a:"${artifactId}"`,
            core: 'gav',
            rows: 500,
            wt: 'json',
          },
          validateStatus: () => true,
          maxRedirects: 0,
        },
      ),
    ]);

    if (metadataRes.status !== 200) {
      res.status(metadataRes.status).send(metadataRes.data);
      return;
    }

    if (searchRes.status !== 200 || !searchRes.data?.response?.docs) {
      res.status(502).json({
        error: 'Bad Gateway',
        message: 'Failed to fetch version timestamps from Maven Central Search',
      });
      return;
    }

    const allowedDocs = searchRes.data.response.docs.filter(
      (doc) => doc.timestamp <= cutoffDate.getTime(),
    );
    const allowedVersions = new Set<string>(allowedDocs.map((doc) => doc.v));

    // Determine the latest allowed version by timestamp
    const latestDoc = allowedDocs.reduce<MavenSearchDoc | null>((acc, doc) => {
      if (!acc || doc.timestamp > acc.timestamp) return doc;
      return acc;
    }, null);
    const latestVersion = latestDoc?.v ?? '';

    const filtered = filterMavenMetadataXml(
      metadataRes.data,
      allowedVersions,
      latestVersion,
    );
    if (filtered === null) {
      res.status(404).json({ error: 'Not found' });
      return;
    }

    res.status(200).type('application/xml').send(filtered);
  }
}

/**
 * Parse groupId and artifactId from a Maven path.
 *
 * Example:
 *   /com/example/mylib/maven-metadata.xml
 *   -> groupId: "com.example", artifactId: "mylib"
 */
export function parseMavenPath(path: string): {
  groupId: string;
  artifactId: string;
} {
  const withoutFile = path.replace(/\/maven-metadata\.xml$/, '');
  const parts = withoutFile.split('/').filter(Boolean);
  const artifactId = parts[parts.length - 1] ?? '';
  const groupId = parts.slice(0, -1).join('.');
  return { groupId, artifactId };
}

/**
 * Filter a maven-metadata.xml string to only include allowed versions.
 *
 * Updates <versions>, <release>, <latest>, and <lastUpdated> fields.
 * Returns null when no versions remain after filtering.
 */
export function filterMavenMetadataXml(
  xml: string,
  allowedVersions: Set<string>,
  latestVersion: string,
): string | null {
  let hasAllowedVersions = false;

  // Filter <version> entries inside the <versions> block
  const filtered = xml.replace(
    /(<versions>)([\s\S]*?)(<\/versions>)/,
    (_, open: string, content: string, close: string) => {
      const filteredContent = content.replace(
        /<version>([^<]*)<\/version>/g,
        (match: string, v: string) => {
          if (allowedVersions.has(v.trim())) {
            hasAllowedVersions = true;
            return match;
          }
          return '';
        },
      );
      return `${open}${filteredContent}${close}`;
    },
  );

  if (!hasAllowedVersions) return null;

  // Update <release>, <latest>, and <lastUpdated> to reflect the filtered state
  return filtered
    .replace(/<release>[^<]*<\/release>/, `<release>${latestVersion}</release>`)
    .replace(/<latest>[^<]*<\/latest>/, `<latest>${latestVersion}</latest>`);
}
