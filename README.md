# tengen

<p align="center">
  <img width="256" alt="tengen" src="https://github.com/user-attachments/assets/8b507bc1-31eb-43ce-b0c3-ae92d10c75ea" />
</p>

Package registry proxy that filters out new and known-malicious package versions.

New versions are hidden until they have been published for a configurable number of days, and any version listed in the [ossf/malicious-packages](https://github.com/ossf/malicious-packages) database is permanently blocked. This gives your environment time to detect supply chain attacks or regressions before they land.

## How it works

tengen sits between your package manager and the upstream registry. On each metadata request it:

1. **Filters by age** — strips versions published within `--delay-days` days so they are invisible to the package manager.
2. **Honours the allowlist** — packages or versions listed in the optional allowlist bypass the age filter, so first-party packages stay available immediately (the malicious-package check still applies).
3. **Blocks malicious versions** — checks the requested package and version against a local copy of the OSSF malicious-packages database and returns 404 for any match.
4. **Serves downloads** — artifact downloads (tarballs, JARs, wheels, etc.) for allowed versions are either redirected (307) to the upstream URL or streamed back through the proxy, depending on `--upstream-access`.

```
npm install foo / pip install bar / gem install baz / ...
  └─> tengen
        ├─> filters new versions (age > --delay-days)
        ├─> allows allowlisted packages/versions through the age filter
        ├─> blocks known-malicious versions (ossf/malicious-packages)
        └─> upstream registry (npmjs.org / pypi.org / rubygems.org / ...)
```

## Quick start

```sh
npm start                             # runs `tengen serve`
```

The proxy listens on `http://localhost:3000` by default. On startup `serve` builds a fresh malicious-package database into a temp file (unless `--malicious-db-path` points at an existing one).

## CLI

### `tengen serve`

Start the registry proxy server.

| Option                      | Default                                | Description                                                                                    |
| --------------------------- | -------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `-h, --host`                | `127.0.0.1`                            | Host address to bind on                                                                        |
| `-p, --port`                | `3000`                                 | Port to listen on                                                                              |
| `-d, --delay-days`          | `7`                                    | Exclude versions published within this many days                                               |
| `--upstream-access`        | `direct`                             | How downloads are served: `direct` (307 to upstream) or `proxied` (stream through the proxy)    |
| `--base-url`                | _(none)_                               | Absolute base URL (e.g. `https://tengen.example.com`); used to rewrite npm `dist.tarball` so clients fetch through the proxy. Required when using `proxied` mode |
| `--npm-upstream`            | `https://registry.npmjs.org`           | Upstream URL for npm                                                                           |
| `--pypi-upstream`           | `https://pypi.org`                     | Upstream URL for PyPI                                                                          |
| `--rubygems-upstream`       | `https://rubygems.org`                 | Upstream URL for RubyGems                                                                      |
| `--go-upstream`             | `https://proxy.golang.org`             | Upstream URL for Go module proxy                                                               |
| `--composer-upstream`       | `https://packagist.org`                | Upstream URL for Composer (Packagist)                                                          |
| `--maven-upstream`          | `https://repo.maven.apache.org/maven2` | Upstream URL for Maven Central                                                                 |
| `--maven-timestamp-source`  | `deps-dev`                             | Where the built-in Maven registry reads publish timestamps: `deps-dev` (Central only) or `last-modified`. Use `last-modified` when `--maven-upstream` points somewhere other than Central |
| `--maven-repo`              | _(none)_                               | Additional Maven repository as `<name>=<url>`, mounted at `/<name>` (repeatable). Always uses `last-modified` timestamps |
| `--ivy-repo`                | _(none)_                               | Ivy-layout repository as `<name>=<url>`, mounted at `/<name>` (repeatable). Gates downloads on the revision's `ivys/ivy.xml` |
| `--gradle-plugins-upstream` | `https://plugins.gradle.org/m2`        | Upstream URL for the Gradle Plugin Portal                                                      |
| `--malicious-db-path`       | _(built into a temp file)_             | Path to the combined malicious-package DB JSON; built into a temp file on startup when omitted |
| `--allowlist-db-path`       | _(none)_                               | Path to the combined allowlist JSON (per-registry exemptions from the age filter)              |

### `tengen build-malicious-db`

Download and build the malicious-package database.

| Option         | Default      | Description                                            |
| -------------- | ------------ | ------------------------------------------------------ |
| `-o, --output` | _(required)_ | Output path for the combined malicious-package DB JSON |

## Malicious-package database

tengen reads from a single combined JSON file built from the [ossf/malicious-packages](https://github.com/ossf/malicious-packages) OSV feed. The file holds every supported ecosystem keyed by registry name:

```jsonc
{
  "npm": {
    "maliciousPackages": ["evil-pkg"],
    "maliciousVersions": { "left-pad": ["9.9.9"] },
  },
  "pypi": { "maliciousPackages": [], "maliciousVersions": {} },
  "rubygems": { "maliciousPackages": [], "maliciousVersions": {} },
  "go": { "maliciousPackages": [], "maliciousVersions": {} },
  "composer": { "maliciousPackages": [], "maliciousVersions": {} },
  "maven": { "maliciousPackages": [], "maliciousVersions": {} },
}
```

- `maliciousPackages` — every version of these packages is blocked.
- `maliciousVersions` — only the listed versions are blocked.

```sh
# Build (requires internet access; set GITHUB_TOKEN for a higher rate limit)
GITHUB_TOKEN=ghp_xxx npm run build:malicious-db -- -o data/malicious-db.json
```

Then start the proxy with `--malicious-db-path data/malicious-db.json`, or omit the flag and let `serve` build a fresh copy into a temp file on startup. If the file cannot be read or has no entries for a registry, the malicious-package check is skipped for that registry and only the age filter applies.

## Allowlist

An optional allowlist exempts specific packages or versions from the age-delay filter — handy for internal/first-party packages you publish and want available immediately. Point the proxy at a combined JSON file with `--allowlist-db-path`. Same per-registry shape as the malicious DB:

```jsonc
{
  "npm": {
    "allowlistedPackages": ["@myorg/internal-lib"],
    "allowlistedVersions": { "left-pad": ["1.3.0"] },
  },
  "pypi": { "allowlistedPackages": [], "allowlistedVersions": {} },
}
```

- `allowlistedPackages` — every version of these packages bypasses the age filter.
- `allowlistedVersions` — only the listed versions bypass the age filter.

The malicious-package check still applies to allowlisted entries, so a version that is both allowlisted and known-malicious stays blocked.

## Upstream access

`--upstream-access` controls how artifact downloads (and other passthrough requests) reach the upstream:

- `direct` (default) — respond with a 307 pointing at the upstream URL, so the client downloads directly from the upstream registry.
- `proxied` — stream the upstream response back through the proxy. Use this when clients can only reach the proxy and must not talk to the upstream directly.

### Artifact URL rewriting and `--base-url`

Package metadata often embeds absolute artifact URLs that point at the upstream registry — npm's `dist.tarball` (e.g. `https://registry.npmjs.org/lodash/-/lodash-4.17.21.tgz`) and PyPI's Simple/JSON API file URLs (`https://files.pythonhosted.org/packages/...`). In `proxied` mode the upstream is unreachable, so the proxy rewrites these to absolute URLs that point at itself (`<base-url>/npm/...`, `<base-url>/pypi/...`) so clients fetch artifacts through the proxy rather than the unreachable upstream — the npm CLI rewrites the tarball host itself, but yarn, pnpm, and JSON-API consumers use the embedded URLs verbatim.

In `direct` mode the upstream is reachable, so all of these URLs (npm's `dist.tarball`, the PyPI Simple and JSON API file URLs) are left pointing at it and the client downloads directly from the upstream. Blocked versions are already removed from the filtered metadata, so only allowed artifacts are ever referenced.

The proxy needs to know its own externally-visible URL to build these links, so `--base-url` is **required** in `proxied` mode — startup fails with an error if it is missing. It must be an absolute URL — npm treats a relative `dist.tarball` as a local file path, so a root-relative path does not work:

```sh
tengen serve --upstream-access proxied --base-url https://tengen.example.com
```

## Package manager configuration

Point each package manager at the running proxy (default: `http://localhost:3000`).

#### npm

```sh
npm config set registry http://localhost:3000/npm
```

#### yarn classic (v1)

```sh
yarn config set registry http://localhost:3000/npm
```

#### yarn berry (v2+)

```sh
yarn config set npmRegistryServer http://localhost:3000/npm
```

#### pnpm

```sh
pnpm config set registry http://localhost:3000/npm
```

#### pip

```sh
pip config set global.index-url http://localhost:3000/pypi/simple/
```

#### uv

```toml
# uv.toml
index-url = "http://localhost:3000/pypi/simple/"
```

#### poetry

```toml
# pyproject.toml
[[tool.poetry.source]]
name = "tengen"
url  = "http://localhost:3000/pypi/simple/"
```

#### bundler

```ruby
# Gemfile
source "http://localhost:3000/rubygems"
```

#### go

```sh
go env -w GOPROXY=http://localhost:3000/go
```

#### composer

```sh
composer config repositories.tengen composer http://localhost:3000/composer
composer config repositories.packagist.org false
```

#### maven / gradle

See the [`examples/maven`](examples/maven/) and [`examples/gradle`](examples/gradle/) directories for ready-to-run configuration.

## Examples

The `examples/` directory contains a working demo that freezes the visible package universe at **2025-01-01** — versions published after that date are hidden.

Start the demo server:

```sh
cd examples
./run-server.sh
```

Then point your package manager at `http://localhost:3000`. Each subdirectory has a ready-to-run `install.sh`.

Available examples: `bundler`, `composer`, `go`, `gradle`, `maven`, `npm`, `pip`, `pnpm`, `poetry`, `uv`, `yarn-berry`, `yarn-classic`.

## Filtered paths per registry

### npm

| Path pattern                                  | Action                                                                |
| --------------------------------------------- | --------------------------------------------------------------------- |
| `/{package}` / `/@scope/{package}` (no `/-/`) | Filtered — version metadata                                           |
| `/{package}/-/{tarball}.tgz` (contains `/-/`) | Download — redirect to upstream if allowed; 404 if version is blocked |
| everything else                               | Passthrough                                                           |

### PyPI

| Path pattern                  | Action                                                                |
| ----------------------------- | --------------------------------------------------------------------- |
| `/simple/{name}`              | Filtered — Simple API (HTML or JSON)                                  |
| `/pypi/{name}/json`           | Filtered — JSON API (package-level metadata)                          |
| `/pypi/{name}/{version}/json` | Filtered — JSON API (version-specific metadata)                       |
| `/packages/...`               | Download — redirect to upstream if allowed; 404 if version is blocked |
| everything else               | Passthrough                                                           |

### RubyGems

| Path pattern                   | Action                                                                |
| ------------------------------ | --------------------------------------------------------------------- |
| `/info/{name}`                 | Filtered — Compact Index per-gem info                                 |
| `/api/v1/versions/{name}.json` | Filtered — JSON versions API                                          |
| `/gems/{name}-{version}.gem`   | Download — redirect to upstream if allowed; 404 if version is blocked |
| `/versions`                    | Proxied directly (compact index protocol)                             |
| everything else                | Passthrough                                                           |

### Go module

| Path pattern                        | Action                                                                |
| ----------------------------------- | --------------------------------------------------------------------- |
| `/{module}/@v/list`                 | Filtered — version list                                               |
| `/{module}/@latest`                 | Filtered — latest version info                                        |
| `/{module}/@v/{version}.(zip\|mod)` | Download — redirect to upstream if allowed; 404 if version is blocked |
| everything else                     | Passthrough                                                           |

### Composer

| Path pattern                      | Action                                                   |
| --------------------------------- | -------------------------------------------------------- |
| `/packages.json`                  | Filtered — registry root (URL fields rewritten to proxy) |
| `/p2/{vendor}/{package}.json`     | Filtered — package metadata                              |
| `/p2/{vendor}/{package}~dev.json` | Filtered — dev-channel metadata                          |
| everything else                   | Passthrough                                              |

### Maven

| Path pattern                                            | Action                                                                |
| ------------------------------------------------------- | --------------------------------------------------------------------- |
| `/{group/as/path}/{artifactId}/maven-metadata.xml`      | Filtered — version metadata XML                                       |
| `/{...}/maven-metadata.xml.{sha1,md5,sha256,sha512}`    | Checksum recomputed over the filtered XML                             |
| `/{...}/{version}/maven-metadata.xml`                   | Filtered — a snapshot's timestamped build; served whole or 404'd       |
| `/{group/as/path}/{artifactId}/{version}/{file}`        | Download — redirect to upstream if allowed; 404 if version is blocked |
| everything else                                         | Passthrough                                                           |

**Metadata redirects are followed, never forwarded.** A Maven repository may answer `maven-metadata.xml` with a redirect rather than the document — `repo.scala-sbt.org/scalasbt/maven-releases` 302s to Central, `maven.google.com` 301s to `dl.google.com`, the Gradle Plugin Portal 303s to the hosting repo for a plugin's backing module. Handing that redirect to the client would send it to the upstream and skip the age and malicious filters entirely, so the hops (301, 302, 303, 307, 308) are followed server-side and the document they land on is filtered as usual. A relative `Location` is resolved against the request URL, as HTTP requires. A chain longer than three hops is answered with 502 rather than forwarded, for the same reason.

**Checksums are recomputed, never forwarded.** The metadata served here is filtered, so the upstream's checksum would not match it. All four algorithms a Maven client may ask for (`sha1`, `md5`, `sha256`, `sha512`) are computed over the filtered document; Maven 3.9 and Gradle both use the SHA-2 ones.

**Snapshots.** A `-SNAPSHOT` version has a second `maven-metadata.xml` inside its version directory describing one timestamped build. Its `<lastUpdated>` (or `<snapshot><timestamp>`) is the build's time, so no external lookup is needed — the document is served whole when that build is past the cooldown and 404'd when it is not. A snapshot under active development is therefore unavailable until its latest build ages, which is what a cooldown means for a mutable version; use the allowlist for exceptions. On the artifact-level listing, a `-SNAPSHOT` entry is probed through that same version-directory `maven-metadata.xml` rather than a `{artifact}-{version}.pom`, which snapshots do not have.

> **Note:** `maven-metadata.xml` does not include publication timestamps, so version timestamps are fetched from the [deps.dev API](https://api.deps.dev/) (`api.deps.dev`). This external call is made regardless of the `--maven-upstream` setting.

### Additional Maven repositories

deps.dev only indexes Maven Central, so the built-in `/maven` route is Central-only by default. Other Maven-layout repositories are declared with a repeatable `--maven-repo <name>=<url>` and mounted at their own top-level path:

```sh
tengen serve \
  --maven-repo sbt-releases=https://repo.scala-sbt.org/scalasbt/maven-releases \
  --maven-repo scala-nightlies=https://repo.scala-lang.org/artifactory/maven-nightlies
```

`/sbt-releases/...` and `/scala-nightlies/...` then behave exactly like `/maven/...` — same routing, metadata filtering and download gating.

Names must be a single lowercase path segment and cannot shadow a built-in registry (`npm`, `pypi`, `rubygems`, `go`, `composer`, `maven`, `gradle-plugins`).

**Timestamps outside Central.** These repositories read each version's publish time from the `Last-Modified` header of its POM instead of deps.dev.

`<lastUpdated>` records when the metadata was last rewritten, which is when its newest version appeared, so when that is already past the cooldown every version in the document is older still and none are probed — the common case costs no extra requests at all. Otherwise something landed inside the window and every version is probed, in parallel and through a short-lived cache.

Every version, not just the newest few: `<versions>` is **not** in publication order. A maintenance release lands after the next minor's first prerelease, and `org.apache.logging.log4j:log4j-core` ends its list at a 2024 prerelease while its newest release is from 2026 — so walking the list and stopping at the first old entry would let newer ones through. That matters most for exactly the releases a cooldown is meant to catch, since a security patch to a maintenance branch lands out of order by construction.

Two caveats:

- `Last-Modified` is the file's mtime on the upstream, not a publication date, and the two can be far apart. Artifactory-backed repositories rewrite it on re-sync: within a single version of `ch.epfl.scala:sbt-bloop` on `repo.scala-sbt.org`, `ivy.xml` reports 2018 and the jar reports 2021. Files of the same version need not agree. It is nonetheless the only per-version timestamp a plain Maven repository exposes, and it is monotonic enough for a cooldown of days — just don't read it as provenance.
- A version whose `Last-Modified` cannot be read is treated as unknown and excluded, the same as with a missing deps.dev record.
- Ties are normal: a repository that re-syncs stamps every file with the same mtime. When the filtered `<latest>` has to be chosen among versions sharing a timestamp, the document's own ordering decides, where Maven puts the newest last.

The same applies to the built-in route when `--maven-upstream` is pointed somewhere other than Central — pass `--maven-timestamp-source last-modified` in that case, otherwise every version comes back unknown and the metadata is served empty.

### Ivy repositories

sbt's built-in resolver set includes three Ivy-layout repositories, so proxying sbt means handling Ivy as well. Declare them with a repeatable `--ivy-repo <name>=<url>`:

```sh
tengen serve \
  --ivy-repo sbt-plugins=https://repo.scala-sbt.org/scalasbt/sbt-plugin-releases \
  --ivy-repo typesafe-ivy=https://repo.typesafe.com/typesafe/ivy-releases
```

Ivy lays artifacts out as `{org}/{module}(/scala_{v})(/sbt_{v})/{revision}/{type}s/{artifact}(-{classifier}).{ext}`, e.g. `/ch.epfl.scala/sbt-bloop/scala_2.12/sbt_1.0/1.3.4/ivys/ivy.xml`.

| Path pattern                                   | Action                                                            |
| ---------------------------------------------- | ----------------------------------------------------------------- |
| `/{org}/{module}/…/{revision}/{type}s/{file}`  | Gated on the revision's `ivys/ivy.xml`; 404 if inside the cooldown |
| everything else                                | Passthrough                                                        |

The revision's age comes from one HEAD of its `ivys/ivy.xml`. Redirects are followed: `repo.scala-sbt.org` and `repo.typesafe.com` both 302 to the Artifactory instance that holds the file.

**Dynamic revisions are not filtered.** Ivy has no document listing a module's revisions — the equivalent of `maven-metadata.xml` does not exist. A client discovers them by reading the repository's HTML directory index, which is presentation rather than protocol: the format differs between Artifactory, Nexus 2, Nexus 3 and Clojars, and filtering it would mean tracking each of them as they change. So it is left alone.

A pinned revision is gated regardless, which is how sbt resolves in practice — measured against sbt 1.10.7, it requests `{org}/{module}/{rev}/ivys/ivy.xml` directly with no listing.

The cooldown still holds for a dynamic revision, by refusing the artifact rather than by steering the choice. Measured with Coursier 2.1.25 against `sbt-plugin-releases` at `--delay-days 4000`:

```
GET /{module}/sbt_1.0/                          307   the listing passes through
GET /{module}/sbt_1.0/{revision}/ivys/ivy.xml   404   the chosen revision is inside the window
Resolution error: not found
```

The resolver picks one revision, and on 404 it stops — it does not try the next one. So a revision inside the window cannot be taken silently; resolution fails instead. It also does not fall back to an older allowed revision, so a build pinned to `latest.integration` breaks until the newest revision ages out. Which revision gets picked is the resolver's own version ordering, not the listing's order: in that run Coursier asked for `1.3.4+151-7c324c7c` while the listing ended at `1.3.4+160-681434ff`.

Malicious and allowlist lookups use the shared `maven` ecosystem, since OSV tracks JVM artifacts there regardless of repository layout.

### Gradle Plugin Portal

Served under `/gradle-plugins`. The portal uses the same Maven m2 layout, so the path patterns and gating behaviour are identical to [Maven](#maven) above (including the deps.dev timestamp lookup — plugin marker artifacts are indexed there under the Maven ecosystem). Malicious-package and allowlist entries are read from the shared `maven` ecosystem key, since OSV tracks Gradle plugin artifacts as Maven artifacts.
