# tengen

Package registry proxy that filters out new and known-malicious package versions.

New versions are hidden until they have been published for a configurable number of days, and any version listed in the [ossf/malicious-packages](https://github.com/ossf/malicious-packages) database is permanently blocked. This gives your environment time to detect supply chain attacks or regressions before they land.

## How it works

tengen sits between your package manager and the upstream registry. On each metadata request it:

1. **Filters by age** — strips versions published within `--delay-days` days so they are invisible to the package manager.
2. **Blocks malicious versions** — checks the requested package and version against a local copy of the OSSF malicious-packages database and returns 404 for any match.
3. **Passes through downloads** — artifact downloads (tarballs, JARs, wheels, etc.) for allowed versions are proxied as a 302 redirect to the upstream URL.

```
npm install foo / pip install bar / gem install baz / ...
  └─> tengen
        ├─> filters new versions (age > --delay-days)
        ├─> blocks known-malicious versions (ossf/malicious-packages)
        └─> upstream registry (npmjs.org / pypi.org / rubygems.org / ...)
```

## Quick start

```sh
# 1. Build the malicious-package database (one-time, re-run to refresh)
npm run build:malicious-db

# 2. Start the proxy
npm start
```

The proxy listens on `http://localhost:3000` by default.

## Commands

```sh
tengen serve              # Start the registry proxy server
tengen build-malicious-db # Download and build the malicious-package database
```

### `tengen serve` options

| Option                | Default                                | Description                                      |
| --------------------- | -------------------------------------- | ------------------------------------------------ |
| `-h, --host`          | `127.0.0.1`                            | Host address to bind on                          |
| `-p, --port`          | `3000`                                 | Port to listen on                                |
| `-d, --delay-days`    | `7`                                    | Exclude versions published within this many days |
| `--npm-upstream`      | `https://registry.npmjs.org`           | Upstream URL for npm                             |
| `--pypi-upstream`     | `https://pypi.org`                     | Upstream URL for PyPI                            |
| `--rubygems-upstream` | `https://rubygems.org`                 | Upstream URL for RubyGems                        |
| `--go-upstream`       | `https://proxy.golang.org`             | Upstream URL for Go module proxy                 |
| `--composer-upstream` | `https://packagist.org`                | Upstream URL for Composer (Packagist)            |
| `--maven-upstream`    | `https://repo.maven.apache.org/maven2` | Upstream URL for Maven Central                   |

## Malicious-package database

tengen reads from `data/malicious/<ecosystem>.json` files that are built from the [ossf/malicious-packages](https://github.com/ossf/malicious-packages) OSV feed.

```sh
# Build (requires internet access; set GITHUB_TOKEN for a higher rate limit)
GITHUB_TOKEN=ghp_xxx npm run build:malicious-db
```

If the database files are absent, the malicious-package check is skipped and only the age filter applies.

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

## Supported registries

| Registry  | Base path   | Package managers | Upstream default                       |
| --------- | ----------- | ---------------- | -------------------------------------- |
| npm       | `/npm`      | npm, yarn, pnpm  | `https://registry.npmjs.org`           |
| PyPI      | `/pypi`     | pip, poetry, uv  | `https://pypi.org`                     |
| RubyGems  | `/rubygems` | bundler          | `https://rubygems.org`                 |
| Go module | `/go`       | go               | `https://proxy.golang.org`             |
| Composer  | `/composer` | composer         | `https://packagist.org`                |
| Maven     | `/maven`    | maven, gradle    | `https://repo.maven.apache.org/maven2` |

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

| Path pattern                                    | Action                                                                |
| ----------------------------------------------- | --------------------------------------------------------------------- |
| `/packages.json`                                | Filtered — registry root (URL fields rewritten to proxy)              |
| `/p2/{vendor}/{package}.json`                   | Filtered — package metadata                                           |
| `/p2/{vendor}/{package}~dev.json`               | Filtered — dev-channel metadata                                       |
| `/dist/{vendor}/{package}/{version}/{hash}.zip` | Download — redirect to upstream if allowed; 404 if version is blocked |
| everything else                                 | Passthrough                                                           |

### Maven

| Path pattern                                            | Action                                                                |
| ------------------------------------------------------- | --------------------------------------------------------------------- |
| `/{group/as/path}/{artifactId}/maven-metadata.xml`      | Filtered — version metadata XML                                       |
| `/{group/as/path}/{artifactId}/maven-metadata.xml.sha1` | Filtered — SHA1 checksum of filtered XML                              |
| `/{group/as/path}/{artifactId}/maven-metadata.xml.md5`  | Filtered — MD5 checksum of filtered XML                               |
| `/{group/as/path}/{artifactId}/{version}/{file}`        | Download — redirect to upstream if allowed; 404 if version is blocked |
| everything else                                         | Passthrough                                                           |

> **Note:** `maven-metadata.xml` does not include publication timestamps, so version timestamps are fetched from the [deps.dev API](https://api.deps.dev/) (`api.deps.dev`). This external call is made regardless of the `--maven-upstream` setting.
