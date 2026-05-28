import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Request, Response } from "express";
import {
  RegistryProxy,
  __resetCachesForTesting,
  type VersionMetadata,
} from "./base.ts";
import { makeHandle, makeReq, makeRes } from "./test-helpers.ts";

vi.mock("axios", () => ({
  default: { get: vi.fn() },
}));

vi.mock("node:fs", () => ({
  readFileSync: vi.fn(),
}));

import axios from "axios";
const mockedGet = vi.mocked(axios.get);

import { readFileSync } from "node:fs";
const mockReadFileSync = vi.mocked(readFileSync);

// ── Metadata routing ──────────────────────────────────────────────────────────

class MetadataTestProxy extends RegistryProxy {
  readonly name = "meta-test";

  override setRouting() {
    this.addMetadataRoute({
      condition: (req) => !req.path.includes("/tarball/"),
      getVersions: () => [],
      filterMetadata: (m) => m,
    });
  }
}

const metaProxy = new MetadataTestProxy({
  upstream: "https://upstream.example.com",
  delayMs: 0,
  maliciousDbPath: "/dev/null",
});
const handle = makeHandle(metaProxy, mockedGet);

beforeEach(() => {
  vi.clearAllMocks();
  __resetCachesForTesting();
});

describe("RegistryProxy – metadata routing", () => {
  it("fetches upstream and returns filtered metadata on 200", async () => {
    const data = { name: "pkg", versions: {}, time: {}, "dist-tags": {} };
    const res = await handle("/pkg", data, 200);

    expect(mockedGet).toHaveBeenCalledWith(
      "https://upstream.example.com/pkg",
      expect.objectContaining({ validateStatus: expect.any(Function) }),
    );
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(data);
  });

  it("proxies non-200 status and body without filtering", async () => {
    const data = { error: "not_found", reason: "document not found" };
    const res = await handle("/nonexistent", data, 404);

    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.send).toHaveBeenCalledWith(data);
  });

  it("forwards Location header on redirect, stripping domain when it matches upstream", async () => {
    mockedGet.mockResolvedValue({
      status: 302,
      data: "",
      headers: {
        "content-type": "text/html",
        location: "https://upstream.example.com/pkg/redirected?q=1",
      },
    });
    const res = makeRes();
    await metaProxy.handleRequest(makeReq("/pkg"), res);

    expect(res.set).toHaveBeenCalledWith("location", "/meta-test/pkg/redirected?q=1");
    expect(res.status).toHaveBeenCalledWith(302);
  });

  it("forwards Location header as-is when domain differs from upstream", async () => {
    mockedGet.mockResolvedValue({
      status: 301,
      data: "",
      headers: {
        "content-type": "text/html",
        location: "https://other.example.com/pkg/somewhere",
      },
    });
    const res = makeRes();
    await metaProxy.handleRequest(makeReq("/pkg"), res);

    expect(res.set).toHaveBeenCalledWith(
      "location",
      "https://other.example.com/pkg/somewhere",
    );
    expect(res.status).toHaveBeenCalledWith(301);
  });

  it("forwards relative Location header as-is", async () => {
    mockedGet.mockResolvedValue({
      status: 302,
      data: "",
      headers: {
        "content-type": "text/html",
        location: "/relative/path",
      },
    });
    const res = makeRes();
    await metaProxy.handleRequest(makeReq("/pkg"), res);

    expect(res.set).toHaveBeenCalledWith("location", "/relative/path");
    expect(res.status).toHaveBeenCalledWith(302);
  });

  it("does not forward request headers to upstream", async () => {
    const data = { name: "pkg", versions: {}, time: {}, "dist-tags": {} };
    mockedGet.mockResolvedValue({ status: 200, data, headers: {} });

    const req = makeReq("/pkg", {
      accept: "application/vnd.npm.install-v1+json",
      "accept-encoding": "gzip",
      authorization: "Bearer secret-token",
      "x-custom-header": "should-not-forward",
    });

    await metaProxy.handleRequest(req, makeRes());

    const forwardedHeaders = mockedGet.mock.calls[0][1]?.headers as
      | Record<string, string>
      | undefined;
    expect(forwardedHeaders).toBeUndefined();
  });
});

