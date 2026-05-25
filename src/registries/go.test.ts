import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { GoRegistryProxy } from "./go.ts";
import { makeHandle, makeReq, makeRes } from "./test-helpers.ts";

vi.mock("axios", () => ({
  default: { get: vi.fn() },
}));
vi.mock("node:fs", () => ({
  readFileSync: vi.fn(),
}));

import axios from "axios";
const mockedGet = vi.mocked(axios.get);
const mockReadFileSync = vi.mocked(readFileSync);

const proxy = new GoRegistryProxy({
  upstream: "https://proxy.golang.org",
  delayMs: 7 * 24 * 60 * 60 * 1000,
  maliciousDbPath: "/dev/null",
});

const handle = makeHandle(proxy, mockedGet);

// NOW = 2024-01-22 → cutoff = 2024-01-15
const NOW = new Date("2024-01-22T00:00:00Z");

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("GoRegistryProxy.handleRequest - /@v/list", () => {
  it("returns only versions published before or at cutoff", async () => {
    mockedGet
      .mockResolvedValueOnce({
        status: 200,
        data: "v1.0.0\nv1.1.0\n",
        headers: {},
      })
      .mockResolvedValueOnce({
        status: 200,
        data: { Version: "v1.0.0", Time: "2024-01-01T00:00:00Z" },
        headers: {},
      })
      .mockResolvedValueOnce({
        status: 200,
        data: { Version: "v1.1.0", Time: "2024-02-01T00:00:00Z" },
        headers: {},
      });

    const res = makeRes();
    await proxy.handleRequest(makeReq("/github.com/foo/bar/@v/list"), res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(vi.mocked(res.send)).toHaveBeenCalledWith("v1.0.0\n");
  });

  it("includes versions published exactly at cutoff", async () => {
    mockedGet
      .mockResolvedValueOnce({ status: 200, data: "v1.0.0\n", headers: {} })
      .mockResolvedValueOnce({
        status: 200,
        data: { Version: "v1.0.0", Time: "2024-01-15T00:00:00Z" },
        headers: {},
      });

    const res = makeRes();
    await proxy.handleRequest(makeReq("/github.com/foo/bar/@v/list"), res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(vi.mocked(res.send)).toHaveBeenCalledWith("v1.0.0\n");
  });

  it("returns 404 when all versions are after cutoff", async () => {
    mockedGet
      .mockResolvedValueOnce({ status: 200, data: "v1.1.0\n", headers: {} })
      .mockResolvedValueOnce({
        status: 200,
        data: { Version: "v1.1.0", Time: "2024-02-01T00:00:00Z" },
        headers: {},
      });

    const res = makeRes();
    await proxy.handleRequest(makeReq("/github.com/foo/bar/@v/list"), res);

    expect(res.status).toHaveBeenCalledWith(404);
  });

  it("proxies upstream non-200 status", async () => {
    mockedGet.mockResolvedValueOnce({ status: 410, data: "gone", headers: {} });

    const res = makeRes();
    await proxy.handleRequest(makeReq("/github.com/foo/bar/@v/list"), res);

    expect(res.status).toHaveBeenCalledWith(410);
  });
});

describe("GoRegistryProxy.handleRequest - /@latest", () => {
  it("returns latest directly when it is before cutoff", async () => {
    const info = { Version: "v1.0.0", Time: "2024-01-01T00:00:00Z" };
    const res = await handle("/github.com/foo/bar/@latest", info);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(info);
  });

  it("falls back to list and returns most recent allowed version when latest is after cutoff", async () => {
    const latestInfo = { Version: "v1.2.0", Time: "2024-02-01T00:00:00Z" }; // too new
    const v100Info = { Version: "v1.0.0", Time: "2024-01-01T00:00:00Z" };
    const v110Info = { Version: "v1.1.0", Time: "2024-01-10T00:00:00Z" }; // most recent allowed

    mockedGet
      .mockResolvedValueOnce({ status: 200, data: latestInfo, headers: {} })
      .mockResolvedValueOnce({
        status: 200,
        data: "v1.0.0\nv1.1.0\nv1.2.0\n",
        headers: {},
      })
      .mockResolvedValueOnce({ status: 200, data: v100Info, headers: {} })
      .mockResolvedValueOnce({ status: 200, data: v110Info, headers: {} })
      .mockResolvedValueOnce({ status: 200, data: latestInfo, headers: {} });

    const res = makeRes();
    await proxy.handleRequest(makeReq("/github.com/foo/bar/@latest"), res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(v110Info);
  });

  it("returns 404 when latest is after cutoff and the fallback list request returns non-200", async () => {
    const latestInfo = { Version: "v1.0.0", Time: "2024-02-01T00:00:00Z" }; // too new

    mockedGet
      .mockResolvedValueOnce({ status: 200, data: latestInfo, headers: {} })
      .mockResolvedValueOnce({ status: 503, data: "", headers: {} }); // list fetch fails

    const res = makeRes();
    await proxy.handleRequest(makeReq("/github.com/foo/bar/@latest"), res);

    expect(res.status).toHaveBeenCalledWith(404);
  });

  it("returns 404 when latest is after cutoff and all list versions are too new", async () => {
    const latestInfo = { Version: "v1.0.0", Time: "2024-02-01T00:00:00Z" };

    mockedGet
      .mockResolvedValueOnce({ status: 200, data: latestInfo, headers: {} })
      .mockResolvedValueOnce({ status: 200, data: "v1.0.0\n", headers: {} })
      .mockResolvedValueOnce({ status: 200, data: latestInfo, headers: {} });

    const res = makeRes();
    await proxy.handleRequest(makeReq("/github.com/foo/bar/@latest"), res);

    expect(res.status).toHaveBeenCalledWith(404);
  });

  it("proxies upstream non-200 status", async () => {
    const res = await handle(
      "/github.com/foo/bar/@latest",
      { error: "not found" },
      404,
    );

    expect(res.status).toHaveBeenCalledWith(404);
  });
});

describe("GoRegistryProxy.handleRequest - /@v/list (info fetch failures)", () => {
  it("excludes versions whose .info fetch fails (network error) from the list", async () => {
    mockedGet
      .mockResolvedValueOnce({
        status: 200,
        data: "v1.0.0\nv1.1.0\n",
        headers: {},
      })
      .mockRejectedValueOnce(new Error("network error")) // v1.0.0 info fetch fails
      .mockResolvedValueOnce({
        status: 200,
        data: { Version: "v1.1.0", Time: "2024-01-01T00:00:00Z" },
        headers: {},
      });

    const res = makeRes();
    await proxy.handleRequest(makeReq("/github.com/foo/bar/@v/list"), res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(vi.mocked(res.send)).toHaveBeenCalledWith("v1.1.0\n");
  });
});

describe("GoRegistryProxy.handleRequest - passthrough", () => {
  it("redirects .info requests", async () => {
    const res = await handle("/github.com/foo/bar/@v/v1.0.0.info", {});
    expect(res.redirect).toHaveBeenCalledWith(
      302,
      "https://proxy.golang.org/github.com/foo/bar/@v/v1.0.0.info",
    );
  });
});

describe("GoRegistryProxy.handleRequest - download (.zip/.mod)", () => {
  it("redirects .mod requests when version is within cutoff", async () => {
    mockedGet.mockResolvedValueOnce({
      status: 200,
      data: { Version: "v1.0.0", Time: "2024-01-01T00:00:00Z" },
      headers: {},
    });
    const res = makeRes();
    await proxy.handleRequest(makeReq("/github.com/foo/bar/@v/v1.0.0.mod"), res);
    expect(res.redirect).toHaveBeenCalledWith(
      302,
      "https://proxy.golang.org/github.com/foo/bar/@v/v1.0.0.mod",
    );
  });

  it("redirects .zip requests when version is within cutoff", async () => {
    mockedGet.mockResolvedValueOnce({
      status: 200,
      data: { Version: "v1.0.0", Time: "2024-01-01T00:00:00Z" },
      headers: {},
    });
    const res = makeRes();
    await proxy.handleRequest(makeReq("/github.com/foo/bar/@v/v1.0.0.zip"), res);
    expect(res.redirect).toHaveBeenCalledWith(
      302,
      "https://proxy.golang.org/github.com/foo/bar/@v/v1.0.0.zip",
    );
  });

  it("returns 404 when version is after cutoff", async () => {
    mockedGet.mockResolvedValueOnce({
      status: 200,
      data: { Version: "v1.1.0", Time: "2024-02-01T00:00:00Z" },
      headers: {},
    });
    const res = makeRes();
    await proxy.handleRequest(makeReq("/github.com/foo/bar/@v/v1.1.0.zip"), res);
    expect(res.status).toHaveBeenCalledWith(404);
  });

  it("returns 404 when .info fetch fails", async () => {
    mockedGet.mockRejectedValueOnce(new Error("network error"));
    const res = makeRes();
    await proxy.handleRequest(makeReq("/github.com/foo/bar/@v/v1.0.0.zip"), res);
    expect(res.status).toHaveBeenCalledWith(404);
  });
});

describe("GoRegistryProxy – golang.org/toolchain deduplication", () => {
  it("fetches .info only once per Go version and includes all arch variants in list", async () => {
    const listText =
      "v0.0.1-go1.21.0.linux-amd64\nv0.0.1-go1.21.0.darwin-arm64\nv0.0.1-go1.22.0.linux-amd64\nv0.0.1-go1.22.0.darwin-arm64\n";

    mockedGet
      // list response
      .mockResolvedValueOnce({ status: 200, data: listText, headers: {} })
      // .info for v0.0.1-go1.21.0.linux-amd64 (representative for go1.21.0)
      .mockResolvedValueOnce({
        status: 200,
        data: { Version: "v0.0.1-go1.21.0.linux-amd64", Time: "2024-01-01T00:00:00Z" },
        headers: {},
      })
      // .info for v0.0.1-go1.22.0.linux-amd64 (representative for go1.22.0)
      .mockResolvedValueOnce({
        status: 200,
        data: { Version: "v0.0.1-go1.22.0.linux-amd64", Time: "2024-01-10T00:00:00Z" },
        headers: {},
      });

    const res = makeRes();
    await proxy.handleRequest(makeReq("/golang.org/toolchain/@v/list"), res);

    // Only 2 .info fetches (1 per Go version), not 4
    expect(mockedGet).toHaveBeenCalledTimes(3); // 1 list + 2 info
    expect(res.status).toHaveBeenCalledWith(200);
    // All 4 arch variants should be included since both Go versions pass the cutoff
    const sent = vi.mocked(res.send).mock.calls[0][0] as string;
    expect(sent).toContain("v0.0.1-go1.21.0.linux-amd64");
    expect(sent).toContain("v0.0.1-go1.21.0.darwin-arm64");
    expect(sent).toContain("v0.0.1-go1.22.0.linux-amd64");
    expect(sent).toContain("v0.0.1-go1.22.0.darwin-arm64");
  });

  it("prefers linux variant as representative even when darwin appears first in list", async () => {
    // darwin-arm64 appears before linux-amd64 in the list
    const listText =
      "v0.0.1-go1.21.0.darwin-arm64\nv0.0.1-go1.21.0.linux-amd64\n";

    mockedGet
      .mockResolvedValueOnce({ status: 200, data: listText, headers: {} })
      // Should fetch .info for the linux variant, not darwin
      .mockResolvedValueOnce({
        status: 200,
        data: { Version: "v0.0.1-go1.21.0.linux-amd64", Time: "2024-01-01T00:00:00Z" },
        headers: {},
      });

    const res = makeRes();
    await proxy.handleRequest(makeReq("/golang.org/toolchain/@v/list"), res);

    // Verify the .info was fetched for the linux variant
    expect(mockedGet).toHaveBeenCalledTimes(2);
    expect(mockedGet).toHaveBeenCalledWith(
      "https://proxy.golang.org/golang.org/toolchain/@v/v0.0.1-go1.21.0.linux-amd64.info",
      expect.any(Object),
    );
    expect(res.status).toHaveBeenCalledWith(200);
    const sent = vi.mocked(res.send).mock.calls[0][0] as string;
    expect(sent).toContain("v0.0.1-go1.21.0.darwin-arm64");
    expect(sent).toContain("v0.0.1-go1.21.0.linux-amd64");
  });

  it("excludes all arch variants when their Go version is after cutoff", async () => {
    const listText =
      "v0.0.1-go1.21.0.linux-amd64\nv0.0.1-go1.21.0.darwin-arm64\nv0.0.1-go1.22.0.linux-amd64\nv0.0.1-go1.22.0.darwin-arm64\n";

    mockedGet
      .mockResolvedValueOnce({ status: 200, data: listText, headers: {} })
      // go1.21.0: before cutoff
      .mockResolvedValueOnce({
        status: 200,
        data: { Version: "v0.0.1-go1.21.0.linux-amd64", Time: "2024-01-01T00:00:00Z" },
        headers: {},
      })
      // go1.22.0: after cutoff
      .mockResolvedValueOnce({
        status: 200,
        data: { Version: "v0.0.1-go1.22.0.linux-amd64", Time: "2024-02-01T00:00:00Z" },
        headers: {},
      });

    const res = makeRes();
    await proxy.handleRequest(makeReq("/golang.org/toolchain/@v/list"), res);

    const sent = vi.mocked(res.send).mock.calls[0][0] as string;
    expect(sent).toContain("v0.0.1-go1.21.0.linux-amd64");
    expect(sent).toContain("v0.0.1-go1.21.0.darwin-arm64");
    expect(sent).not.toContain("go1.22.0");
  });

  it("deduplicates in handleLatest fallback path", async () => {
    const latestInfo = { Version: "v0.0.1-go1.22.0.linux-amd64", Time: "2024-02-01T00:00:00Z" };
    const go121Info = { Version: "v0.0.1-go1.21.0.linux-amd64", Time: "2024-01-10T00:00:00Z" };

    mockedGet
      // /@latest → too new
      .mockResolvedValueOnce({ status: 200, data: latestInfo, headers: {} })
      // fallback list
      .mockResolvedValueOnce({
        status: 200,
        data: "v0.0.1-go1.21.0.linux-amd64\nv0.0.1-go1.21.0.darwin-arm64\nv0.0.1-go1.22.0.linux-amd64\nv0.0.1-go1.22.0.darwin-arm64\n",
        headers: {},
      })
      // .info for go1.21.0 representative only
      .mockResolvedValueOnce({ status: 200, data: go121Info, headers: {} })
      // .info for go1.22.0 representative only
      .mockResolvedValueOnce({ status: 200, data: latestInfo, headers: {} });

    const res = makeRes();
    await proxy.handleRequest(makeReq("/golang.org/toolchain/@latest"), res);

    // 1 latest + 1 list + 2 info (not 4 info)
    expect(mockedGet).toHaveBeenCalledTimes(4);
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(go121Info);
  });
});

describe("GoRegistryProxy – malicious filtering", () => {
  const MALICIOUS_DB = JSON.stringify({
    go: { maliciousPackages: ["github.com/evil/module"], maliciousVersions: { "github.com/foo/bar": ["v1.0.0"] } },
  });

  let maliciousProxy: GoRegistryProxy;

  beforeEach(() => {
    mockReadFileSync.mockReturnValue(MALICIOUS_DB);
    maliciousProxy = new GoRegistryProxy({
      upstream: "https://proxy.golang.org",
      delayMs: 7 * 24 * 60 * 60 * 1000,
      maliciousDbPath: "/dev/null",
    });
  });

  afterEach(() => {
    mockReadFileSync.mockReset();
  });

  it("returns 404 when the module is fully malicious (/@v/list)", async () => {
    mockedGet
      .mockResolvedValueOnce({ status: 200, data: "v1.0.0\n", headers: {} })
      .mockResolvedValueOnce({
        status: 200,
        data: { Version: "v1.0.0", Time: "2024-01-01T00:00:00Z" },
        headers: {},
      });
    const res = makeRes();
    await maliciousProxy.handleRequest(
      makeReq("/github.com/evil/module/@v/list"),
      res,
    );
    expect(res.status).toHaveBeenCalledWith(404);
  });

  it("blocks a specific malicious version while keeping safe ones (/@v/list)", async () => {
    mockedGet
      .mockResolvedValueOnce({
        status: 200,
        data: "v1.0.0\nv2.0.0\n",
        headers: {},
      })
      .mockResolvedValueOnce({
        status: 200,
        data: { Version: "v1.0.0", Time: "2024-01-01T00:00:00Z" },
        headers: {},
      })
      .mockResolvedValueOnce({
        status: 200,
        data: { Version: "v2.0.0", Time: "2024-01-10T00:00:00Z" },
        headers: {},
      });
    const res = makeRes();
    await maliciousProxy.handleRequest(
      makeReq("/github.com/foo/bar/@v/list"),
      res,
    );
    expect(res.status).toHaveBeenCalledWith(200);
    expect(vi.mocked(res.send)).toHaveBeenCalledWith("v2.0.0\n");
  });

  it("returns 404 when the module is fully malicious (/@latest)", async () => {
    // 1st call: /@latest → malicious version (before cutoff, but blocked by malicious filter)
    // 2nd call: /@v/list fallback → empty list → no versions → 404
    mockedGet
      .mockResolvedValueOnce({
        status: 200,
        data: { Version: "v1.0.0", Time: "2024-01-01T00:00:00Z" },
        headers: {},
      })
      .mockResolvedValueOnce({ status: 200, data: "", headers: {} });
    const res = makeRes();
    await maliciousProxy.handleRequest(
      makeReq("/github.com/evil/module/@latest"),
      res,
    );
    expect(res.status).toHaveBeenCalledWith(404);
  });
});
