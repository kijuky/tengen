import escapeHtml from 'escape-html';
import { RegistryProxy, type VersionMetadata } from './base.ts';
import axios from 'axios';

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
interface PypiVersionMetadataType extends VersionMetadata {
  filename: string;
}

interface SimpleApiFile {
  filename: string;
  url: string;
  hashes: Record<string, string>;
  'upload-time'?: string;
  'requires-python'?: string;
  [key: string]: unknown;
}

interface SimpleApiMetadata {
  meta: { 'api-version': string };
  name: string;
  files: SimpleApiFile[];
  versions: string[];
  [key: string]: unknown;
}

export class PypiRegistryProxy extends RegistryProxy {
  readonly name = 'pypi';

  /**
   * Routes:
   *   /simple/{name}/             → Simple API (HTML or JSON)
   *   /pypi/{name}/json           → JSON API metadata (package-level)
   *   /pypi/{name}/{version}/json → JSON API metadata (version-specific)
   *   everything else             → binary artifact passthrough
   */
  public setRouting() {
    this.addMetadataRoute<SimpleApiMetadata, PypiVersionMetadataType>({
      condition: (req) =>
        req.path.startsWith('/simple/') && req.path.endsWith('/'),
      requestUpstream: async (originalReq) => {
        return await axios.get<SimpleApiMetadata>(
          this.buildUpstreamUrl(originalReq),
          {
            validateStatus: () => true,
            maxRedirects: 0,
            headers: {
              Accept: 'application/vnd.pypi.simple.v1+json',
            },
          },
        );
      },
      getVersions: (metadata) => getSimpleApiVersions(metadata),
      filterMetadata: filterSimpleApiMetadata,
      respond: (res, filtered, req) => {
        if (
          req.headers.accept?.includes('application/vnd.pypi.simple.v1+json')
        ) {
          res
            .status(200)
            .setHeader('content-type', 'application/vnd.pypi.simple.v1+json')
            .json(filtered);
        } else {
          res
            .status(200)
            .setHeader('content-type', 'text/html')
            .send(toSimpleApiHtml(filtered));
        }
      },
    });
    this.addMetadataRoute<PyPiMetadata>({
      condition: (req) =>
        req.path.startsWith('/pypi/') && req.path.endsWith('/json'),
      getVersions: getPackageLevelVersions,
      filterMetadata: filterPackageLevelMetadata,
    });
  }
}

// ── Simple API (/simple/{name}/) ────────────────────────────────────────────

function getSimpleApiVersions(
  metadata: SimpleApiMetadata,
): PypiVersionMetadataType[] {
  const versions: PypiVersionMetadataType[] = [];
  metadata.versions.map((ver) => {
    metadata.files
      .filter(
        (file) =>
          file.filename.includes(`-${ver}.`) ||
          file.filename.includes(`-${ver}-`),
      )
      .forEach((file) => {
        if (file['upload-time']) {
          versions.push({
            version: ver,
            published: new Date(file['upload-time']),
            filename: file.filename,
          });
        }
      });
  });
  return versions;
}

function filterSimpleApiMetadata(
  metadata: SimpleApiMetadata,
  allowedVersions: PypiVersionMetadataType[],
): SimpleApiMetadata {
  const data = metadata as SimpleApiMetadata;
  const allowedFilenamesSet = new Set(allowedVersions.map((v) => v.filename));
  const allowedVersionsSet = new Set(allowedVersions.map((v) => v.version));
  const filteredFiles = data.files.filter((f) =>
    allowedFilenamesSet.has(f.filename),
  );
  const filteredVersions = data.versions.filter((v) =>
    allowedVersionsSet.has(v),
  );

  return {
    ...data,
    files: filteredFiles,
    versions: filteredVersions,
  };
}

function toSimpleApiHtml(data: SimpleApiMetadata): string {
  const links = data.files
    .map((file) => {
      const requiresPython = file['requires-python']
        ? ` data-requires-python="${escapeHtml(file['requires-python'])}"`
        : '';
      return `    <a href="${file.url}"${requiresPython}>${file.filename}</a><br />`;
    })
    .join('\n');
  return [
    '<!DOCTYPE html>',
    '<html lang="en">',
    '  <head>',
    `    <title>Links for ${data.name}</title>`,
    '  </head>',
    '  <body>',
    `    <h1>Links for ${data.name}</h1>`,
    links,
    '  </body>',
    '</html>',
  ].join('\n');
}

// ── Package-level JSON API (/pypi/{name}/json) ───────────────────────────────

function getPackageLevelVersions(metadata: PyPiMetadata): VersionMetadata[] {
  if (!metadata.releases) return [];
  const versions: VersionMetadata[] = [];
  for (const [version, files] of Object.entries(metadata.releases)) {
    if (files.length === 0) continue;
    const earliest = files.reduce((min, f) => {
      const t = new Date(f.upload_time_iso_8601);
      return t < min ? t : min;
    }, new Date(files[0].upload_time_iso_8601));
    versions.push({ version, published: earliest });
  }
  return versions;
}

function filterPackageLevelMetadata(
  metadata: PyPiMetadata,
  allowedVersions: VersionMetadata[],
): PyPiMetadata {
  const allowedSet = new Set(allowedVersions.map((v) => v.version));
  const filteredReleases: Record<string, PyPiFile[]> = {};
  for (const [version, files] of Object.entries(metadata.releases)) {
    if (allowedSet.has(version)) filteredReleases[version] = files;
  }
  const latestVersion = [...allowedVersions].sort(
    (a, b) => b.published.getTime() - a.published.getTime(),
  )[0];
  return {
    ...metadata,
    info: { ...metadata.info, version: latestVersion?.version },
    releases: filteredReleases,
    urls: latestVersion ? (filteredReleases[latestVersion.version] ?? []) : [],
  };
}