describe("RegistryProxy – passthrough", () => {
  it("redirects to the upstream URL with 302", async () => {
    const res = makeRes();
    await metaProxy.handleRequest(makeReq("/pkg/tarball/pkg-1.0.0.tgz"), res);

    expect(res.redirect).toHaveBeenCalledWith(
      302,
      "https://upstream.example.com/pkg/tarball/pkg-1.0.0.tgz",
    );
    expect(mockedGet).not.toHaveBeenCalled();
  });

  it("preserves query string in redirect URL", async () => {
    const res = makeRes();
    await metaProxy.handleRequest(
      makeReq("/pkg/tarball/pkg-1.0.0.tgz?foo=bar"),
      res,
    );

    expect(res.redirect).toHaveBeenCalledWith(
      302,
      "https://upstream.example.com/pkg/tarball/pkg-1.0.0.tgz?foo=bar",
    );
  });
});

// ── Download routing ─────────────────────────────────────────────────────────

const DELAY_MS = 7 * 24 * 60 * 60 * 1000;
const CUTOFF = new Date("2024-01-15T00:00:00Z");
const NOW = new Date(CUTOFF.getTime() + DELAY_MS);

class DownloadProxy extends RegistryProxy {
  readonly name = "dl-test";
  readonly getVersionMetadataFn = vi
    .fn<() => VersionMetadata | null>()
    .mockReturnValue(null);

  override setRouting() {
    this.addDownloadRoute({
      condition: (req) => req.path.startsWith("/pkg/-/"),
      getVersionMetadata: () => this.getVersionMetadataFn(),
    });
  }
}

class CustomBlockProxy extends RegistryProxy {
  readonly name = "dl-test";
  readonly respondBlockedFn = vi.fn<(res: Response, req: Request) => void>();

  override setRouting() {
    this.addDownloadRoute({
      condition: () => true,
      getVersionMetadata: () => ({
        packageName: "pkg",
        version: "1.0.0",
        published: new Date("2024-02-01T00:00:00Z"), // after cutoff → blocked
      }),
      respondBlocked: (res, req) => this.respondBlockedFn(res, req),
    });
  }
}

