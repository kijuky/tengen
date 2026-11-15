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
| `--gradle-plugins-upstream` | `https://plugins.gradle.org/m2`        | Upstream URL for the Gradle Plugin Portal                                                      |
| `--registry`                | _(none)_                               | Registry as `<type>[:<name>]=<upstream>[,<upstream>...][;<key>=<value>...]` (repeatable). See [Registries](#registries---registry) |
| `--malicious-db-path`       | _(built into a temp file)_             | Path to the combined malicious-package DB JSON; built into a temp file on startup when omitted |
| `--allowlist-db-path`       | _(none)_                               | Path to the combined allowlist JSON (per-registry exemptions from the age filter)              |
| `--cache-dir`               | _(none)_                               | Directory to keep downloaded artifacts in. Disabled when unset. See [Download cache](#download-cache) |

### `tengen build-malicious-db`

Download and build the malicious-package database.

| Option         | Default      | Description                                            |
| -------------- | ------------ | ------------------------------------------------------ |
| `-o, --output` | _(required)_ | Output path for the combined malicious-package DB JSON |

## Registries (`--registry`)

The built-in registries (`npm`, `pypi`, `rubygems`, `go`, `composer`, `maven`, `gradle-plugins`) are always served, each at `/<name>` with its default upstream. `--registry` replaces one, or adds another:

```
--registry <type>[:<name>]=<upstream>[,<upstream>...][;<key>=<value>...]
```

| Part                       | Meaning                                                                                       | Example                                   |
| -------------------------- | --------------------------------------------------------------------------------------------- | ----------------------------------------- |
| `<type>`                   | `npm`, `pypi`, `rubygems`, `go`, `composer`, `maven`, `gradle-plugins` or `ivy`                | `maven`                                   |
| `:<name>`                  | The path it is mounted at. Defaults to the type, so it is only written for a second one       | `maven:internal` → `/internal`            |
| `<upstream>,<upstream>...` | Two or more make a group, searched in the order written (`maven` and `ivy` only)               |                                           |
| `#<key>=<value>`           | A setting for one upstream, in its URL fragment — never sent to the server                     | `…/sbt-plugin-releases#index=artifactory` |
| `;<key>=<value>`           | A setting for the whole registry                                                               | `;public-url=https://npm.example.com`     |

| Setting                                | Applies to              | Meaning                                                                                       |
| -------------------------------------- | ----------------------- | --------------------------------------------------------------------------------------------- |
| `#timestamps=deps-dev\|last-modified` | `maven`, `gradle-plugins` upstreams | Where publish timestamps come from. Defaults to `deps-dev` for Maven Central (`repo.maven.apache.org`, `repo1.maven.org`, Google's Central mirror) and the Gradle Plugin Portal, `last-modified` otherwise |
| `#index=artifactory`                   | `ivy` upstreams         | Serve filtered revision listings — see [Ivy repositories](#ivy-repositories)                  |
| `;public-url=<url>`                    | `npm`, `pypi`, `rubygems`, `go`, `composer` | See [Per-registry public URLs](#per-registry-public-urls)                 |

A setting a type does not use, a group of a type that cannot group, a name used twice — anything that would not take effect — stops tengen at startup rather than being ignored.

The `--<type>-upstream` flags are kept as a shorthand for `--registry <type>=<url>`. Setting the same registry both ways is refused.

```sh
tengen serve \
  --registry 'npm=https://registry.npmjs.org;public-url=https://npm.example.com' \
  --registry 'maven=https://repo.maven.apache.org/maven2,https://repo.scala-sbt.org/scalasbt/maven-releases,https://maven.google.com' \
  --registry 'ivy=https://repo.scala-sbt.org/scalasbt/sbt-plugin-releases#index=artifactory,https://repo.typesafe.com/typesafe/ivy-releases'
```

`;` and `#` have to be quoted in a shell; an exec-form `command:` in Compose passes them as written.

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

### Per-registry public URLs

tengen serves every registry under a path prefix (`/npm`, `/pypi`, …) and, with `--base-url`, rewrites artifact URLs to `<base-url>/<name>/...`. Those URLs end up in lockfiles, so they tie clients to tengen's layout.

To keep it out, put each registry on its own host, have a reverse proxy add the prefix, and give tengen that host with `;public-url=`:

```sh
tengen serve --upstream-access proxied --base-url https://tengen.example.com \
  --registry 'npm=https://registry.npmjs.org;public-url=https://npm.example.com'
```

```caddyfile
npm.example.com {
	rewrite * /npm{uri}
	reverse_proxy tengen:3000
}
```

npm's `dist.tarball` then becomes `https://npm.example.com/lodash/-/lodash-4.17.21.tgz` — the same shape as the upstream's, which any npm registry can serve. Upstream redirects that tengen relays for metadata (e.g. PyPI's name normalization) point under the public URL too. Artifact URLs are rewritten in either `--upstream-access` mode, since setting a public URL says clients should fetch through it.

Maven and Ivy registries take no public URL: their metadata holds no URLs — clients build artifact paths from the repository URL they are configured with — so serving one at the root of its own host already keeps tengen's path out of client configuration.

## Download cache

With `--cache-dir <path>`, an allowed artifact download is fetched through the proxy, stored, and served from disk afterwards. Only downloads are stored; metadata is still fetched and filtered on every request.

The cache sits behind the filters, so a stored artifact is judged again on every request:

- Each entry keeps the version it belongs to, and a hit is judged with that and the local malicious DB. The upstream is not asked, so stored artifacts stay available while it is unreachable.
- A stored artifact whose version is now in the malicious DB is refused with a 404 and removed from the cache.
- At startup, every stored artifact the malicious DB lists is removed. The DB is read once per process, so restarting after an update of the DB sweeps it.

Artifacts are stored whichever `--upstream-access` is set, since their bytes have to pass through the proxy. Maven and Ivy `-SNAPSHOT` versions are not stored, because the same path can be redeployed with new contents. Nothing is evicted; the cache grows with what is downloaded.

Each registry keeps its own subdirectory (`<cache-dir>/<registry name>`). Each entry is a data file and a JSON sidecar named by the SHA-256 of the request path.

```sh
tengen serve --cache-dir /data/cache
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

> **Note:** `maven-metadata.xml` does not include publication timestamps, so for Maven Central they are fetched from the [deps.dev API](https://api.deps.dev/) (`api.deps.dev`). An upstream on a Central mirror under another host needs `#timestamps=deps-dev` to keep using it.

### Maven groups and other repositories

A `maven` registry with more than one upstream is a group, like a repository group in Nexus: one URL for several repositories, so a client does not need to know which one holds what.

```sh
tengen serve --registry 'maven=https://repo.maven.apache.org/maven2,https://repo.scala-sbt.org/scalasbt/maven-releases,https://repo.clojars.org,https://maven.google.com'
```

- **Metadata** is fetched from every upstream at once, each filtered with its own timestamps, and merged. A version belongs to the first upstream that lists it: that is where a download of it comes from, so that upstream's verdict is the one that counts — a version blocked there is not offered on the strength of another upstream's copy.
- **A download** is served by the first upstream that holds the file, and dated by that upstream. If that upstream blocks it, or its date cannot be read, the answer is 404; it is not passed on to a later upstream's copy.
- An upstream without the metadata contributes nothing. When none has it, a failure other than 404 is passed on in preference to a 404.

A second Maven registry at its own path is declared with a name, e.g. `--registry 'maven:internal=https://m2.example.com'`.

**Timestamps outside Central.** An upstream other than Maven Central reads each version's publish time from the `Last-Modified` header of its POM instead of deps.dev.

`<lastUpdated>` records when the metadata was last rewritten, which is when its newest version appeared, so when that is already past the cooldown every version in the document is older still and none are probed — the common case costs no extra requests at all. Otherwise something landed inside the window and every version is probed, in parallel and through a short-lived cache.

Every version, not just the newest few: `<versions>` is **not** in publication order. A maintenance release lands after the next minor's first prerelease, and `org.apache.logging.log4j:log4j-core` ends its list at a 2024 prerelease while its newest release is from 2026 — so walking the list and stopping at the first old entry would let newer ones through. That matters most for exactly the releases a cooldown is meant to catch, since a security patch to a maintenance branch lands out of order by construction.

Two caveats:

- `Last-Modified` is the file's mtime on the upstream, not a publication date, and the two can be far apart. Artifactory-backed repositories rewrite it on re-sync: within a single version of `ch.epfl.scala:sbt-bloop` on `repo.scala-sbt.org`, `ivy.xml` reports 2018 and the jar reports 2021. Files of the same version need not agree. It is nonetheless the only per-version timestamp a plain Maven repository exposes, and it is monotonic enough for a cooldown of days — just don't read it as provenance.
- A version whose `Last-Modified` cannot be read is treated as unknown and excluded, the same as with a missing deps.dev record.
- Ties are normal: a repository that re-syncs stamps every file with the same mtime. When the filtered `<latest>` has to be chosen among versions sharing a timestamp, the document's own ordering decides, where Maven puts the newest last.

Which source an upstream uses is decided from its host, since deps.dev only indexes Central. A Central mirror under another host can say `#timestamps=deps-dev`, and any upstream can say `#timestamps=last-modified`.

### Ivy repositories

sbt's built-in resolver set includes three Ivy-layout repositories, so proxying sbt means handling Ivy as well. There is no built-in Ivy registry; declare one, as a group if there are several:

```sh
tengen serve \
  --registry 'ivy=https://repo.scala-sbt.org/scalasbt/sbt-plugin-releases#index=artifactory,https://repo.typesafe.com/typesafe/ivy-releases#index=artifactory'
```

In a group, a file is served by the first upstream that holds its revision (its `ivys/ivy.xml` answers), dated by that upstream; if that upstream blocks it or its date cannot be read, the answer is 404 rather than a later upstream's copy. Revision listings are merged across the upstreams with `#index=artifactory`, each filtered with its own dates; upstreams without one contribute no listing. An upstream that cannot list a module contributes nothing, and the listing is refused only when none can.

Ivy lays artifacts out as `{org}/{module}(/scala_{v})(/sbt_{v})/{revision}/{type}s/{artifact}(-{classifier}).{ext}`, e.g. `/ch.epfl.scala/sbt-bloop/scala_2.12/sbt_1.0/1.3.4/ivys/ivy.xml`.

| Path pattern                                   | Action                                                            |
| ---------------------------------------------- | ----------------------------------------------------------------- |
| `/{org}/{module}/…/{revision}/{type}s/{file}`  | Gated on the revision's `ivys/ivy.xml`; 404 if inside the cooldown |
| `/{org}/{module}/…/` (a revision listing)      | With `#index=artifactory`, generated with the allowed revisions only; otherwise passthrough |
| everything else                                | Passthrough                                                        |

The revision's age comes from one HEAD of its `ivys/ivy.xml`. Redirects are followed: `repo.scala-sbt.org` and `repo.typesafe.com` both 302 to the Artifactory instance that holds the file.

**Dynamic revisions need `index=artifactory`.** Ivy has no document listing a module's revisions — the equivalent of `maven-metadata.xml` does not exist. A client discovers them by reading the repository's directory index, which is HTML: presentation rather than protocol, differing between Artifactory, Nexus 2, Nexus 3 and Clojars. tengen does not read it. What it can do is answer that request itself from structured data, and `index=artifactory` says to.

A pinned revision is gated either way, which is how sbt resolves in practice — measured against sbt 1.10.7, it requests `{org}/{module}/{rev}/ivys/ivy.xml` directly with no listing.

#### Without an index

The cooldown still holds for a dynamic revision, but by refusing the artifact rather than by steering the choice. Measured with Coursier 2.1.25 against `sbt-plugin-releases` at `--delay-days 4000`:

```
GET /{module}/sbt_1.0/                          307   the listing passes through unfiltered
GET /{module}/sbt_1.0/{revision}/ivys/ivy.xml   404   the chosen revision is inside the window
Resolution error: not found
```

The resolver picks one revision, and on 404 it stops — it does not try the next one, and it does not fall back to an older allowed revision. So nothing inside the window is served, but a build on `latest.integration` breaks until the newest revision ages out.

#### With `index=artifactory`

tengen answers the listing itself with only the allowed revisions, so the resolver never sees one it cannot have:

```
GET /{module}/sbt_1.0/                          200   generated, 177 of the upstream's 381 revisions
GET /{module}/sbt_1.0/1.0.0-RC1+4-c5e24b66/…    307   the newest revision the listing offered
```

Only a directory that actually holds revisions is filtered. A path cannot say which one that is — `/ch.epfl.scala/sbt-bloop/` holds `scala_2.10` and `scala_2.12`, and `…/1.5.6/` holds `ivys` and `jars` — so the children decide: a child that dates is a revision. A directory whose children are not revisions is passed through untouched, because it has no revisions to hide:

```
GET /ch.epfl.scala/                             307   passthrough
GET /ch.epfl.scala/sbt-bloop/                   307   passthrough (cross-version directories)
GET /ch.epfl.scala/sbt-bloop/scala_2.12/        307   passthrough
GET /ch.epfl.scala/sbt-bloop/…/sbt_1.0/         200   filtered (this is where revisions live)
GET /ch.epfl.scala/sbt-bloop/…/1.5.6/           307   passthrough (ivys, jars)
```

If no child dates but the storage API says the children *do* hold artifact-type directories, they are revisions whose `ivy.xml` could not be read — that is answered with 502, never passed through. A directory whose revisions all sit inside the cooldown is a different case: they date fine, so the answer is a listing with nothing in it.

Same repository, same `--delay-days 3000`, Coursier resolved `latest.integration` to `1.0.0-RC1+4-c5e24b66` and fetched the jar.

The revision names come from Artifactory's storage API as JSON:

```
GET /artifactory/api/storage/{repo}/{path}
  -> { "children": [ { "uri": "/1.0.0", "folder": true }, … ], … }
```

Each revision is then dated by the same `ivys/ivy.xml` HEAD the download gate uses, so the listing and the gate can never disagree — the folder's own `lastModified` is *not* used, because Artifactory rewrites it on re-sync: one revision of `ch.epfl.scala:sbt-bloop` has a folder stamped 2021-04-14 holding an `ivy.xml` stamped 2019-11-06. Dating a listing therefore costs one HEAD per revision, bounded at 8 in flight and cached for 10 minutes.

The endpoint is resolved and verified at startup, not per request. Nothing about the URL's shape is assumed: Artifactory is commonly served under an `/artifactory` context path, but an on-prem deployment behind a reverse proxy can sit anywhere — including the host root — so where the API base ends and the repository key begins cannot be read off the URL. The configured URL is followed through its redirects (`repo.scala-sbt.org` and `repo.typesafe.com` both 302 to `scala.jfrog.io/artifactory/{repo}`), then every split of the resulting path is tried against the storage API and the one that answers with a readable `FolderInfo` wins. For `https://scala.jfrog.io/artifactory/sbt-plugin-releases` that rejects `apiBase=https://scala.jfrog.io, repo=artifactory` (404) and accepts `apiBase=…/artifactory, repo=sbt-plugin-releases`; for a reverse proxy publishing a repository at `https://repo.example.com/ivy-releases` the first split is already the right one. `api/system/version` is then read. Failure is fatal — a repository configured to filter its listings either can or tengen does not start:

```
  /ivy
    https://repo.scala-sbt.org/scalasbt/sbt-plugin-releases (index=artifactory via https://scala.jfrog.io/artifactory (Artifactory 7.178.1))
```

The option is neither version-pinned nor host-pinned: the fields used here — `children[].uri`, `children[].folder` — have been in `FolderInfo` since Artifactory 2.2.1 and still are in 7.x, and a version or a URL pattern in configuration could not tell you whether a particular deployment answers, which is what the startup probe checks instead. If the API stops answering or changes shape at runtime, a listing request returns 502 rather than an unfiltered list.

Which revision the resolver picks out of the listing is its own version ordering, not the listing's order: without an index, in the run above, Coursier asked for `1.3.4+151-7c324c7c` while the listing ended at `1.3.4+160-681434ff`.

Malicious and allowlist lookups use the shared `maven` ecosystem, since OSV tracks JVM artifacts there regardless of repository layout.

### Gradle Plugin Portal

Served under `/gradle-plugins`. The portal uses the same Maven m2 layout, so the path patterns and gating behaviour are identical to [Maven](#maven) above (including the deps.dev timestamp lookup — plugin marker artifacts are indexed there under the Maven ecosystem). Malicious-package and allowlist entries are read from the shared `maven` ecosystem key, since OSV tracks Gradle plugin artifacts as Maven artifacts.
