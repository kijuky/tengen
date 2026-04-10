import { describe, it, expect } from "vitest";
import { ComposerRegistryProxy } from "./composer.ts";

const proxy = new ComposerRegistryProxy({
  upstream: "https://packagist.org",
  delayMs: 7 * 24 * 60 * 60 * 1000,
});

const CUTOFF = new Date("2024-01-15T00:00:00Z");

function makeV2Version(version: string, time: string): Record<string, unknown> {
  return { version, version_normalized: version + ".0", time };
}

describe("ComposerRegistryProxy.filterMetadata (packages.json)", () => {
  it("rewrites all absolute URLs to relative paths", () => {
    const data = {
      "metadata-url": "https://repo.packagist.org/p2/%package%.json",
      "providers-url": "/p/%package%$%hash%.json",
      "metadata-changes-url": "https://packagist.org/metadata/changes.json",
      "notify-batch": "https://packagist.org/downloads/",
      search: "https://packagist.org/search.json?q=%query%&type=%type%",
      list: "https://packagist.org/packages/list.json",
      "providers-api": "https://packagist.org/providers/%package%.json",
      "security-advisories": {
        metadata: true,
        "api-url": "https://packagist.org/api/security-advisories/",
      },
      packages: [],
    };

    const result = proxy.filterMetadata(data, CUTOFF) as Record<
      string,
      unknown
    >;
    expect(result["metadata-url"]).toBe("/composer/p2/%package%.json");
    expect(result["providers-url"]).toBe("/composer/p/%package%$%hash%.json");
    expect(result["metadata-changes-url"]).toBe(
      "/composer/metadata/changes.json",
    );
    expect(result["notify-batch"]).toBe("/composer/downloads/");
    expect(result["search"]).toBe(
      "/composer/search.json?q=%query%&type=%type%",
    );
    expect(result["list"]).toBe("/composer/packages/list.json");
    expect(result["providers-api"]).toBe("/composer/providers/%package%.json");
    expect(
      (result["security-advisories"] as Record<string, unknown>)["api-url"],
    ).toBe("/composer/api/security-advisories/");
  });

  it("rewrites already-relative metadata-url to a proxy-prefixed path", () => {
    const data = {
      "metadata-url": "/p2/%package%.json",
      packages: [],
    };

    const result = proxy.filterMetadata(data, CUTOFF) as Record<
      string,
      unknown
    >;
    expect(result["metadata-url"]).toBe("/composer/p2/%package%.json");
  });
});

describe("ComposerRegistryProxy.filterMetadata (unrecognized)", () => {
  it("returns data unchanged when structure is unrecognized", () => {
    const data = { foo: "bar" };
    expect(proxy.filterMetadata(data, CUTOFF)).toBe(data);
  });
});

describe("ComposerRegistryProxy.filterMetadata (v2)", () => {
  it("filters out versions published after cutoff date", () => {
    const data = {
      packages: {
        "symfony/console": [
          makeV2Version("6.0.0", "2024-01-01T00:00:00Z"), // before -> allowed
          makeV2Version("6.1.0", "2024-02-01T00:00:00Z"), // after  -> filtered
        ],
      },
      minified: "composer/2.0",
    };

    const result = proxy.filterMetadata(data, CUTOFF) as typeof data;
    expect(result.packages["symfony/console"]).toHaveLength(1);
    expect(result.packages["symfony/console"][0].version).toBe("6.0.0");
  });

  it("includes versions published exactly at the cutoff date", () => {
    const data = {
      packages: {
        "symfony/console": [makeV2Version("6.0.0", "2024-01-15T00:00:00Z")],
      },
    };

    const result = proxy.filterMetadata(data, CUTOFF) as typeof data;
    expect(result.packages["symfony/console"]).toHaveLength(1);
  });

  it("propagates time through minified diff-chain before filtering (newest-first real-world format)", () => {
    // Packagist v2 minified: newest first, subsequent entries only carry changed fields.
    // v6.1.0 has time; v6.0.0 inherits it via propagateTime.
    const data = {
      packages: {
        "symfony/console": [
          // newest first (after cutoff → filtered out); carries time
          {
            version: "6.1.0",
            version_normalized: "6.1.0.0",
            time: "2024-02-01T00:00:00Z",
          },
          // older (before cutoff → kept); has its own time
          {
            version: "6.0.0",
            version_normalized: "6.0.0.0",
            time: "2024-01-01T00:00:00Z",
          },
        ],
      },
      minified: "composer/2.0",
    };

    const result = proxy.filterMetadata(data, CUTOFF) as Record<
      string,
      unknown
    >;
    const versions = (result["packages"] as Record<string, unknown[]>)[
      "symfony/console"
    ];
    expect(versions).toHaveLength(1);
    expect((versions[0] as Record<string, unknown>)["version"]).toBe("6.0.0");
  });

  it("returns null when all versions are filtered out", () => {
    const data = {
      packages: {
        "symfony/console": [
          makeV2Version("6.1.0", "2024-02-01T00:00:00Z"), // after cutoff
        ],
      },
    };

    expect(proxy.filterMetadata(data, CUTOFF)).toBeNull();
  });

  it("does not mutate the original data", () => {
    const data = {
      packages: {
        "symfony/console": [
          makeV2Version("6.0.0", "2024-01-01T00:00:00Z"),
          makeV2Version("6.1.0", "2024-02-01T00:00:00Z"),
        ],
      },
    };

    const original = JSON.parse(JSON.stringify(data));
    proxy.filterMetadata(data, CUTOFF);
    expect(data).toEqual(original);
  });
});
