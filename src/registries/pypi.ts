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
   *   /simple/{name}/             → Simple API (HTML or JSON); file URLs are rewritten to proxy-relative paths
   *   /pypi/{name}/json           → JSON API metadata (package-level)
   *   /pypi/{name}/{version}/json → JSON API metadata (version-specific)
   *   /packages/...               → download route (version-filtered then passthrough)
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
        const rewritten = rewriteFileUrls(filtered, '/' + this.name);
        if (
          req.headers.accept?.includes('application/vnd.pypi.simple.v1+json')
        ) {
          res
            .status(200)
            .setHeader('content-type', 'application/vnd.pypi.simple.v1+json')
            .json(rewritten);
        } else {
          res
            .status(200)
            .setHeader('content-type', 'text/html')
            .send(toSimpleApiHtml(rewritten));
        }
      },
    });
    this.addMetadataRoute<PyPiMetadata>({
      condition: (req) =>
        req.path.startsWith('/pypi/') && req.path.endsWith('/json'),
      getVersions: getPackageLevelVersions,
      filterMetadata: filterPackageLevelMetadata,
    });
    this.addDownloadRoute<PypiVersionMetadataType>({
      condition: (req) => req.path.startsWith('/packages/'),
      getVersionMetadata: async (req) => {
        const filename = req.path.split('/').pop();
        if (!filename) return null;

        const parsed = parseDownloadFilename(filename);
        if (!parsed) return null;
        const { packageName, version } = parsed;

        const response = await axios.get<SimpleApiMetadata>(
          `${this.config.upstream.replace(/\/$/, '')}/simple/${packageName}/`,
          {
            validateStatus: () => true,
            maxRedirects: 0,
            headers: { Accept: 'application/vnd.pypi.simple.v1+json' },
          },
        );
        if (response.status !== 200) return null;

        const lookupFilename = filename.endsWith('.whl.metadata')
          ? filename.slice(0, -'.metadata'.length)
          : filename;
        const file = response.data.files?.find(
          (f) => f.filename === lookupFilename,
        );
        if (!file?.['upload-time']) return null;

        return {
          packageName,
          version,
          published: new Date(file['upload-time'] as string),
          filename,
        };
      },
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
            packageName: metadata.name,
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

// ── Download route (/packages/...) ──────────────────────────────────────────

/**
 * Rewrite file URLs in a Simple API response to proxy-relative paths so that
 * client downloads are intercepted by the download route instead of going
 * directly to files.pythonhosted.org.
 *
 *   https://files.pythonhosted.org/packages/.../foo-1.0.whl#sha256=abc
 *   → /packages/.../foo-1.0.whl#sha256=abc
 */
function rewriteFileUrls(
  data: SimpleApiMetadata,
  urlPrefix: string,
): SimpleApiMetadata {
  return {
    ...data,
    files: data.files.map((f) => {
      try {
        const u = new URL(f.url);
        return { ...f, url: urlPrefix + u.pathname + u.hash };
      } catch {
        return f;
      }
    }),
  };
}

/**
 * Parse a PyPI filename into package name and version.
 *
 * Handles wheels and source distributions:
 *   requests-2.28.0-py3-none-any.whl → { packageName: 'requests', version: '2.28.0' }
 *   some_package-1.0.0.tar.gz        → { packageName: 'some-package', version: '1.0.0' }
 */
function parseDownloadFilename(
  filename: string,
): { packageName: string; version: string } | null {
  // Wheel: {name}-{version}(-{build})?-{python}-{abi}-{platform}.whl or .whl.metadata
  if (filename.endsWith('.whl.metadata') || filename.endsWith('.whl')) {
    const base = filename.endsWith('.whl.metadata')
      ? filename.slice(0, -13)
      : filename.slice(0, -4);
    const dashIdx = base.indexOf('-');
    if (dashIdx === -1) return null;
    const packageName = base.slice(0, dashIdx).toLowerCase().replace(/_/g, '-');
    const version = base.slice(dashIdx + 1).split('-')[0];
    if (!version) return null;
    return { packageName, version };
  }

  // Source dist: {name}-{version}.tar.gz or {name}-{version}.zip
  let base: string;
  if (filename.endsWith('.tar.gz')) {
    base = filename.slice(0, -7);
  } else if (filename.endsWith('.zip')) {
    base = filename.slice(0, -4);
  } else {
    return null;
  }

  // Find the version: first dash-separated component starting with a digit
  const parts = base.split('-');
  for (let i = 1; i < parts.length; i++) {
    if (/^\d/.test(parts[i])) {
      const packageName = parts
        .slice(0, i)
        .join('-')
        .toLowerCase()
        .replace(/_/g, '-');
      const version = parts.slice(i).join('-');
      return { packageName, version };
    }
  }
  return null;
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
    versions.push({
      packageName: metadata.info.name,
      version,
      published: earliest,
    });
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
