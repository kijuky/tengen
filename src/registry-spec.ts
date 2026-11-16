/**
 * The registries a proxy serves, and the `--registry` syntax that declares them.
 *
 *   --registry <type>[:<name>]=<upstream>[,<upstream>...][;<key>=<value>...]
 *
 * - `<type>` is the kind of registry; `<name>` is the path it is mounted at and
 *   defaults to the type, so it only needs writing for a second registry of the
 *   same type.
 * - Two or more upstreams make a group, searched in the order written.
 * - Settings for one upstream go in its URL fragment (`#index=artifactory`). A
 *   fragment is never sent to the server, so it can carry these without
 *   changing what is requested.
 * - Settings for the whole registry follow a `;`.
 *
 * Anything that would not take effect — a key the type does not use, a group of
 * a type that cannot group — is refused rather than ignored.
 */

export const REGISTRY_TYPES = [
  "npm",
  "pypi",
  "rubygems",
  "go",
  "composer",
  "maven",
  "gradle-plugins",
  "ivy",
] as const;

export type RegistryType = (typeof REGISTRY_TYPES)[number];

export type TimestampSource = "deps-dev" | "last-modified";

export interface UpstreamSpec {
  url: string;
  /** Maven layouts: where publish timestamps are read from. */
  timestamps?: TimestampSource;
  /** Ivy: source for revision listings. */
  index?: "artifactory";
}

export interface RegistrySpec {
  type: RegistryType;
  /** Path the registry is mounted at (`/{name}`). */
  name: string;
  upstreams: UpstreamSpec[];
  /**
   * URL a reverse proxy serves this registry at, at the root of its own host.
   * See RegistryConfig.publicUrl.
   */
  publicUrl?: string;
}

/** Types whose upstreams can form a group. */
const GROUPABLE: ReadonlySet<RegistryType> = new Set(["maven", "ivy"]);

/**
 * Types whose responses carry URLs back to the proxy — artifact links in
 * metadata, or redirects relayed for it — and so can use a public URL. Maven
 * and Ivy metadata hold none: clients build artifact paths from the repository
 * URL they are configured with.
 */
const PUBLIC_URL_TYPES: ReadonlySet<RegistryType> = new Set([
  "npm",
  "pypi",
  "rubygems",
  "go",
  "composer",
]);

/** Upstream (fragment) settings each type accepts. */
const UPSTREAM_KEYS: Record<RegistryType, readonly string[]> = {
  npm: [],
  pypi: [],
  rubygems: [],
  go: [],
  composer: [],
  maven: ["timestamps"],
  "gradle-plugins": ["timestamps"],
  ivy: ["index"],
};

/**
 * Hosts serving Maven Central, whose versions deps.dev indexes. Any other Maven
 * repository has to be dated from its own `Last-Modified` headers.
 */
const MAVEN_CENTRAL_HOSTS: ReadonlySet<string> = new Set([
  "repo.maven.apache.org",
  "repo1.maven.org",
  "maven-central.storage-download.googleapis.com",
]);

/** Built-in registries and the upstream each one has when nothing is said. */
export const DEFAULT_UPSTREAMS: Readonly<
  Record<Exclude<RegistryType, "ivy">, string>
> = {
  npm: "https://registry.npmjs.org",
  pypi: "https://pypi.org",
  rubygems: "https://rubygems.org",
  go: "https://proxy.golang.org",
  composer: "https://packagist.org",
  maven: "https://repo.maven.apache.org/maven2",
  "gradle-plugins": "https://plugins.gradle.org/m2",
};

/** A mount name has to be a single safe path segment. */
const NAME_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;

export class RegistrySpecError extends Error {}

/**
 * Where a Maven-layout upstream's publish timestamps come from when its URL
 * does not say: deps.dev for Maven Central and for the Gradle Plugin Portal,
 * whose plugin markers deps.dev indexes too, and `Last-Modified` otherwise.
 */
export function defaultTimestampSource(
  type: RegistryType,
  url: string,
): TimestampSource {
  if (type === "gradle-plugins") return "deps-dev";
  return MAVEN_CENTRAL_HOSTS.has(new URL(url).hostname)
    ? "deps-dev"
    : "last-modified";
}

