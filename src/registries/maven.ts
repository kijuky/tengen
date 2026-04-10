import type { Request, Response } from "express";
import axios from "axios";
import { createHash } from "node:crypto";
import { RegistryProxy } from "./base.ts";

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
  readonly name = "maven";

  private readonly metadataCache = new Map<
    string,
    { value: string; expiresAt: number }
  >();
  private static readonly CACHE_TTL_MS = 120_000;

  /**
   * Routes requests:
   *   /{groupId/as/path}/{artifactId}/maven-metadata.xml        → filtered XML metadata
   *   /{groupId/as/path}/{artifactId}/maven-metadata.xml.sha1  → SHA1 of filtered XML
   *   /{groupId/as/path}/{artifactId}/maven-metadata.xml.md5   → MD5 of filtered XML
   *   everything else (JARs, POMs, sources, other checksums)    → passthrough
   */
  override async handleRequest(req: Request, res: Response): Promise<void> {
    const path = req.path;
    const checksumSuffix = path.endsWith("/maven-metadata.xml.sha1")
      ? "sha1"
      : path.endsWith("/maven-metadata.xml.md5")
        ? "md5"
        : null;
    const isMetadata = path.endsWith("/maven-metadata.xml");

    if (!isMetadata && checksumSuffix === null) {
      await this.handlePassthrough(req, res);
      return;
    }

    const xmlPath = checksumSuffix
      ? path.slice(0, -(checksumSuffix.length + 1))
      : path;

    const filtered = await this.buildFilteredMetadata(xmlPath, res);
    if (filtered === null) return; // response already written

    if (checksumSuffix) {
      const hash = createHash(checksumSuffix === "sha1" ? "sha1" : "md5")
        .update(filtered)
        .digest("hex");
      res.status(200).type("text/plain").send(hash);
    } else {
      res.status(200).type("application/xml").send(filtered);
    }
  }

  /**
   * Fetches upstream maven-metadata.xml and returns a filtered copy,
   * or writes an error response and returns null.
   */
  private async buildFilteredMetadata(
    path: string,
    res: Response,
  ): Promise<string | null> {
    const cached = this.metadataCache.get(path);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.value;
    }

    const upstreamBase = new URL(this.config.upstream);
    const upstreamUrl = `${upstreamBase.href.replace(/\/$/, "")}${path}`;

    const metadataRes = await axios.get<string>(upstreamUrl, {
      responseType: "text",
      validateStatus: () => true,
      maxRedirects: 0,
    });

    if (metadataRes.status !== 200) {
      res.status(metadataRes.status).send(metadataRes.data);
      return null;
    }

    // Group-level metadata lists plugins/artifacts without <versions> — pass through as-is
    if (!metadataRes.data.includes("<versions>")) {
      return metadataRes.data;
    }

    const cutoffDate = new Date(Date.now() - this.config.delayMs);
    const { groupId, artifactId } = parseMavenPath(path);

    const searchRes = await axios.get<MavenSearchResponse>(
      "https://search.maven.org/solrsearch/select",
      {
        params: {
          q: `g:"${groupId}" AND a:"${artifactId}"`,
          core: "gav",
          rows: 500,
          wt: "json",
        },
        validateStatus: () => true,
        maxRedirects: 0,
      },
    );

    if (searchRes.status !== 200 || !searchRes.data?.response?.docs) {
      res.status(502).json({
        error: "Bad Gateway",
        message: "Failed to fetch version timestamps from Maven Central Search",
      });
      return null;
    }

    const allowedDocs = searchRes.data.response.docs.filter(
      (doc) => doc.timestamp <= cutoffDate.getTime(),
    );
    const allowedVersions = new Set<string>(allowedDocs.map((doc) => doc.v));

    const latestDoc = allowedDocs.reduce<MavenSearchDoc | null>((acc, doc) => {
      if (!acc || doc.timestamp > acc.timestamp) return doc;
      return acc;
    }, null);
    const latestVersion = latestDoc?.v ?? "";

    const filtered = filterMavenMetadataXml(
      metadataRes.data,
      allowedVersions,
      latestVersion,
    );
    if (filtered === null) {
      res.status(404).json({ error: "Not found" });
      return null;
    }

    this.metadataCache.set(path, {
      value: filtered,
      expiresAt: Date.now() + MavenRegistryProxy.CACHE_TTL_MS,
    });
    return filtered;
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
  const withoutFile = path.replace(/\/maven-metadata\.xml$/, "");
  const parts = withoutFile.split("/").filter(Boolean);
  const artifactId = parts[parts.length - 1] ?? "";
  const groupId = parts.slice(0, -1).join(".");
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
          return "";
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
