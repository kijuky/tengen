import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { RubygemsRegistryProxy } from "./rubygems.ts";
import { makeHandle, makeReq, makeRes } from "./test-helpers.ts";

vi.mock("axios", () => ({
  default: { get: vi.fn() },
}));

import axios from "axios";
const mockedGet = vi.mocked(axios.get);

// Fix time so that: cutoffDate = Date.now() - delayMs = 2024-01-15T00:00:00Z
const DELAY_MS = 7 * 24 * 60 * 60 * 1000;
const CUTOFF = new Date("2024-01-15T00:00:00Z");
const NOW = new Date(CUTOFF.getTime() + DELAY_MS);

const proxy = new RubygemsRegistryProxy({
  upstream: "https://rubygems.org",
  delayMs: DELAY_MS,
});

const handle = makeHandle(proxy, mockedGet);

function makeVersion(
  number: string,
  createdAt: string,
): Record<string, unknown> {
  return { number, created_at: createdAt, authors: "test" };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("RubygemsRegistryProxy – routing", () => {
  it("routes /info/{name} to compact info handler (not redirected)", async () => {
    mockedGet
      .mockResolvedValueOnce({
        status: 200,
        data: "---\n1.0.0 |checksum:abc\n",
        headers: {},
      })
      .mockResolvedValueOnce({
        status: 200,
        data: [makeVersion("1.0.0", "2024-01-01T00:00:00Z")],
        headers: {},
      });
    const res = makeRes();
    await proxy.handleRequest(makeReq("/info/rails"), res);
    expect(res.redirect).not.toHaveBeenCalled();
  });

  it("routes /api/v1/versions/{name}.json to versions handler (not redirected)", async () => {
    const res = await handle("/api/v1/versions/rails.json", {});
    expect(res.redirect).not.toHaveBeenCalled();
  });

  it("redirects non-metadata paths as passthrough", async () => {
    const res = await handle("/gems/rails-7.0.0.gem", {});
    expect(res.redirect).toHaveBeenCalledWith(
      302,
      "https://rubygems.org/gems/rails-7.0.0.gem",
    );
  });
});

describe("RubygemsRegistryProxy – /api/v1/versions/{name}.json", () => {
  it("filters out versions published after cutoff", async () => {
    const data = [
      makeVersion("7.0.0", "2024-01-01T00:00:00Z"), // before → allowed
      makeVersion("7.1.0", "2024-02-01T00:00:00Z"), // after  → filtered
    ];
    const res = await handle("/api/v1/versions/rails.json", data);
    expect(res.status).toHaveBeenCalledWith(200);
    const body = vi.mocked(res.json).mock.calls[0][0] as Array<
      Record<string, unknown>
    >;
    expect(body).toHaveLength(1);
    expect(body[0]["number"]).toBe("7.0.0");
  });

  it("includes versions published exactly at cutoff", async () => {
    const res = await handle("/api/v1/versions/rails.json", [
      makeVersion("7.0.0", "2024-01-15T00:00:00Z"),
    ]);
    expect(res.status).toHaveBeenCalledWith(200);
    const body = vi.mocked(res.json).mock.calls[0][0] as unknown[];
    expect(body).toHaveLength(1);
  });

  it("returns 404 when all versions are filtered out", async () => {
    const res = await handle("/api/v1/versions/rails.json", [
      makeVersion("7.1.0", "2024-02-01T00:00:00Z"), // after cutoff
    ]);
    expect(res.status).toHaveBeenCalledWith(404);
  });

  it("proxies upstream non-200 status", async () => {
    const res = await handle(
      "/api/v1/versions/rails.json",
      { error: "not found" },
      404,
    );
    expect(res.status).toHaveBeenCalledWith(404);
  });
});

describe("RubygemsRegistryProxy – /info/{name}", () => {
  async function handleInfo(
    gemName: string,
    infoText: string,
    infoStatus: number,
    versionsData: unknown,
    versionsStatus: number,
  ) {
    mockedGet
      .mockResolvedValueOnce({
        status: infoStatus,
        data: infoText,
        headers: {},
      })
      .mockResolvedValueOnce({
        status: versionsStatus,
        data: versionsData,
        headers: {},
      });
    const res = makeRes();
    await proxy.handleRequest(makeReq(`/info/${gemName}`), res);
    return res;
  }

  it("returns filtered compact info excluding versions after cutoff", async () => {
    const res = await handleInfo(
      "rails",
      "---\n1.0.0 |checksum:abc\n1.1.0 |checksum:def\n",
      200,
      [
        makeVersion("1.0.0", "2024-01-01T00:00:00Z"), // before → allowed
        makeVersion("1.1.0", "2024-02-01T00:00:00Z"), // after  → filtered
      ],
      200,
    );

    expect(res.status).toHaveBeenCalledWith(200);
    expect(vi.mocked(res.type)).toHaveBeenCalledWith("text/plain");
    const body = vi.mocked(res.send).mock.calls[0][0] as string;
    expect(body).toContain("1.0.0");
    expect(body).not.toContain("1.1.0");
  });

  it("includes versions published exactly at cutoff", async () => {
    const res = await handleInfo(
      "rails",
      "---\n1.0.0 |checksum:abc\n",
      200,
      [makeVersion("1.0.0", "2024-01-15T00:00:00Z")],
      200,
    );

    expect(res.status).toHaveBeenCalledWith(200);
    const body = vi.mocked(res.send).mock.calls[0][0] as string;
    expect(body).toContain("1.0.0");
  });

  it("returns 404 when all versions are filtered out", async () => {
    const res = await handleInfo(
      "rails",
      "---\n1.1.0 |checksum:def\n",
      200,
      [makeVersion("1.1.0", "2024-02-01T00:00:00Z")], // after cutoff
      200,
    );

    expect(res.status).toHaveBeenCalledWith(404);
  });

  it("proxies non-200 status from info endpoint", async () => {
    const res = await handleInfo("unknown-gem", "not found", 404, null, 404);

    expect(res.status).toHaveBeenCalledWith(404);
  });

  it("returns 404 when versions API returns 404", async () => {
    const res = await handleInfo(
      "rails",
      "---\n1.0.0 |checksum:abc\n",
      200,
      { error: "not found" },
      404,
    );

    expect(res.status).toHaveBeenCalledWith(404);
  });

  it("returns 502 when versions API returns a non-404 error", async () => {
    const res = await handleInfo(
      "rails",
      "---\n1.0.0 |checksum:abc\n",
      200,
      null,
      500,
    );

    expect(res.status).toHaveBeenCalledWith(502);
  });
});
