/**
 * build-malicious-db.ts
 *
 * Downloads the ossf/malicious-packages repository tarball and writes
 * one JSON file per ecosystem under data/malicious/.
 *
 * Usage:
 *   npm run build-malicious-db
 *   GITHUB_TOKEN=ghp_xxx npm run build-malicious-db   # higher rate limit
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGunzip } from 'node:zlib';
import { Readable, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { EcosystemOutput } from '../types.ts';

const REPO = 'ossf/malicious-packages';
const OSV_BASE = 'osv/malicious';

const SUPPORTED_ECOSYSTEMS = new Set([
  'go',
  'maven',
  'npm',
  'pypi',
  'rubygems',
]);

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUTPUT_DIR = join(__dirname, '..', '..', 'data', 'malicious');

// ── Types ────────────────────────────────────────────────────────────────────

interface OsvAffected {
  package: {
    ecosystem: string;
    name: string;
  };
  versions?: string[];
  ranges?: Array<{
    type: string;
    events: Array<{
      introduced?: string;
      fixed?: string;
      last_affected?: string;
    }>;
  }>;
}

interface OsvRecord {
  id: string;
  affected?: OsvAffected[];
}

interface PackageEntry {
  /** Exact versions confirmed malicious */
  versions: string[];
  /** True when all versions are affected (no upper bound in range) */
  allVersions: boolean;
  /** Version ranges (introduced/fixed pairs) for partial range cases */
  ranges: Array<{ introduced: string; fixed?: string }>;
  /** MAL IDs referencing this package */
  ids: string[];
}

type EcosystemDb = Record<string, PackageEntry>;
type MaliciousDb = Record<string, EcosystemDb>;

// ── Version comparison (ecosystem-agnostic) ──────────────────────────────────

/**
 * Known pre-release label weights (all negative = less than a numeric segment).
 * Covers semver, PEP 440, Maven, and common Ruby/NuGet conventions.
 */
const PRE_RELEASE_WEIGHT: Record<string, number> = {
  dev: -5,
  snapshot: -4,
  alpha: -3,
  a: -3,
  beta: -2,
  b: -2,
  m: -2,
  rc: -1,
  cr: -1,
  c: -1,
  preview: -1,
  pre: -1,
  post: 1, // PEP 440 post-release is *after* the release
};

/**
 * Split a version string into typed segments for comparison.
 * Strips a leading `v`/`V` prefix, then splits on `.`, `-`, and
 * letter↔digit boundaries (handles PEP 440 `1.0a1`, Maven `1.0-beta-1`, etc.)
 */
function splitVersion(v: string): Array<number | string> {
  return v
    .replace(/^[vV]/, '')
    .split(/[.\-]|(?<=\d)(?=[a-zA-Z])|(?<=[a-zA-Z])(?=\d)/)
    .filter(Boolean)
    .map((seg) => {
      const n = Number(seg);
      return Number.isInteger(n) ? n : seg.toLowerCase();
    });
}

function compareSegments(a: number | string, b: number | string): number {
  if (a === b) return 0;
  const aIsNum = typeof a === 'number';
  const bIsNum = typeof b === 'number';
  if (aIsNum && bIsNum) return (a as number) - (b as number);
  if (!aIsNum && !bIsNum) {
    const aw = PRE_RELEASE_WEIGHT[a as string];
    const bw = PRE_RELEASE_WEIGHT[b as string];
    if (aw !== undefined && bw !== undefined) return aw - bw;
    if (aw !== undefined) return aw;
    if (bw !== undefined) return -bw;
    return (a as string) < (b as string) ? -1 : 1;
  }
  // Mixed: a string pre-release label adjacent to a numeric release segment.
  // Pre-release label → that side is the smaller one.
  const strVal = aIsNum ? (b as string) : (a as string);
  const w = PRE_RELEASE_WEIGHT[strVal] ?? -1; // unknown strings treated as pre-release
  const strIsPreRelease = w < 0;
  return aIsNum ? (strIsPreRelease ? 1 : -1) : strIsPreRelease ? -1 : 1;
}

/**
 * Generic version comparator. Returns negative / zero / positive.
 * Works for semver, PEP 440, Maven, NuGet, crates.io, Go, RubyGems, etc.
 * Missing trailing segments default to 0 (so `1.0 == 1.0.0`).
 */