/** Parse one `--registry` value. Throws RegistrySpecError on anything wrong. */
export function parseRegistrySpec(raw: string): RegistrySpec {
  const separator = raw.indexOf("=");
  if (separator <= 0 || separator === raw.length - 1) {
    throw new RegistrySpecError(
      `invalid --registry '${raw}' (expected <type>[:<name>]=<upstream>[,<upstream>...][;<key>=<value>...])`,
    );
  }
  const head = raw.slice(0, separator).trim();
  const [body = "", ...settings] = raw.slice(separator + 1).split(";");

  const colon = head.indexOf(":");
  const typeText = colon < 0 ? head : head.slice(0, colon);
  const name = colon < 0 ? head : head.slice(colon + 1);
  if (!(REGISTRY_TYPES as readonly string[]).includes(typeText)) {
    throw new RegistrySpecError(
      `unknown registry type '${typeText}' in --registry '${raw}' (expected one of: ${REGISTRY_TYPES.join(", ")})`,
    );
  }
  const type = typeText as RegistryType;
  if (!NAME_PATTERN.test(name)) {
    throw new RegistrySpecError(
      `invalid registry name '${name}' in --registry '${raw}' (expected a lowercase path segment matching ${NAME_PATTERN})`,
    );
  }

  const urls = body
    .split(",")
    .map((u) => u.trim())
    .filter(Boolean);
  if (urls.length === 0) {
    throw new RegistrySpecError(`no upstream in --registry '${raw}'`);
  }
  if (urls.length > 1 && !GROUPABLE.has(type)) {
    throw new RegistrySpecError(
      `--registry '${raw}' lists ${urls.length} upstreams, but only ${[...GROUPABLE].join(" and ")} registries can group upstreams`,
    );
  }
  const upstreams = urls.map((url) => parseUpstream(type, url, raw));

  const spec: RegistrySpec = { type, name, upstreams };
  for (const setting of settings.map((s) => s.trim()).filter(Boolean)) {
    const eq = setting.indexOf("=");
    const key = eq < 0 ? setting : setting.slice(0, eq);
    const value = eq < 0 ? "" : setting.slice(eq + 1).trim();
    if (key !== "public-url") {
      throw new RegistrySpecError(
        `unknown setting '${key}' in --registry '${raw}' (expected: public-url)`,
      );
    }
    if (!PUBLIC_URL_TYPES.has(type)) {
      throw new RegistrySpecError(
        `public-url is not needed for a ${type} registry: its metadata holds no URLs, so serving it at the root of its own host already keeps tengen's path out of client configuration`,
      );
    }
    if (spec.publicUrl !== undefined) {
      throw new RegistrySpecError(
        `public-url is given twice in --registry '${raw}'`,
      );
    }
    spec.publicUrl = absoluteUrl(value, `public-url in --registry '${raw}'`);
  }
  return spec;
}

function parseUpstream(
  type: RegistryType,
  text: string,
  raw: string,
): UpstreamSpec {
  const hash = text.indexOf("#");
  const url = absoluteUrl(
    hash < 0 ? text : text.slice(0, hash),
    `upstream in --registry '${raw}'`,
  );
  const upstream: UpstreamSpec = { url };

  const allowed = UPSTREAM_KEYS[type];
  const fragment = hash < 0 ? "" : text.slice(hash + 1);
  for (const pair of fragment.split("&").filter(Boolean)) {
    const eq = pair.indexOf("=");
    const key = eq < 0 ? pair : pair.slice(0, eq);
    const value = eq < 0 ? "" : pair.slice(eq + 1);
    if (!allowed.includes(key)) {
      throw new RegistrySpecError(
        `unknown upstream setting '#${key}' for a ${type} registry in --registry '${raw}'` +
          (allowed.length > 0 ? ` (expected: ${allowed.join(", ")})` : ""),
      );
    }
    if (key === "timestamps") {
      if (value !== "deps-dev" && value !== "last-modified") {
        throw new RegistrySpecError(
          `invalid #timestamps=${value} in --registry '${raw}' (expected deps-dev or last-modified)`,
        );
      }
      upstream.timestamps = value;
    } else if (key === "index") {
      if (value !== "artifactory") {
        throw new RegistrySpecError(
          `invalid #index=${value} in --registry '${raw}' (expected artifactory)`,
        );
      }
      upstream.index = value;
    }
  }

  if (type === "maven" || type === "gradle-plugins") {
    upstream.timestamps ??= defaultTimestampSource(type, url);
  }
  return upstream;
}

/** Validate an absolute http(s) URL and drop any trailing slash. */
function absoluteUrl(text: string, what: string): string {
  const trimmed = text.trim();
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new RegistrySpecError(
      `invalid ${what}: '${trimmed}' (expected an absolute http(s) URL)`,
    );
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new RegistrySpecError(
      `invalid ${what}: '${trimmed}' (expected an absolute http(s) URL)`,
    );
  }
  return trimmed.replace(/\/+$/, "");
}

/**
 * The full list of registries: the built-in ones, each replaced by a
 * `--registry` of its type and default name or else set from its
 * `--<type>-upstream` flag, followed by the remaining `--registry` entries.
 *
 * A built-in set both ways is refused — which of the two was meant cannot be
 * told — as is a name used twice.
 */
export function resolveRegistries(
  declared: RegistrySpec[],
  upstreamFlags: Partial<Record<Exclude<RegistryType, "ivy">, string>>,
): RegistrySpec[] {
  const byName = new Map<string, RegistrySpec>();
  for (const spec of declared) {
    if (byName.has(spec.name)) {
      throw new RegistrySpecError(
        `registry name '${spec.name}' is declared more than once`,
      );
    }
    byName.set(spec.name, spec);
  }

  const registries: RegistrySpec[] = [];
  for (const [type, defaultUrl] of Object.entries(DEFAULT_UPSTREAMS) as [
    Exclude<RegistryType, "ivy">,
    string,
  ][]) {
    const declaredSpec = byName.get(type);
    const flag = upstreamFlags[type];
    if (declaredSpec) {
      if (declaredSpec.type !== type) {
        throw new RegistrySpecError(
          `registry name '${type}' is taken by the built-in ${type} registry; give the ${declaredSpec.type} registry another name`,
        );
      }
      if (flag !== undefined) {
        throw new RegistrySpecError(
          `the ${type} registry is set by both --${type}-upstream and --registry; use one`,
        );
      }
      registries.push(declaredSpec);
      byName.delete(type);
    } else {
      registries.push(
        parseRegistrySpec(`${type}=${flag ?? defaultUrl}`),
      );
    }
  }
  registries.push(...byName.values());
  return registries;
}
