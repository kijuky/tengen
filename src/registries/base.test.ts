import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Request, Response } from "express";
import { RegistryProxy, type VersionMetadata } from "./base.ts";
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
});
const handle = makeHandle(metaProxy, mockedGet);

beforeEach(() => {
  vi.clearAllMocks();
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
    dlProxy = new DownloadProxy({
      upstream: "https://upstream.example.com",
      delayMs: DELAY_MS,
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

  it("returns 403 when the version is too recent", async () => {
    dlProxy.getVersionMetadataFn.mockReturnValue({
      packageName: "pkg",
      version: "2.0.0",
      published: new Date("2024-02-01T00:00:00Z"), // after cutoff → blocked
    });
    const res = makeRes();
    await dlProxy.handleRequest(makeReq("/pkg/-/pkg-2.0.0.tgz"), res);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({ error: "Version not allowed" });
    expect(res.redirect).not.toHaveBeenCalled();
  });

  it("returns 403 when the package is in the malicious DB", async () => {
    mockReadFileSync.mockReturnValue(
      JSON.stringify({ maliciousPackages: ["pkg"], maliciousVersions: {} }),
    );
    const maliciousProxy = new DownloadProxy({
      upstream: "https://upstream.example.com",
      delayMs: DELAY_MS,
    });
    maliciousProxy.getVersionMetadataFn.mockReturnValue({
      packageName: "pkg",
      version: "1.0.0",
      published: CUTOFF, // passes delay filter but package is malicious
    });
    const res = makeRes();
    await maliciousProxy.handleRequest(makeReq("/pkg/-/pkg-1.0.0.tgz"), res);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.redirect).not.toHaveBeenCalled();
  });

  it("returns 403 when the specific version is in the malicious DB", async () => {
    mockReadFileSync.mockReturnValue(
      JSON.stringify({
        maliciousPackages: [],
        maliciousVersions: { pkg: ["1.0.0"] },
      }),
    );
    const maliciousProxy = new DownloadProxy({
      upstream: "https://upstream.example.com",
      delayMs: DELAY_MS,
    });
    maliciousProxy.getVersionMetadataFn.mockReturnValue({
      packageName: "pkg",
      version: "1.0.0",
      published: CUTOFF, // passes delay filter but version is malicious
    });
    const res = makeRes();
    await maliciousProxy.handleRequest(makeReq("/pkg/-/pkg-1.0.0.tgz"), res);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.redirect).not.toHaveBeenCalled();
  });

  it("returns 403 when getVersionMetadata returns null", async () => {
    const res = makeRes();
    await dlProxy.handleRequest(makeReq("/pkg/-/pkg-1.0.0.tgz"), res);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.redirect).not.toHaveBeenCalled();
  });

  it("calls custom respondBlocked instead of default 403 when version is blocked", async () => {
    const customProxy = new CustomBlockProxy({
      upstream: "https://upstream.example.com",
      delayMs: DELAY_MS,
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
    });
    const res = makeRes();
    await p.handleRequest(makeReq("/any"), res);
    expect(res.json).toHaveBeenCalledWith({ ok: true });
    expect(res.redirect).not.toHaveBeenCalled();
  });
});