function versionCompare(a: string, b: string): number {
  if (a === b) return 0;
  const aParts = splitVersion(a);
  const bParts = splitVersion(b);
  const len = Math.max(aParts.length, bParts.length);
  for (let i = 0; i < len; i++) {
    const ai = i < aParts.length ? aParts[i] : 0;
    const bi = i < bParts.length ? bParts[i] : 0;
    const cmp = compareSegments(ai, bi);
    if (cmp !== 0) return cmp;
  }
  return 0;
}

/** True if version satisfies any of the given introduced/fixed ranges */
function inAnyRange(
  version: string,
  ranges: Array<{ introduced: string; fixed?: string }>,
): boolean {
  return ranges.some((range) => {
    if (versionCompare(version, range.introduced) < 0) return false;
    if (range.fixed !== undefined && versionCompare(version, range.fixed) >= 0)
      return false;
    return true;
  });
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function headers(): Record<string, string> {
  const h: Record<string, string> = {
    Accept: 'application/vnd.github.v3+json',
  };
  const token = process.env.GITHUB_TOKEN;
  if (token) h['Authorization'] = `Bearer ${token}`;
  return h;
}

async function githubFetch(url: string): Promise<Response> {
  const res = await fetch(url, { headers: headers() });
  if (res.status === 403 || res.status === 429) {
    const reset = res.headers.get('x-ratelimit-reset');
    const wait = reset
      ? Math.max(0, Number(reset) * 1000 - Date.now()) + 1000
      : 60_000;
    console.warn(`Rate limited. Waiting ${Math.round(wait / 1000)}s …`);
    await new Promise((r) => setTimeout(r, wait));
    return githubFetch(url);
  }
  return res;
}

/** Normalise ecosystem name to a safe lowercase filename stem */
function ecosystemKey(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/\./g, '') // crates.io → cratesio
    .replace(/\s+/g, '-');
}

// ── Core logic ───────────────────────────────────────────────────────────────

/**
 * Download the repository tarball and parse OSV records from it.
 * This avoids GitHub tree API limits that truncate large directories.
 */
