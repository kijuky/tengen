import { createHash, randomBytes } from 'node:crypto';
import { mkdir, open, readdir, readFile, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { Readable } from 'node:stream';
import type { VersionMetadata } from './base.ts';

/**
 * Response headers kept with a cached artifact and replayed on a hit.
 *
 * `content-encoding` is not among them: what is stored is the artifact itself,
 * so a hit can be served to any client, whatever it asked to accept.
 */
export const CACHED_HEADERS = [
  'content-type',
  'last-modified',
  'etag',
] as const;

/** What is stored beside an artifact's bytes. */
interface Sidecar {
  /** Request path the artifact was downloaded for. Kept for logs and debugging. */
  path: string;
  /** Size of the stored bytes. */
  size: number;
  headers: Partial<Record<(typeof CACHED_HEADERS)[number], string>>;
  /**
   * The version the artifact belongs to, as it was judged when downloaded.
   * Kept so a hit can be judged again without asking the upstream — the
   * malicious DB is local, and a publish date does not change.
   */
  version: { packageName: string; version: string; published: string };
}

export interface CachedArtifact {
  path: string;
  dataFile: string;
  size: number;
  headers: Sidecar['headers'];
  version: VersionMetadata;
}

/**
 * Artifact downloads stored on disk, one directory per registry.
 *
 * Only downloads are stored: an artifact of a given version does not change,
 * whereas metadata does and is filtered afresh on every request. Each entry is
 * a data file and a JSON sidecar, both named by the SHA-256 of the request path
 * so that no part of the path reaches the filesystem.
 *
 * Writes go to a temporary file that is renamed into place, and the sidecar is
 * renamed last. A reader that finds the sidecar therefore finds complete data.
 */
export class DownloadCache {
  private readonly dir: string;

  // Assigned in the body rather than declared as a parameter property: tengen
  // runs under Node's type stripping, which cannot transform those.
  constructor(dir: string) {
    this.dir = dir;
  }

  private files(path: string): { data: string; sidecar: string } {
    const key = createHash('sha256').update(path).digest('hex');
    return {
      data: join(this.dir, `${key}.data`),
      sidecar: join(this.dir, `${key}.json`),
    };
  }

  /** The cached artifact for a request path, or null when there is none. */
  async lookup(path: string): Promise<CachedArtifact | null> {
    const files = this.files(path);
    let sidecar: Sidecar;
    try {
      sidecar = JSON.parse(await readFile(files.sidecar, 'utf-8')) as Sidecar;
    } catch {
      return null;
    }
    // An entry with a content encoding holds compressed bytes rather than the
    // artifact; replaying it would hand clients that never asked for the
    // encoding something whose checksum does not match. Drop it so the
    // artifact is fetched again.
    if ('content-encoding' in (sidecar.headers as Record<string, string>)) {
      await this.remove(path);
      return null;
    }
    try {
      const { size } = await stat(files.data);
      // A data file that does not match its sidecar was not written by store();
      // serving it could hand out a truncated artifact.
      if (size !== sidecar.size) return null;
    } catch {
      return null;
    }
    return {
      path: sidecar.path,
      dataFile: files.data,
      size: sidecar.size,
      headers: sidecar.headers,
      version: {
        packageName: sidecar.version.packageName,
        version: sidecar.version.version,
        published: new Date(sidecar.version.published),
      },
    };
  }

  /**
   * Write an artifact's bytes from `source`.
   *
   * Nothing is kept when the stream fails or ends short of `expectedSize`, so a
   * half-downloaded artifact is never served later.
   */
  async store(
    path: string,
    source: Readable,
    info: {
      expectedSize?: number;
      headers: Sidecar['headers'];
      version: VersionMetadata;
    },
  ): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    const files = this.files(path);
    const suffix = `.tmp-${randomBytes(6).toString('hex')}`;
    const tmpData = files.data + suffix;
    const tmpSidecar = files.sidecar + suffix;

    try {
      const handle = await open(tmpData, 'w');
      let size = 0;
      source.on('data', (chunk: Buffer) => {
        size += chunk.length;
      });
      await pipeline(source, handle.createWriteStream());
      if (info.expectedSize !== undefined && size !== info.expectedSize) {
        throw new Error(
          `expected ${info.expectedSize} bytes from upstream, got ${size}`,
        );
      }

      const sidecar: Sidecar = {
        path,
        size,
        headers: info.headers,
        version: {
          packageName: info.version.packageName,
          version: info.version.version,
          published: info.version.published.toISOString(),
        },
      };
      const sidecarHandle = await open(tmpSidecar, 'w');
      try {
        await sidecarHandle.writeFile(JSON.stringify(sidecar));
      } finally {
        await sidecarHandle.close();
      }
      await rename(tmpData, files.data);
      await rename(tmpSidecar, files.sidecar);
    } catch (err) {
      await rm(tmpData, { force: true });
      await rm(tmpSidecar, { force: true });
      throw err;
    }
  }

  /** Remove the cached artifact for a request path, if any. */
  async remove(path: string): Promise<void> {
    const files = this.files(path);
    // Sidecar first, so a concurrent lookup stops finding the entry before its
    // data disappears.
    await rm(files.sidecar, { force: true });
    await rm(files.data, { force: true });
  }

  /** Every complete entry, for sweeps over the whole cache. */
  async *entries(): AsyncGenerator<{ path: string; version: VersionMetadata }> {
    let names: string[];
    try {
      names = await readdir(this.dir);
    } catch {
      return;
    }
    for (const name of names) {
      if (!name.endsWith('.json')) continue;
      let sidecar: Sidecar;
      try {
        sidecar = JSON.parse(
          await readFile(join(this.dir, name), 'utf-8'),
        ) as Sidecar;
      } catch {
        continue;
      }
      yield {
        path: sidecar.path,
        version: {
          packageName: sidecar.version.packageName,
          version: sidecar.version.version,
          published: new Date(sidecar.version.published),
        },
      };
    }
  }
}
