import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { GoRegistryProxy } from "./go.ts";
import { makeHandle, makeReq, makeRes } from "./test-helpers.ts";

vi.mock("axios", () => ({
  default: { get: vi.fn() },
}));

import axios from "axios";
const mockedGet = vi.mocked(axios.get);

const proxy = new GoRegistryProxy({
  upstream: "https://proxy.golang.org",
  delayMs: 7 * 24 * 60 * 60 * 1000,
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

describe("GoRegistryProxy.handleRequest - /@v/*.info", () => {
  it("returns 200 when version was published before cutoff", async () => {
    const info = { Version: "v1.0.0", Time: "2024-01-01T00:00:00Z" };
    const res = await handle("/github.com/foo/bar/@v/v1.0.0.info", info);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(info);
  });

  it("returns 200 when version was published exactly at cutoff", async () => {
    const info = { Version: "v1.0.0", Time: "2024-01-15T00:00:00Z" };
    const res = await handle("/github.com/foo/bar/@v/v1.0.0.info", info);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(info);
  });

  it("returns 404 when version was published after cutoff", async () => {
    const info = { Version: "v1.0.0", Time: "2024-02-01T00:00:00Z" };
    const res = await handle("/github.com/foo/bar/@v/v1.0.0.info", info);

    expect(res.status).toHaveBeenCalledWith(404);
  });

  it("returns 200 with data unchanged when Time field is missing", async () => {
    const info = { Version: "v1.0.0" };
    const res = await handle("/github.com/foo/bar/@v/v1.0.0.info", info);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(info);
  });

  it("proxies upstream non-200 status", async () => {
    const res = await handle(
      "/github.com/foo/bar/@v/v1.0.0.info",
      { error: "not found" },
      404,
    );

    expect(res.status).toHaveBeenCalledWith(404);
  });
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

describe("GoRegistryProxy.handleRequest - passthrough", () => {
  it("redirects .mod requests", async () => {
    const res = await handle("/github.com/foo/bar/@v/v1.0.0.mod", {});
    expect(res.redirect).toHaveBeenCalledWith(
      302,
      "https://proxy.golang.org/github.com/foo/bar/@v/v1.0.0.mod",
    );
  });

  it("redirects .zip requests", async () => {
    const res = await handle("/github.com/foo/bar/@v/v1.0.0.zip", {});
    expect(res.redirect).toHaveBeenCalledWith(
      302,
      "https://proxy.golang.org/github.com/foo/bar/@v/v1.0.0.zip",
    );
  });
});