describe("RegistryProxy – download routing", () => {
  let dlProxy: DownloadProxy;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    mockReadFileSync.mockReset();
    __resetCachesForTesting();
    dlProxy = new DownloadProxy({
      upstream: "https://upstream.example.com",
      delayMs: DELAY_MS,
      maliciousDbPath: "/dev/null",
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("redirects to upstream when version passes the delay filter", async () => {
    dlProxy.getVersionMetadataFn.mockReturnValue({
      packageName: "pkg",
      version: "1.0.0",
      published: CUTOFF, // exactly at cutoff → allowed
    });
    const res = makeRes();
    await dlProxy.handleRequest(makeReq("/pkg/-/pkg-1.0.0.tgz"), res);
    expect(res.redirect).toHaveBeenCalledWith(
      302,
      "https://upstream.example.com/pkg/-/pkg-1.0.0.tgz",
    );
  });

  it("returns 404 when the version is too recent", async () => {
    dlProxy.getVersionMetadataFn.mockReturnValue({
      packageName: "pkg",
      version: "2.0.0",
      published: new Date("2024-02-01T00:00:00Z"), // after cutoff → blocked
    });
    const res = makeRes();
    await dlProxy.handleRequest(makeReq("/pkg/-/pkg-2.0.0.tgz"), res);
    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith({ error: "Version not allowed" });
    expect(res.redirect).not.toHaveBeenCalled();
  });

  it("returns 404 when the package is in the malicious DB", async () => {
    mockReadFileSync.mockReturnValue(
      JSON.stringify({ "dl-test": { maliciousPackages: ["pkg"], maliciousVersions: {} } }),
    );
    const maliciousProxy = new DownloadProxy({
      upstream: "https://upstream.example.com",
      delayMs: DELAY_MS,
      maliciousDbPath: "/dev/null",
    });
    maliciousProxy.getVersionMetadataFn.mockReturnValue({
      packageName: "pkg",
      version: "1.0.0",
      published: CUTOFF, // passes delay filter but package is malicious
    });
    const res = makeRes();
    await maliciousProxy.handleRequest(makeReq("/pkg/-/pkg-1.0.0.tgz"), res);
    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.redirect).not.toHaveBeenCalled();
  });

  it("returns 404 when the specific version is in the malicious DB", async () => {
    mockReadFileSync.mockReturnValue(
      JSON.stringify({
        "dl-test": { maliciousPackages: [], maliciousVersions: { pkg: ["1.0.0"] } },
      }),
    );
    const maliciousProxy = new DownloadProxy({
      upstream: "https://upstream.example.com",
      delayMs: DELAY_MS,
      maliciousDbPath: "/dev/null",
    });
    maliciousProxy.getVersionMetadataFn.mockReturnValue({
      packageName: "pkg",
      version: "1.0.0",
      published: CUTOFF, // passes delay filter but version is malicious
    });
    const res = makeRes();
    await maliciousProxy.handleRequest(makeReq("/pkg/-/pkg-1.0.0.tgz"), res);
    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.redirect).not.toHaveBeenCalled();
  });

  it("returns 404 when getVersionMetadata returns null", async () => {
    const res = makeRes();
    await dlProxy.handleRequest(makeReq("/pkg/-/pkg-1.0.0.tgz"), res);
    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.redirect).not.toHaveBeenCalled();
  });

  it("calls custom respondBlocked instead of default 404 when version is blocked", async () => {
    const customProxy = new CustomBlockProxy({
      upstream: "https://upstream.example.com",
      delayMs: DELAY_MS,
      maliciousDbPath: "/dev/null",
    });
    const res = makeRes();
    const req = makeReq("/pkg/-/pkg-1.0.0.tgz");
    await customProxy.handleRequest(req, res);
    expect(customProxy.respondBlockedFn).toHaveBeenCalledWith(res, req);
    expect(res.status).not.toHaveBeenCalled();
  });

  it("falls through to passthrough when condition does not match", async () => {
    const res = makeRes();
    await dlProxy.handleRequest(makeReq("/other/path"), res);
    expect(res.redirect).toHaveBeenCalledWith(
      302,
      "https://upstream.example.com/other/path",
    );
    expect(dlProxy.getVersionMetadataFn).not.toHaveBeenCalled();
  });
});

// ── Routing order ─────────────────────────────────────────────────────────────

describe("RegistryProxy – routing order", () => {
  const allowedMeta: VersionMetadata = {
    packageName: "pkg",
    version: "1.0.0",
    published: new Date(0), // far past → always passes delay filter
  };

  class DownloadFirstProxy extends RegistryProxy {
    readonly name = "order-test";
    override setRouting() {
      this.addDownloadRoute({
        condition: () => true,
        getVersionMetadata: () => allowedMeta,
      });
      this.addMetadataRoute({
        condition: () => true,
        getVersions: () => [],
        filterMetadata: (m) => m,
      });
    }
  }

  class MetadataFirstProxy extends RegistryProxy {
    readonly name = "order-test";
    override setRouting() {
      this.addMetadataRoute({
        condition: () => true,
        getVersions: () => [],
        filterMetadata: (m) => m,
      });
      this.addDownloadRoute({
        condition: () => true,
        getVersionMetadata: () => allowedMeta,
      });
    }
  }

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("download route registered first wins over overlapping metadata route", async () => {
    const p = new DownloadFirstProxy({
      upstream: "https://upstream.example.com",
      delayMs: 0,
      maliciousDbPath: "/dev/null",
    });
    const res = makeRes();
    await p.handleRequest(makeReq("/any"), res);
    expect(res.redirect).toHaveBeenCalledWith(
      302,
      "https://upstream.example.com/any",
    );
    expect(mockedGet).not.toHaveBeenCalled();
  });

  it("metadata route registered first wins over overlapping download route", async () => {
    mockedGet.mockResolvedValue({ status: 200, data: { ok: true }, headers: {} });
    const p = new MetadataFirstProxy({
      upstream: "https://upstream.example.com",
      delayMs: 0,
      maliciousDbPath: "/dev/null",
    });
    const res = makeRes();
    await p.handleRequest(makeReq("/any"), res);
    expect(res.json).toHaveBeenCalledWith({ ok: true });
    expect(res.redirect).not.toHaveBeenCalled();
  });
});