async function downloadAndProcessTarball(db: MaliciousDb): Promise<void> {
  const url = `https://api.github.com/repos/${REPO}/tarball/main`;
  process.stdout.write('Downloading repository tarball …\n');
  const res = await githubFetch(url);
  if (!res.ok)
    throw new Error(`Tarball fetch failed: ${res.status} ${res.statusText}`);

  // Collect the gunzipped tar into memory
  // Cast needed: fetch's ReadableStream type differs slightly from Node's web stream type
  const nodeStream = Readable.fromWeb(
    res.body as Parameters<typeof Readable.fromWeb>[0],
  );
  const gunzip = createGunzip();
  const chunks: Buffer[] = [];
  await pipeline(
    nodeStream,
    gunzip,
    new Writable({
      write(chunk, _enc, cb) {
        chunks.push(Buffer.from(chunk));
        cb();
      },
    }),
  );

  let buf = Buffer.concat(chunks);
  process.stdout.write(
    `  Tarball size: ${(buf.length / 1024 / 1024).toFixed(1)} MB (uncompressed)\n\n`,
  );

  let parsed = 0;
  let skipped = 0;
  // PAX / GNU long-name overrides for the next entry
  let paxPath: string | null = null;

  process.stdout.write('Parsing records ...\n');
  while (buf.length >= 512) {
    // End-of-archive: two consecutive 512-byte zero blocks
    if (buf.every((b, i) => i >= 1024 || b === 0)) break;

    const header = buf.subarray(0, 512);
    if (header.subarray(0, 8).every((b) => b === 0)) break;
    buf = buf.subarray(512);

    const rawName = header
      .subarray(0, 100)
      .toString('utf8')
      .replace(/\0.*/, '');
    const sizeOctal = header
      .subarray(124, 136)
      .toString('ascii')
      .replace(/\0.*/, '')
      .trim();
    const size = parseInt(sizeOctal, 8) || 0;
    const typeFlag = String.fromCharCode(header[156]);

    const padded = Math.ceil(size / 512) * 512;
    const content = buf.subarray(0, size);
    buf = buf.subarray(padded);

    // PAX extended header (file-specific): extract "path" key
    if (typeFlag === 'x' || typeFlag === 'X') {
      const text = content.toString('utf8');
      for (const line of text.split('\n')) {
        const m = line.match(/^\d+ path=(.+)$/);
        if (m) paxPath = m[1];
      }
      continue;
    }

    // GNU long-name header
    if (typeFlag === 'L') {
      paxPath = content.toString('utf8').replace(/\0.*/, '');
      continue;
    }

    // Skip non-regular-file entries
    if (typeFlag !== '0' && typeFlag !== '\0' && typeFlag !== '') {
      paxPath = null;
      continue;
    }

    // Resolve final path (strip leading GitHub-added directory component)
    const fullPath = (paxPath ?? rawName).replace(/^[^/]+\//, '');
    paxPath = null;

    if (!fullPath.startsWith(`${OSV_BASE}/`) || !fullPath.endsWith('.json')) {
      continue;
    }

    try {
      const record = JSON.parse(content.toString('utf8')) as OsvRecord;
      mergeRecord(db, record);
      parsed++;
      if (parsed % 1000 === 0) {
        process.stdout.write(`\r  Parsed: ${parsed.toLocaleString()} records`);
      }
    } catch {
      skipped++;
    }
  }

  process.stdout.write(`\r  Parsed: ${parsed.toLocaleString()} records`);
  if (skipped > 0) process.stdout.write(`  (${skipped} skipped)`);
  process.stdout.write('\n');
}

function mergeRecord(db: MaliciousDb, record: OsvRecord): void {
  for (const affected of record.affected ?? []) {
    if (!affected.package?.ecosystem) {
      console.warn(`  Skipping record ${record.id} with missing ecosystem`);
      continue;
    }
    const eco = ecosystemKey(affected.package.ecosystem);
    if (!SUPPORTED_ECOSYSTEMS.has(eco)) continue;
    const name = affected.package.name;

    if (!db[eco]) db[eco] = {};
    if (!db[eco][name])
      db[eco][name] = { versions: [], allVersions: false, ranges: [], ids: [] };
    const entry = db[eco][name];

    if (!entry.ids.includes(record.id)) entry.ids.push(record.id);

    // Exact versions
    for (const v of affected.versions ?? []) {
      if (!entry.versions.includes(v)) entry.versions.push(v);
    }

    // Version ranges
    for (const range of affected.ranges ?? []) {
      let i = 0;
      while (i < range.events.length) {
        const ev = range.events[i];
        if (ev.introduced !== undefined) {
          const fixed = range.events[i + 1]?.fixed;
          if (fixed === undefined) {
            // No upper bound → all versions from `introduced` onwards
            entry.allVersions = true;
          } else {
            entry.ranges.push({ introduced: ev.introduced, fixed });
            i++; // skip the fixed event
          }
        }
        i++;
      }
    }
  }
}

// ── Registry version fetchers ────────────────────────────────────────────────

type VersionFetcher = (name: string) => Promise<string[]>;

const REGISTRY_FETCHERS: Record<string, VersionFetcher> = {
  npm: async (name) => {
    const res = await fetch(
      `https://registry.npmjs.org/${name.replace(/\//g, '%2F')}`,
    );
    if (!res.ok) return [];
    const data = (await res.json()) as { versions?: Record<string, unknown> };
    return Object.keys(data.versions ?? {});
  },

  pypi: async (name) => {
    const res = await fetch(
      `https://pypi.org/pypi/${encodeURIComponent(name)}/json`,
    );
    if (!res.ok) return [];
    const data = (await res.json()) as { releases?: Record<string, unknown> };
    return Object.keys(data.releases ?? {});
  },

  rubygems: async (name) => {
    const res = await fetch(
      `https://rubygems.org/api/v1/versions/${encodeURIComponent(name)}.json`,
    );
    if (!res.ok) return [];
    const data = (await res.json()) as Array<{ number: string }>;
    return data.map((v) => v.number);
  },

  go: async (name) => {
    const encoded = name.split('/').map(encodeURIComponent).join('/');
    const res = await fetch(`https://proxy.golang.org/${encoded}/@v/list`);
    if (!res.ok) return [];
    return (await res.text()).split('\n').filter(Boolean);
  },

  maven: async (name) => {
    // OSV maven name is "groupId:artifactId"
    const colon = name.indexOf(':');
    if (colon === -1) return [];
    const group = name.slice(0, colon);
    const artifact = name.slice(colon + 1);
    const q = encodeURIComponent(`g:"${group}" AND a:"${artifact}"`);
    const res = await fetch(
      `https://search.maven.org/solrsearch/select?q=${q}&core=gav&rows=200&wt=json`,
    );
    if (!res.ok) return [];
    const data = (await res.json()) as {
      response?: { docs?: Array<{ v: string }> };
    };
    return (data.response?.docs ?? []).map((d) => d.v);
  },
};

// ── Range expansion ──────────────────────────────────────────────────────────

/**
 * For every ecosystem that has a known registry fetcher, find packages that
 * have version ranges but no exact versions, query the registry for all
 * available versions, filter by the ranges, and populate `versions`.
 */
async function expandRanges(db: MaliciousDb): Promise<void> {
  const CONCURRENCY = 10;

  for (const [eco, ecoDb] of Object.entries(db)) {
    const fetcher = REGISTRY_FETCHERS[eco];
    if (!fetcher) continue;

    const toExpand = Object.entries(ecoDb).filter(
      ([, entry]) =>
        entry.versions.length === 0 &&
        !entry.allVersions &&
        entry.ranges.length > 0,
    );
    if (toExpand.length === 0) continue;

    process.stdout.write(
      `\nExpanding ranges for ${toExpand.length} ${eco} packages …\n`,
    );
    let done = 0;

    for (let i = 0; i < toExpand.length; i += CONCURRENCY) {
      const batch = toExpand.slice(i, i + CONCURRENCY);
      await Promise.all(
        batch.map(async ([name, entry]) => {
          try {
            const allVersions = await fetcher(name);
            if (allVersions.length === 0) {
              // Could not retrieve versions → conservatively treat as all affected
              entry.allVersions = true;
            } else {
              const matched = allVersions.filter((v) =>
                inAnyRange(v, entry.ranges),
              );
              if (matched.length > 0) entry.versions = matched;
            }
          } catch {
            // Fetch failed → conservatively treat as all affected
            entry.allVersions = true;
          } finally {
            done++;
            process.stdout.write(`\r  Progress: ${done}/${toExpand.length}`);
          }
        }),
      );
    }

    process.stdout.write('\n');
  }
}

async function writeDb(db: MaliciousDb): Promise<void> {
  await mkdir(OUTPUT_DIR, { recursive: true });

  const summary: Record<string, number> = {};

  for (const [eco, packages] of Object.entries(db).sort()) {
    const output: EcosystemOutput = {
      maliciousPackages: [],
      maliciousVersions: {},
    };
    for (const [name, entry] of Object.entries(packages)) {
      if (entry.allVersions) {
        output.maliciousPackages.push(name);
      } else {
        output.maliciousVersions[name] = entry.versions;
      }
    }
    const outPath = join(OUTPUT_DIR, `${eco}.json`);
    await writeFile(outPath, JSON.stringify(output, null, 2), 'utf-8');
    summary[eco] = Object.keys(packages).length;
    process.stdout.write(`  Wrote ${outPath}  (${summary[eco]} packages)\n`);
  }

  await writeFile(
    join(OUTPUT_DIR, 'index.json'),
    JSON.stringify(summary, null, 2),
    'utf-8',
  );
}

// ── Entry point ──────────────────────────────────────────────────────────────

async function buildMaliciousDB(): Promise<void> {
  process.stdout.write('=== build-malicious-db ===\n');

  const db: MaliciousDb = {};
  await downloadAndProcessTarball(db);
  await expandRanges(db);

  const totalPackages = Object.values(db).reduce(
    (s, eco) => s + Object.keys(eco).length,
    0,
  );
  process.stdout.write(
    `\nParsed ${totalPackages} unique malicious packages across ${Object.keys(db).length} ecosystems\n\n`,
  );

  await writeDb(db);
  process.stdout.write('\nDone! Database written to data/malicious/\n');
}

export { buildMaliciousDB };
