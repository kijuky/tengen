import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { PassThrough, Readable } from "node:stream";
import { once } from "node:events";
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Response } from "express";
import {
  RegistryProxy,
  __resetCachesForTesting,
  type RegistryConfig,
  type VersionMetadata,
} from "./base.ts";
import { makeReq } from "./test-helpers.ts";

vi.mock("axios", () => ({
  default: { get: vi.fn(), request: vi.fn() },
}));

import axios from "axios";
const mockedGet = vi.mocked(axios.get);

const PUBLISHED = new Date("2024-01-01T00:00:00Z");

/** A Response backed by a PassThrough, so piping into it records the body. */
function makePipeRes() {
  const sink = new PassThrough();
  const chunks: Buffer[] = [];
  sink.on("data", (c: Buffer) => chunks.push(Buffer.from(c)));
  const res = sink as unknown as Response;
  const sentHeaders: Record<string, string | string[]> = {};
  const status = vi.fn(() => res);
  const setHeader = vi.fn((key: string, value: string | string[]) => {
    sentHeaders[key.toLowerCase()] = value;
    return res;
  });
  const json = vi.fn(() => res);
  const redirect = vi.fn(() => res);
  Object.assign(sink, { headersSent: false, status, setHeader, json, redirect });
  return {
    res,
    sink,
    status,
    json,
    redirect,
    sentHeaders,
    body: () => Buffer.concat(chunks).toString(),
  };
}

class CacheTestProxy extends RegistryProxy {
  readonly name = "dl";
  readonly versionOf = vi.fn<(path: string) => VersionMetadata | null>(
    (path) => {
      const m = /^\/(\w+)\/-\/\w+-([\w.-]+)\.tgz$/.exec(path);
      return m ? { packageName: m[1]!, version: m[2]!, published: PUBLISHED } : null;
    },
  );

  override setRouting() {
    this.addDownloadRoute({
      condition: (req) => req.path.includes("/-/"),
      getVersionMetadata: (req) => this.versionOf(req.path),
    });
  }

  protected override isCacheable(version: VersionMetadata): boolean {
    return !version.version.endsWith("-SNAPSHOT");
  }
}

let dir: string;
let dbPath: string;

function writeMaliciousDb(versions: Record<string, string[]>) {
  writeFileSync(
    dbPath,
    JSON.stringify({ dl: { maliciousPackages: [], maliciousVersions: versions } }),
  );
  __resetCachesForTesting();
}

function makeProxy(overrides: Partial<RegistryConfig> = {}) {
  return new CacheTestProxy({
    upstream: "https://upstream.example.com",
    delayMs: 7 * 24 * 60 * 60 * 1000,
    maliciousDbPath: dbPath,
    upstreamAccess: "direct",
    cacheDir: join(dir, "cache"),
    ...overrides,
  });
}

function upstreamReturns(body: string, headers: Record<string, string> = {}) {
  mockedGet.mockResolvedValueOnce({
    status: 200,
    headers: {
      "content-type": "application/octet-stream",
      "content-length": String(Buffer.byteLength(body)),
      ...headers,
    },
    data: Readable.from([Buffer.from(body)]),
  });
}

async function request(
  proxy: RegistryProxy,
  path: string,
  method = "GET",
) {
  const r = makePipeRes();
  await proxy.handleRequest(makeReq(path, {}, method), r.res);
  return r;
}

/** Wait until the background store has renamed the entry into place. */
async function waitForCachedEntries(count: number) {
  await vi.waitFor(() => {
    const names = readdirSync(join(dir, "cache", "dl")).filter((n) =>
      n.endsWith(".json"),
    );
    expect(names).toHaveLength(count);
  });
}

function cachedFiles(): string[] {
  try {
    return readdirSync(join(dir, "cache", "dl"));
  } catch {
    return [];
  }
}

