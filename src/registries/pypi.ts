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
   *   /simple/{name}              → Simple API (HTML or JSON); file URLs are rewritten to proxy-relative paths
   *   /pypi/{name}/json           → JSON API metadata (package-level)
   *   /pypi/{name}/{version}/json → JSON API metadata (version-specific)
   *   /packages/...               → download route (version-filtered then passthrough)
   */
  /**
   * Absolute URL prefix for rewriting artifact links so clients fetch through
   * the proxy. Returns `{baseUrl}/{name}` in proxied mode when --base-url is set
   * (the upstream is unreachable, so links must be absolute and point here), or
   * null otherwise — callers then fall back to a proxy-root-relative path
   * (Simple API) or leave the upstream URL intact (JSON API).
   */
  private pipeArtifactBase(): string | null {
    return this.config.upstreamAccess === 'proxied' && this.config.baseUrl
      ? `${this.config.baseUrl}/${this.name}`
      : null;
  }

  public setRouting() {
    this.addMetadataRoute<SimpleApiMetadata, PypiVersionMetadataType>({
      condition: (req) => req.path.startsWith('/simple/'),
      requestUpstream: async (originalReq) => {
        return await axios.get<SimpleApiMetadata>(
          this.buildUpstreamUrl(originalReq).replace(/\/$/, '') + '/',
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
        // Only rewrite file URLs in proxied mode. In direct mode the upstream
        // (files.pythonhosted.org) is reachable, so leave the URLs pointing
        // there and let the client download directly. In proxied mode use an
        // absolute --base-url when set, otherwise a proxy-root-relative path
        // (PEP 503 clients resolve it against the index URL, which already
        // points at the proxy).
        const urlPrefix =
          this.config.upstreamAccess === 'proxied'
            ? (this.pipeArtifactBase() ?? '/' + this.name)
            : null;
        const rewritten = urlPrefix
          ? rewriteFileUrls(filtered, urlPrefix)
          : filtered;
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
      filterMetadata: (metadata, allowedVersions) => {
        const filtered = filterPackageLevelMetadata(metadata, allowedVersions);
        // The JSON API embeds absolute file URLs (files.pythonhosted.org). In
        // proxied mode that host is unreachable, so rewrite them to this proxy.
        // pip/poetry/uv install via the Simple API; this covers tools that read
        // download URLs from the JSON API. Requires --base-url because JSON-API
        // consumers expect absolute URLs; left intact in direct mode or when
        // no base URL is set.
        const base = this.pipeArtifactBase();
        return base ? rewriteJsonApiFileUrls(filtered, base) : filtered;
      },
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
            maxRedirects: 1, // for path normalization redirects
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
  // Parse each filename to derive its exact version, then associate the file
  // with that single version. Substring matching (e.g. `-${ver}.`) would
  // mis-associate `pkg-1.0.1-*.whl` with version `1.0`, letting a malicious
  // `1.0.1` slip through under the `1.0` label.
  const knownVersions = new Set(metadata.versions);
  const versions: PypiVersionMetadataType[] = [];
  for (const file of metadata.files) {
    if (!file['upload-time']) continue;
    const parsed = parseDownloadFilename(file.filename);
    if (!parsed) continue;
    if (!knownVersions.has(parsed.version)) continue;
    versions.push({
      packageName: metadata.name,
      version: parsed.version,
      published: new Date(file['upload-time']),
      filename: file.filename,
    });
  }
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
 * Rewrite the absolute file URLs in a package-level JSON API response (the
 * `urls` list and every `releases[version]` entry) to point at this proxy:
 *
 *   https://files.pythonhosted.org/packages/.../foo-1.0.whl#sha256=abc
 *   → {urlPrefix}/packages/.../foo-1.0.whl#sha256=abc
 *
 * Unlike the Simple API (which may use relative URLs per PEP 503), JSON API
 * consumers expect absolute URLs, so `urlPrefix` must be an absolute base.
 * Leaves any entry whose `url` isn't a parseable absolute URL untouched.
 */
function rewriteJsonApiFileUrls(
  metadata: PyPiMetadata,
  urlPrefix: string,
): PyPiMetadata {
  const rewriteFile = (f: PyPiFile): PyPiFile => {
    if (typeof f.url !== 'string') return f;
    try {
      const u = new URL(f.url);
      return { ...f, url: urlPrefix + u.pathname + u.hash };
    } catch {
      return f;
    }
  };
  const releases: Record<string, PyPiFile[]> = {};
  for (const [version, files] of Object.entries(metadata.releases)) {
    releases[version] = files.map(rewriteFile);
  }
  return {
    ...metadata,
    releases,
    urls: metadata.urls.map(rewriteFile),
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
    const packageName = base.slice(0, dashIdx).toLowerCase().replace(/[-_.]+/g, '-');
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
        .replace(/[-_.]+/g, '-');
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
