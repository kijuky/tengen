# tengen

Package registry proxy with version delay filtering.

New package versions are hidden until they've been published for a configurable number of days. This gives time to detect supply chain attacks or regressions before they reach your environment.

## How it works

tengen sits between your package manager and the upstream registry. When a metadata request comes in, it filters out versions newer than `--delay-days` days and adjusts `dist-tags` to point to the latest allowed version. Tarball downloads are streamed through unmodified.

```
npm install foo
  └─> tengen (filters new versions)
        └─> registry.npmjs.org
```

## Usage

```sh
npm start -- [options]
```

| Option             | Default                      | Description                                   |
| ------------------ | ---------------------------- | --------------------------------------------- |
| `-p, --port`       | `3000`                       | Port to listen on                             |
| `-u, --upstream`   | `https://registry.npmjs.org` | Upstream registry URL                         |
| `-d, --delay-days` | `7`                          | Hide versions published within this many days |
| `-h, --help`       |                              | Show help                                     |

### Example

```sh
# Proxy npm with a 14-day delay
npm start -- --delay-days 14
```

Then point your npm client at it:

```sh
npm install --registry http://localhost:3000/npm
# or
echo 'registry=http://localhost:3000/npm' >> .npmrc
```
