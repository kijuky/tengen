import type { Request, Response } from "express";
import axios from "axios";
import escapeHtml from "escape-html";
import { RegistryProxy } from "./base.ts";

interface PyPiFile {
  upload_time_iso_8601: string;
  [key: string]: unknown;
}

interface PyPiMetadata {
  info: {
    name: string;
    version: string;
    [key: string]: unknown;
  };
  last_serial: number;
  releases: Record<string, PyPiFile[]>;
  urls: PyPiFile[];
  [key: string]: unknown;
}

interface SimpleApiFile {
  filename: string;
  url: string;
  hashes: Record<string, string>;
  "upload-time"?: string;
  "requires-python"?: string;
  [key: string]: unknown;
}

interface SimpleApiMetadata {
  meta: { "api-version": string };
  name: string;
  files: SimpleApiFile[];
  versions?: string[];
  [key: string]: unknown;
}

/**
 * Extract the version string from a wheel or sdist filename.
 * wheel:  {name}-{version}-{pytag}-{abitag}-{platformtag}.whl
 * sdist:  {name}-{version}.tar.gz | .zip | .tar.bz2
 */
function extractVersion(filename: string): string {
  const withoutExt = filename.replace(/\.(whl|tar\.gz|tar\.bz2|tgz|zip)$/, "");
  return withoutExt.split("-")[1] ?? "";
}

export class PypiRegistryProxy extends RegistryProxy {
  readonly name = "pypi";

  /**
   * Routes requests:
   *   /simple/{name}/             → Simple API (HTML or JSON)
   *   /pypi/{name}/json           → JSON API metadata (package-level)
   *   /pypi/{name}/{version}/json → JSON API metadata (version-specific)
   *   everything else             → binary artifact passthrough
   */
  override async handleRequest(req: Request, res: Response): Promise<void> {
    const simpleMatch = req.path.match(/^\/simple\/([^/]+)\/?$/);
    if (simpleMatch) {
      await this.handleSimpleApiRequest(req, res, simpleMatch[1]);
    } else if (req.path.endsWith("/json")) {
      await this.handleJsonApiRequest(req, res);
    } else {
      await this.handlePassthrough(req, res);
    }
  }

  private async handleSimpleApiRequest(
    req: Request,
    res: Response,
    packageName: string,
  ): Promise<void> {
    const cutoffDate = new Date(Date.now() - this.config.delayMs);
    const upstreamBase = new URL(this.config.upstream);
    // PyPI Simple API lives under /simple/, not /pypi/
    const upstreamUrl = `${upstreamBase.origin}/simple/${packageName}/`;

    // Always request JSON Simple API from upstream to get upload-time for filtering
    const response = await axios.get<SimpleApiMetadata>(upstreamUrl, {
      validateStatus: () => true,
      maxRedirects: 0,
      headers: { Accept: "application/vnd.pypi.simple.v1+json" },
    });

    if (response.status !== 200) {
      res.status(response.status).json(response.data);
      return;
    }

    const data = response.data;
    const filteredFiles = data.files.filter((file) => {
      if (!file["upload-time"]) return true;
      return new Date(file["upload-time"]) <= cutoffDate;
    });

    if (filteredFiles.length === 0 && data.files.length > 0) {
      res.status(404).json({ error: "Not found" });
      return;
    }

    const allowedVersions = new Set(
      filteredFiles.map((f) => extractVersion(f.filename)),
    );
    const filteredVersions = data.versions?.filter((v) =>
      allowedVersions.has(v),
    );

    const filtered: SimpleApiMetadata = {
      ...data,
      files: filteredFiles,
      ...(filteredVersions !== undefined && { versions: filteredVersions }),
    };

    if (req.headers.accept?.includes("application/vnd.pypi.simple.v1+json")) {
      res
        .status(200)
        .setHeader("content-type", "application/vnd.pypi.simple.v1+json")
        .json(filtered);
    } else {
      res
        .status(200)
        .setHeader("content-type", "text/html")
        .send(toSimpleApiHtml(filtered));
    }
  }

  private async handleJsonApiRequest(
    req: Request,
    res: Response,
  ): Promise<void> {
    const cutoffDate = new Date(Date.now() - this.config.delayMs);
    await this.handleFilteredJson(res, this.buildUpstreamUrl(req), (data) =>
      filterMetadata(data, cutoffDate),
    );
  }
}

function toSimpleApiHtml(data: SimpleApiMetadata): string {
  const links = data.files
    .map((file) => {
      const requiresPython = file["requires-python"]
        ? ` data-requires-python="${escapeHtml(file["requires-python"])}"`
        : "";
      return `    <a href="${file.url}"${requiresPython}>${file.filename}</a><br />`;
    })
    .join("\n");
  return [
    "<!DOCTYPE html>",
    '<html lang="en">',
    "  <head>",
    `    <title>Links for ${data.name}</title>`,
    "  </head>",
    "  <body>",
    `    <h1>Links for ${data.name}</h1>`,
    links,
    "  </body>",
    "</html>",
  ].join("\n");
}

function filterMetadata(data: unknown, cutoffDate: Date): unknown | null {
  const pkg = data as PyPiMetadata;

  if (!pkg.releases) {
    // Version-specific endpoint (/pypi/{name}/{version}/json) has no releases field.
    // Use urls to check whether this version is within the delay window.
    if (Array.isArray(pkg.urls) && pkg.urls.length > 0) {
      const earliest = pkg.urls.reduce((min, file) => {
        const t = new Date(file.upload_time_iso_8601);
        return t < min ? t : min;
      }, new Date(pkg.urls[0].upload_time_iso_8601));
      if (earliest > cutoffDate) return null;
    }
    return data;
  }

  // Filter releases: keep a version if its earliest upload is before or at cutoff
  const filteredReleases: Record<string, PyPiFile[]> = {};
  for (const [version, files] of Object.entries(pkg.releases)) {
    if (files.length === 0) continue;
    const uploadTime = files.reduce((earliest, file) => {
      const t = new Date(file.upload_time_iso_8601);
      return t < earliest ? t : earliest;
    }, new Date(files[0].upload_time_iso_8601));

    if (uploadTime <= cutoffDate) {
      filteredReleases[version] = files;
    }
  }

  if (Object.keys(filteredReleases).length === 0) {
    return null;
  }

  // Find the latest allowed version by upload time
  let latestVersion = "";
  let latestTime = new Date(0);
  for (const [version, files] of Object.entries(filteredReleases)) {
    if (files.length === 0) continue;
    const t = new Date(files[0].upload_time_iso_8601);
    if (t > latestTime) {
      latestTime = t;
      latestVersion = version;
    }
  }

  return {
    ...pkg,
    info: {
      ...pkg.info,
      version: latestVersion,
    },
    releases: filteredReleases,
    urls: filteredReleases[latestVersion] ?? [],
  };
}
