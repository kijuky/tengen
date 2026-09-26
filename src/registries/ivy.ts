import type { Request } from 'express';
import axios from 'axios';
import {
  RegistryProxy,
  type RegistryConfig,
  type VersionMetadata,
} from './base.ts';

/** Upper bound on redirect hops when probing a revision's ivy.xml. */
const MAX_REDIRECTS = 3;

/**
 * Proxy for an Ivy-layout repository.
 *
 * Ivy lays artifacts out as
 * `{org}/{module}(/scala_{v})(/sbt_{v})/{revision}/{type}s/{artifact}(-{classifier}).{ext}`
 * — for example
 * `/ch.epfl.scala/sbt-bloop/scala_2.12/sbt_1.0/1.5.6/ivys/ivy.xml`.
 *
 * Every request for a file under a revision is gated on that revision's age,
 * read from the `Last-Modified` of its `ivys/ivy.xml`. Everything else is passed
 * through.
 *
 * **The directory index is not filtered.** Ivy has no document listing the
 * revisions of a module — a client discovers them by reading the repository's
 * HTML directory index, which is presentation, not protocol: the format differs
 * between Artifactory, Nexus 2, Nexus 3 and Clojars, and would have to be
 * chased as each of them changes it. So it is passed through.
 *
 * The cooldown still holds for a dynamic revision, by refusing the artifact
 * rather than by steering the choice. Measured with Coursier 2.1.25 against
 * sbt-plugin-releases: it reads the listing, picks one revision, requests that
 * revision's ivy.xml, and stops at the 404 — it does not try the next one. A
 * revision inside the window therefore cannot be taken silently. It also does
 * not fall back to an older allowed revision, so a build on
 * `latest.integration` breaks until the newest revision ages out. Which
 * revision gets picked is the resolver's own version ordering, not the
 * listing's: in that run Coursier asked for `1.3.4+151-7c324c7c` while the
 * listing ended at `1.3.4+160-681434ff`.
 *
 * Malicious/allowlist lookups use the shared "maven" ecosystem, since OSV tracks
 * JVM artifacts there regardless of repository layout.
 */
export class IvyRegistryProxy extends RegistryProxy {
  readonly name: string;

  constructor(config: RegistryConfig) {
    super(config);
    this.name = config.name ?? 'ivy';
  }

  protected override get dbKey(): string {
    return 'maven';
  }

  protected setRouting() {
    this.addDownloadRoute({
      condition: (req) => isIvyDownloadPath(req.path),
      getVersionMetadata: (req) => this.getDownloadVersionMetadata(req),
    });
  }

  private async getDownloadVersionMetadata(
    req: Request,
  ): Promise<VersionMetadata | null> {
    const parsed = parseIvyDownloadPath(req.path);
    if (!parsed) return null;
    const { modulePath, revision } = parsed;
    const base = this.config.upstream.replace(/\/$/, '');
    // Follow redirects: repo.scala-sbt.org and repo.typesafe.com both 302 to
    // the Artifactory instance that actually holds the file.
    const res = await axios.head(
      `${base}${modulePath}/${revision}/ivys/ivy.xml`,
      { validateStatus: () => true, maxRedirects: MAX_REDIRECTS },
    );
    if (res.status !== 200) return null;
    const lastModified = res.headers['last-modified'];
    if (typeof lastModified !== 'string') return null;
    const published = new Date(lastModified);
    if (Number.isNaN(published.getTime())) return null;
    return {
      packageName: packageNameFromPath(modulePath),
      version: revision,
      published,
    };
  }
}

/**
 * True for `{...}/{revision}/{type}s/{file}` — the shape of every Ivy artifact
 * fetch. The `{type}s` segment is Ivy's artifact-type directory (`ivys`, `jars`,
 * `poms`, `srcs`, `docs`, …).
 */
function isIvyDownloadPath(path: string): boolean {
  const parts = path.split('/').filter(Boolean);
  if (parts.length < 4) return false;
  return /^[a-z]+s$/.test(parts[parts.length - 2]!);
}

/**
 * Split an Ivy artifact path into the module directory and the revision.
 *
 * `/ch.epfl.scala/sbt-bloop/scala_2.12/sbt_1.0/1.5.6/ivys/ivy.xml`
 *   -> modulePath: "/ch.epfl.scala/sbt-bloop/scala_2.12/sbt_1.0", revision: "1.5.6"
 */
function parseIvyDownloadPath(
  path: string,
): { modulePath: string; revision: string } | null {
  const parts = path.split('/').filter(Boolean);
  if (parts.length < 4) return null;
  const revision = parts[parts.length - 3]!;
  const modulePath = `/${parts.slice(0, -3).join('/')}`;
  return { modulePath, revision };
}

/**
 * Build the malicious/allowlist lookup key from a module path.
 *
 * Ivy's first two segments are the organisation and the module; the optional
 * `scala_*` / `sbt_*` segments are cross-version qualifiers, not part of the
 * coordinate OSV records.
 */
function packageNameFromPath(path: string): string {
  const parts = path.split('/').filter(Boolean);
  const org = parts[0] ?? '';
  const module = parts[1] ?? '';
  return `${org}:${module}`;
}
