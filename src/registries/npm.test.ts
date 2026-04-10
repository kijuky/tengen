import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NpmRegistryProxy } from "./npm.ts";
import { makeHandle, responseBody } from "./test-helpers.ts";

vi.mock("axios", () => ({
  default: { get: vi.fn() },
}));

import axios from "axios";

const DELAY_MS = 7 * 24 * 60 * 60 * 1000;
const CUTOFF = new Date("2024-01-15T00:00:00Z");
const NOW = new Date(CUTOFF.getTime() + DELAY_MS);

const proxy = new NpmRegistryProxy({
  upstream: "https://registry.npmjs.org",
  delayMs: DELAY_MS,
});

const handle = makeHandle(proxy, vi.mocked(axios.get));

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("NpmRegistryProxy – routing", () => {
  it("routes metadata paths to metadata handler (not redirected)", async () => {
    const res = await handle("/lodash", {});
    expect(res.redirect).not.toHaveBeenCalled();
  });

  it("redirects tarball paths as passthrough", async () => {
    const res = await handle("/lodash/-/lodash-4.17.21.tgz", {});
    expect(res.redirect).toHaveBeenCalledWith(
      302,
      "https://registry.npmjs.org/lodash/-/lodash-4.17.21.tgz",
    );
  });
});

describe("NpmRegistryProxy – metadata filtering", () => {
  it("returns data unchanged when versions field is missing", async () => {
    const data = { name: "pkg", "dist-tags": { latest: "1.0.0" } };
    const res = await handle("/lodash", data);
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(data);
  });

  it("returns data unchanged when time field is missing", async () => {
    const data = {
      name: "pkg",
      "dist-tags": { latest: "1.0.0" },
      versions: { "1.0.0": {} },
    };
    const res = await handle("/lodash", data);
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(data);
  });

  it("filters out versions published after cutoff date", async () => {
    const data = {
      name: "pkg",
      "dist-tags": { latest: "1.0.0" },
      versions: { "1.0.0": {}, "1.1.0": {} },
      time: {
        created: "2023-01-01T00:00:00Z",
        modified: "2024-02-01T00:00:00Z",
        "1.0.0": "2024-01-01T00:00:00Z", // before cutoff -> allowed
        "1.1.0": "2024-02-01T00:00:00Z", // after cutoff -> filtered
      },
    };
    const res = await handle("/lodash", data);
    const result = responseBody(res);
    expect(Object.keys(result.versions as object)).toEqual(["1.0.0"]);
    expect(Object.keys(result.time as object)).toContain("1.0.0");
    expect(Object.keys(result.time as object)).not.toContain("1.1.0");
  });

  it("includes versions published exactly at the cutoff date", async () => {
    const data = {
      name: "pkg",
      "dist-tags": { latest: "1.0.0" },
      versions: { "1.0.0": {} },
      time: {
        created: "2023-01-01T00:00:00Z",
        modified: "2024-01-15T00:00:00Z",
        "1.0.0": "2024-01-15T00:00:00Z", // exactly at cutoff -> allowed
      },
    };
    const res = await handle("/lodash", data);
    const result = responseBody(res);
    expect(Object.keys(result.versions as object)).toEqual(["1.0.0"]);
  });

  it("preserves special time keys: created and modified", async () => {
    const data = {
      name: "pkg",
      "dist-tags": { latest: "1.0.0" },
      versions: { "1.0.0": {} },
      time: {
        created: "2023-01-01T00:00:00Z",
        modified: "2024-02-01T00:00:00Z",
        "1.0.0": "2024-01-01T00:00:00Z",
      },
    };
    const res = await handle("/lodash", data);
    const result = responseBody(res);
    expect((result.time as Record<string, string>).created).toBe(
      "2023-01-01T00:00:00Z",
    );
    expect((result.time as Record<string, string>).modified).toBe(
      "2024-02-01T00:00:00Z",
    );
  });

  it("redirects dist-tags to the latest allowed version when current tag is filtered", async () => {
    const data = {
      name: "pkg",
      "dist-tags": { latest: "1.2.0" },
      versions: { "1.0.0": {}, "1.1.0": {}, "1.2.0": {} },
      time: {
        created: "2023-01-01T00:00:00Z",
        modified: "2024-02-01T00:00:00Z",
        "1.0.0": "2024-01-01T00:00:00Z", // allowed
        "1.1.0": "2024-01-10T00:00:00Z", // allowed (newer of the two)
        "1.2.0": "2024-02-01T00:00:00Z", // filtered
      },
    };
    const res = await handle("/lodash", data);
    const result = responseBody(res);
    expect((result["dist-tags"] as Record<string, string>).latest).toBe(
      "1.1.0",
    );
  });

  it("keeps dist-tags that already point to allowed versions", async () => {
    const data = {
      name: "pkg",
      "dist-tags": { latest: "1.0.0", beta: "1.1.0" },
      versions: { "1.0.0": {}, "1.1.0": {} },
      time: {
        created: "2023-01-01T00:00:00Z",
        modified: "2024-01-10T00:00:00Z",
        "1.0.0": "2024-01-01T00:00:00Z", // allowed
        "1.1.0": "2024-01-10T00:00:00Z", // allowed
      },
    };
    const res = await handle("/lodash", data);
    const result = responseBody(res);
    expect((result["dist-tags"] as Record<string, string>).latest).toBe(
      "1.0.0",
    );
    expect((result["dist-tags"] as Record<string, string>).beta).toBe("1.1.0");
  });

  it("returns 404 when all versions are filtered out", async () => {
    const data = {
      name: "pkg",
      "dist-tags": { latest: "1.0.0" },
      versions: { "1.0.0": {} },
      time: {
        created: "2024-02-01T00:00:00Z",
        modified: "2024-02-01T00:00:00Z",
        "1.0.0": "2024-02-01T00:00:00Z", // after cutoff -> filtered
      },
    };
    const res = await handle("/lodash", data);
    expect(res.status).toHaveBeenCalledWith(404);
  });

  it("preserves other top-level package fields", async () => {
    const data = {
      name: "pkg",
      description: "A test package",
      readme: "some readme",
      "dist-tags": { latest: "1.0.0" },
      versions: { "1.0.0": {} },
      time: {
        created: "2023-01-01T00:00:00Z",
        modified: "2024-01-01T00:00:00Z",
        "1.0.0": "2024-01-01T00:00:00Z",
      },
    };
    const res = await handle("/lodash", data);
    const result = responseBody(res);
    expect(result.name).toBe("pkg");
    expect(result.description).toBe("A test package");
    expect(result.readme).toBe("some readme");
  });

  it("does not mutate the original data", async () => {
    const data = {
      name: "pkg",
      "dist-tags": { latest: "1.1.0" },
      versions: { "1.0.0": {}, "1.1.0": {} },
      time: {
        created: "2023-01-01T00:00:00Z",
        modified: "2024-02-01T00:00:00Z",
        "1.0.0": "2024-01-01T00:00:00Z",
        "1.1.0": "2024-02-01T00:00:00Z",
      },
    };
    const original = JSON.parse(JSON.stringify(data));
    await handle("/lodash", data);
    expect(data).toEqual(original);
  });

  it("proxies upstream non-200 status", async () => {
    const res = await handle("/lodash", { error: "not found" }, 404);
    expect(res.status).toHaveBeenCalledWith(404);
  });
});