// ── Allowlist ────────────────────────────────────────────────────────────────

const MALICIOUS_PATH = "/test/malicious.json";
const ALLOWLIST_PATH = "/test/allowlist.json";

class AllowlistDownloadProxy extends RegistryProxy {
  readonly name = "al-test";
  readonly getVersionMetadataFn = vi
    .fn<() => VersionMetadata | null>()
    .mockReturnValue(null);

  override setRouting() {
    this.addDownloadRoute({
      condition: (req) => req.path.startsWith("/pkg/-/"),
      getVersionMetadata: () => this.getVersionMetadataFn(),
    });
  }
}

function mockDbFiles(opts: {
  malicious?: Record<string, unknown>;
  allowlist?: Record<string, unknown>;
}) {
  mockReadFileSync.mockImplementation((path: unknown) => {
    if (path === MALICIOUS_PATH) return JSON.stringify(opts.malicious ?? {});
    if (path === ALLOWLIST_PATH) return JSON.stringify(opts.allowlist ?? {});
    throw new Error(`unexpected readFileSync path: ${String(path)}`);
  });
}

describe("RegistryProxy – allowlist", () => {
  const RECENT = new Date(CUTOFF.getTime() + 1000); // after cutoff → normally filtered

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    mockReadFileSync.mockReset();
    __resetCachesForTesting();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("lets a recent version through when its package is allowlisted", async () => {
    mockDbFiles({
      allowlist: {
        "al-test": {
          allowlistedPackages: ["pkg"],
          allowlistedVersions: {},
        },
      },
    });
    const proxy = new AllowlistDownloadProxy({
      upstream: "https://upstream.example.com",
      delayMs: DELAY_MS,
      maliciousDbPath: MALICIOUS_PATH,
      allowlistDbPath: ALLOWLIST_PATH,
    });
    proxy.getVersionMetadataFn.mockReturnValue({
      packageName: "pkg",
      version: "1.0.0",
      published: RECENT,
    });
    const res = makeRes();
    await proxy.handleRequest(makeReq("/pkg/-/pkg-1.0.0.tgz"), res);

    expect(res.redirect).toHaveBeenCalledWith(
      302,
      "https://upstream.example.com/pkg/-/pkg-1.0.0.tgz",
    );
  });

  it("lets a recent version through when the specific version is allowlisted", async () => {
    mockDbFiles({
      allowlist: {
        "al-test": {
          allowlistedPackages: [],
          allowlistedVersions: { pkg: ["1.0.0"] },
        },
      },
    });
    const proxy = new AllowlistDownloadProxy({
      upstream: "https://upstream.example.com",
      delayMs: DELAY_MS,
      maliciousDbPath: MALICIOUS_PATH,
      allowlistDbPath: ALLOWLIST_PATH,
    });
    proxy.getVersionMetadataFn.mockReturnValue({
      packageName: "pkg",
      version: "1.0.0",
      published: RECENT,
    });
    const res = makeRes();
    await proxy.handleRequest(makeReq("/pkg/-/pkg-1.0.0.tgz"), res);

    expect(res.redirect).toHaveBeenCalledWith(
      302,
      "https://upstream.example.com/pkg/-/pkg-1.0.0.tgz",
    );
  });

  it("does not let a non-allowlisted version of a partially-allowlisted package through", async () => {
    mockDbFiles({
      allowlist: {
        "al-test": {
          allowlistedPackages: [],
          allowlistedVersions: { pkg: ["1.0.0"] },
        },
      },
    });
    const proxy = new AllowlistDownloadProxy({
      upstream: "https://upstream.example.com",
      delayMs: DELAY_MS,
      maliciousDbPath: MALICIOUS_PATH,
      allowlistDbPath: ALLOWLIST_PATH,
    });
    proxy.getVersionMetadataFn.mockReturnValue({
      packageName: "pkg",
      version: "1.0.1",
      published: RECENT,
    });
    const res = makeRes();
    await proxy.handleRequest(makeReq("/pkg/-/pkg-1.0.1.tgz"), res);

    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.redirect).not.toHaveBeenCalled();
  });

  it("does not bypass the malicious DB even when allowlisted", async () => {
    mockDbFiles({
      malicious: {
        "al-test": { maliciousPackages: ["pkg"], maliciousVersions: {} },
      },
      allowlist: {
        "al-test": {
          allowlistedPackages: ["pkg"],
          allowlistedVersions: {},
        },
      },
    });
    const proxy = new AllowlistDownloadProxy({
      upstream: "https://upstream.example.com",
      delayMs: DELAY_MS,
      maliciousDbPath: MALICIOUS_PATH,
      allowlistDbPath: ALLOWLIST_PATH,
    });
    proxy.getVersionMetadataFn.mockReturnValue({
      packageName: "pkg",
      version: "1.0.0",
      published: CUTOFF, // passes age filter, but malicious DB still applies
    });
    const res = makeRes();
    await proxy.handleRequest(makeReq("/pkg/-/pkg-1.0.0.tgz"), res);

    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.redirect).not.toHaveBeenCalled();
  });

  it("falls back to age-filter-only behaviour when allowlistDbPath is not set", async () => {
    mockReadFileSync.mockImplementation((path: unknown) => {
      if (path === MALICIOUS_PATH) return JSON.stringify({});
      throw new Error(`unexpected readFileSync path: ${String(path)}`);
    });
    const proxy = new AllowlistDownloadProxy({
      upstream: "https://upstream.example.com",
      delayMs: DELAY_MS,
      maliciousDbPath: MALICIOUS_PATH,
    });
    proxy.getVersionMetadataFn.mockReturnValue({
      packageName: "pkg",
      version: "1.0.0",
      published: RECENT,
    });
    const res = makeRes();
    await proxy.handleRequest(makeReq("/pkg/-/pkg-1.0.0.tgz"), res);

    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.redirect).not.toHaveBeenCalled();
  });

  it("handles missing ecosystem entry in the allowlist file gracefully", async () => {
    mockDbFiles({
      allowlist: {
        "other-ecosystem": {
          allowlistedPackages: ["pkg"],
          allowlistedVersions: {},
        },
      },
    });
    const proxy = new AllowlistDownloadProxy({
      upstream: "https://upstream.example.com",
      delayMs: DELAY_MS,
      maliciousDbPath: MALICIOUS_PATH,
      allowlistDbPath: ALLOWLIST_PATH,
    });
    proxy.getVersionMetadataFn.mockReturnValue({
      packageName: "pkg",
      version: "1.0.0",
      published: RECENT,
    });
    const res = makeRes();
    await proxy.handleRequest(makeReq("/pkg/-/pkg-1.0.0.tgz"), res);

    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.redirect).not.toHaveBeenCalled();
  });

  it("treats a missing allowlist file as no allowlist (does not crash)", async () => {
    mockReadFileSync.mockImplementation(() => {
      throw new Error("ENOENT: no such file");
    });
    const proxy = new AllowlistDownloadProxy({
      upstream: "https://upstream.example.com",
      delayMs: DELAY_MS,
      maliciousDbPath: MALICIOUS_PATH,
      allowlistDbPath: ALLOWLIST_PATH,
    });
    proxy.getVersionMetadataFn.mockReturnValue({
      packageName: "pkg",
      version: "1.0.0",
      published: CUTOFF, // passes age filter
    });
    const res = makeRes();
    await proxy.handleRequest(makeReq("/pkg/-/pkg-1.0.0.tgz"), res);

    expect(res.redirect).toHaveBeenCalledWith(
      302,
      "https://upstream.example.com/pkg/-/pkg-1.0.0.tgz",
    );
  });
});
