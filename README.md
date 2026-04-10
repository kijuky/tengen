# tengen

Package registry proxy with version delay filtering.

New package versions are hidden until they've been published for a configurable number of days. This gives time to detect supply chain attacks or regressions before they reach your environment.

## How it works

tengen sits between your package manager and the upstream registry. When a metadata request comes in, it filters out versions newer than `--delay-days` days and rewrites the response so that only allowed versions are visible. Artifact downloads (tarballs, JARs, wheels, etc.) are passed through as a 302 redirect to the upstream URL.

```
npm install foo / pip install bar / gem install baz / ...
  └─> tengen (filters new versions)
        └─> upstream registry (npmjs.org / pypi.org / rubygems.org / ...)
```

## Usage

```sh
npm start -- [options]
```

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

### Package manager configuration

Once tengen is running (default: `http://localhost:3000`), point each package manager at the proxy.

#### npm

```sh
npm config set registry http://localhost:3000/npm
```

#### pip

```sh
pip install <package> --index-url http://localhost:3000/pypi/simple/
```

#### go

```sh
go env -w GOPROXY=http://localhost:3000/go
```

For ready-to-run examples covering npm, pip, gem, bundler, go, composer, maven, gradle, and more, see the [`examples/`](examples/) directory.

### Example

The `examples/` directory contains a working demo that freezes the visible package universe at **2025-01-01** — versions published after that date are hidden.

Start the demo server:

```sh
cd examples
./run-server.sh
```

Then point your package manager at `http://localhost:3000`. Each subdirectory under `examples/` has a ready-to-run `install.sh`.

## Supported registries

| Registry  | Base path   | Package managers    | Upstream default                       |
| --------- | ----------- | ------------------- | -------------------------------------- |
| npm       | `/npm`      | npm, yarn, pnpm     | `https://registry.npmjs.org`           |
| PyPI      | `/pypi`     | pip, poetry, uv     | `https://pypi.org`                     |
| RubyGems  | `/rubygems` | gem, bundler        | `https://rubygems.org`                 |
| Go module | `/go`       | go                  | `https://proxy.golang.org`             |
| Composer  | `/composer` | composer            | `https://packagist.org`                |
| Maven     | `/maven`    | maven, gradle       | `https://repo.maven.apache.org/maven2` |

## Filtered paths per registry

### npm

| Path pattern                                  | Action                      |
| --------------------------------------------- | --------------------------- |
| `/{package}` / `/@scope/{package}` (no `/-/`) | Filtered — version metadata |
| `/{package}/-/{tarball}.tgz` (contains `/-/`) | Passthrough                 |

### PyPI

| Path pattern        | Action                                       |
| ------------------- | -------------------------------------------- |
| `/simple/{name}/`   | Filtered — Simple API (HTML or JSON)         |
| `/pypi/{name}/json` | Filtered — JSON API (package-level metadata) |
| everything else     | Passthrough                                  |

### RubyGems

| Path pattern                            | Action                                |
| --------------------------------------- | ------------------------------------- |
| `/info/{name}`                          | Filtered — Compact Index per-gem info |
| `/api/v1/versions/{name}.json`          | Filtered — JSON versions API          |
| everything else (including `/versions`) | Passthrough                           |

### Go module

| Path pattern        | Action                         |
| ------------------- | ------------------------------ |
| `/{module}/@v/list` | Filtered — version list        |
| `/{module}/@latest` | Filtered — latest version info |
| everything else     | Passthrough                    |

### Composer

| Path pattern                      | Action                                                   |
| --------------------------------- | -------------------------------------------------------- |
| `/packages.json`                  | Filtered — registry root (URL fields rewritten to proxy) |
| `/p2/{vendor}/{package}.json`     | Filtered — package metadata                              |
| `/p2/{vendor}/{package}~dev.json` | Filtered — dev-channel metadata                          |
| everything else                   | Passthrough                                              |

### Maven

| Path pattern                                            | Action                                   |
| ------------------------------------------------------- | ---------------------------------------- |
| `/{group/as/path}/{artifactId}/maven-metadata.xml`      | Filtered — version metadata XML          |
| `/{group/as/path}/{artifactId}/maven-metadata.xml.sha1` | Filtered — SHA1 checksum of filtered XML |
| `/{group/as/path}/{artifactId}/maven-metadata.xml.md5`  | Filtered — MD5 checksum of filtered XML  |
| everything else                                         | Passthrough                              |

> **Note:** `maven-metadata.xml` does not include publication timestamps, so version timestamps are fetched from the [Maven Central Search API](https://search.maven.org/) (`search.maven.org`). This external call is made regardless of the `--maven-upstream` setting.