beforeEach(() => {
  vi.clearAllMocks();
  dir = mkdtempSync(join(tmpdir(), "tengen-cache-test-"));
  dbPath = join(dir, "malicious-db.json");
  writeMaliciousDb({});
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("RegistryProxy – download cache", () => {
  it("streams an allowed download through and stores it", async () => {
    const proxy = makeProxy();
    upstreamReturns("tarball-bytes");

    const r = await request(proxy, "/pkg/-/pkg-1.0.0.tgz");
    await once(r.sink, "finish");

    expect(mockedGet).toHaveBeenCalledWith(
      "https://upstream.example.com/pkg/-/pkg-1.0.0.tgz",
      expect.objectContaining({ responseType: "stream" }),
    );
    expect(r.redirect).not.toHaveBeenCalled();
    expect(r.status).toHaveBeenCalledWith(200);
    expect(r.body()).toBe("tarball-bytes");
    await waitForCachedEntries(1);
  });

  it("serves a stored download without asking the upstream", async () => {
    const proxy = makeProxy();
    upstreamReturns("tarball-bytes", { etag: '"abc"' });
    await once((await request(proxy, "/pkg/-/pkg-1.0.0.tgz")).sink, "finish");
    await waitForCachedEntries(1);
    mockedGet.mockClear();
    proxy.versionOf.mockClear();

    const r = await request(proxy, "/pkg/-/pkg-1.0.0.tgz");
    await once(r.sink, "finish");

    expect(mockedGet).not.toHaveBeenCalled();
    expect(proxy.versionOf).not.toHaveBeenCalled();
    expect(r.status).toHaveBeenCalledWith(200);
    expect(r.sentHeaders["content-length"]).toBe("13");
    expect(r.sentHeaders["etag"]).toBe('"abc"');
    expect(r.body()).toBe("tarball-bytes");
  });

  it("answers HEAD for a stored download with headers only", async () => {
    const proxy = makeProxy();
    upstreamReturns("tarball-bytes");
    await once((await request(proxy, "/pkg/-/pkg-1.0.0.tgz")).sink, "finish");
    await waitForCachedEntries(1);

    const r = await request(proxy, "/pkg/-/pkg-1.0.0.tgz", "HEAD");
    await once(r.sink, "finish");

    expect(r.status).toHaveBeenCalledWith(200);
    expect(r.sentHeaders["content-length"]).toBe("13");
    expect(r.body()).toBe("");
  });

  it("refuses a stored download once it is in the malicious DB, and removes it", async () => {
    const proxy = makeProxy();
    upstreamReturns("tarball-bytes");
    await once((await request(proxy, "/pkg/-/pkg-1.0.0.tgz")).sink, "finish");
    await waitForCachedEntries(1);

    writeMaliciousDb({ pkg: ["1.0.0"] });
    const fresh = makeProxy();
    const r = await request(fresh, "/pkg/-/pkg-1.0.0.tgz");

    expect(r.status).toHaveBeenCalledWith(404);
    expect(mockedGet).toHaveBeenCalledTimes(1);
    expect(cachedFiles()).toEqual([]);
  });

  it("does not store a download blocked by the malicious DB", async () => {
    writeMaliciousDb({ pkg: ["1.0.0"] });
    const proxy = makeProxy();

    const r = await request(proxy, "/pkg/-/pkg-1.0.0.tgz");

    expect(r.status).toHaveBeenCalledWith(404);
    expect(mockedGet).not.toHaveBeenCalled();
    expect(cachedFiles()).toEqual([]);
  });

  it("keeps nothing when the upstream body ends short of its content-length", async () => {
    const proxy = makeProxy();
    mockedGet.mockResolvedValueOnce({
      status: 200,
      headers: { "content-length": "100" },
      data: Readable.from([Buffer.from("short")]),
    });

    const r = await request(proxy, "/pkg/-/pkg-1.0.0.tgz");
    await once(r.sink, "finish");
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(cachedFiles()).toEqual([]);
  });

  it("does not store an upstream error response", async () => {
    const proxy = makeProxy();
    mockedGet.mockResolvedValueOnce({
      status: 404,
      headers: {},
      data: Readable.from([Buffer.from("not found")]),
    });

    const r = await request(proxy, "/pkg/-/pkg-1.0.0.tgz");
    await once(r.sink, "finish");
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(r.status).toHaveBeenCalledWith(404);
    expect(cachedFiles()).toEqual([]);
  });

  it("passes a version the registry marks uncacheable straight through", async () => {
    const proxy = makeProxy();

    const r = await request(proxy, "/pkg/-/pkg-1.0-SNAPSHOT.tgz");

    expect(r.redirect).toHaveBeenCalledWith(
      307,
      "https://upstream.example.com/pkg/-/pkg-1.0-SNAPSHOT.tgz",
    );
    expect(cachedFiles()).toEqual([]);
  });

  it("redirects as before when no cache directory is configured", async () => {
    const proxy = makeProxy({ cacheDir: undefined });

    const r = await request(proxy, "/pkg/-/pkg-1.0.0.tgz");

    expect(r.redirect).toHaveBeenCalledWith(
      307,
      "https://upstream.example.com/pkg/-/pkg-1.0.0.tgz",
    );
    expect(mockedGet).not.toHaveBeenCalled();
  });
});

describe("RegistryProxy – download cache encoding", () => {
  it("asks the upstream for the artifact unencoded", async () => {
    const proxy = makeProxy();
    upstreamReturns("tarball-bytes");

    await once((await request(proxy, "/pkg/-/pkg-1.0.0.tgz")).sink, "finish");

    expect(mockedGet).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        headers: expect.objectContaining({ "accept-encoding": "identity" }),
      }),
    );
  });

  it("relays an encoded response but does not store it", async () => {
    const proxy = makeProxy();
    upstreamReturns("compressed", { "content-encoding": "br" });

    const r = await request(proxy, "/pkg/-/pkg-1.0.0.tgz");
    await once(r.sink, "finish");
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(r.sentHeaders["content-encoding"]).toBe("br");
    expect(cachedFiles()).toEqual([]);
  });

  it("drops an entry stored with a content encoding and fetches it again", async () => {
    const proxy = makeProxy();
    upstreamReturns("tarball-bytes");
    await once((await request(proxy, "/pkg/-/pkg-1.0.0.tgz")).sink, "finish");
    await waitForCachedEntries(1);
    // Rewrite the sidecar as an earlier version stored it: with the encoding.
    const sidecar = readdirSync(join(dir, "cache", "dl")).find((n) =>
      n.endsWith(".json"),
    )!;
    const file = join(dir, "cache", "dl", sidecar);
    const data = JSON.parse(readFileSync(file, "utf-8"));
    data.headers["content-encoding"] = "br";
    writeFileSync(file, JSON.stringify(data));
    mockedGet.mockClear();
    upstreamReturns("tarball-bytes");

    const r = await request(proxy, "/pkg/-/pkg-1.0.0.tgz");
    await once(r.sink, "finish");

    expect(mockedGet).toHaveBeenCalledTimes(1);
    expect(r.sentHeaders["content-encoding"]).toBeUndefined();
    expect(r.body()).toBe("tarball-bytes");
  });
});

describe("RegistryProxy – purgeMaliciousFromCache", () => {
  it("removes only the stored downloads the malicious DB now lists", async () => {
    const proxy = makeProxy();
    upstreamReturns("one");
    await once((await request(proxy, "/pkg/-/pkg-1.0.0.tgz")).sink, "finish");
    upstreamReturns("two");
    await once((await request(proxy, "/pkg/-/pkg-2.0.0.tgz")).sink, "finish");
    await waitForCachedEntries(2);

    writeMaliciousDb({ pkg: ["1.0.0"] });
    const removed = await makeProxy().purgeMaliciousFromCache();

    expect(removed).toBe(1);
    await waitForCachedEntries(1);
    mockedGet.mockClear();
    const r = await request(makeProxy(), "/pkg/-/pkg-2.0.0.tgz");
    await once(r.sink, "finish");
    expect(mockedGet).not.toHaveBeenCalled();
    expect(r.body()).toBe("two");
  });

  it("does nothing without a cache directory", async () => {
    expect(await makeProxy({ cacheDir: undefined }).purgeMaliciousFromCache()).toBe(0);
  });
});
