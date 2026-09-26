import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { IvyRegistryProxy } from "./ivy.ts";
import { makeReq, makeRes } from "./test-helpers.ts";

vi.mock("axios", () => ({
  default: { get: vi.fn(), head: vi.fn() },
}));
vi.mock("node:fs", () => ({
  readFileSync: vi.fn(),
}));

const mockReadFileSync = vi.mocked(readFileSync);

import axios from "axios";

const DELAY_MS = 7 * 24 * 60 * 60 * 1000;
const CUTOFF = new Date("2024-01-15T00:00:00Z");
const NOW = new Date(CUTOFF.getTime() + DELAY_MS);


const UPSTREAM = "https://repo.scala-sbt.org/scalasbt/sbt-plugin-releases";
const MODULE = "/ch.epfl.scala/sbt-bloop/scala_2.12/sbt_1.0";

let proxy: IvyRegistryProxy;

beforeEach(() => {
  vi.resetAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  mockReadFileSync.mockReturnValue(JSON.stringify({}));
  proxy = new IvyRegistryProxy({
    name: "sbt-plugins",
    upstream: UPSTREAM,
    delayMs: DELAY_MS,
    maliciousDbPath: "/dev/null",
  });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("IvyRegistryProxy – mounting", () => {
  it("uses the configured name", () => {
    expect(proxy.name).toBe("sbt-plugins");
  });

  it("falls back to 'ivy' without a name", () => {
    expect(
      new IvyRegistryProxy({
        upstream: UPSTREAM,
        delayMs: DELAY_MS,
        maliciousDbPath: "/dev/null",
      }).name,
    ).toBe("ivy");
  });
});

describe("IvyRegistryProxy – downloads", () => {
  it("HEADs the revision's ivy.xml", async () => {
    vi.mocked(axios.head).mockResolvedValue({
      status: 200,
      headers: { "last-modified": new Date("2024-01-01T00:00:00Z").toUTCString() },
    } as any);

    await proxy.handleRequest(
      makeReq(`${MODULE}/1.0.0/jars/sbt-bloop.jar`) as any,
      makeRes() as any,
    );

    expect(vi.mocked(axios.head).mock.calls[0]?.[0]).toBe(
      `${UPSTREAM}${MODULE}/1.0.0/ivys/ivy.xml`,
    );
  });

  it("allows a revision older than the cutoff", async () => {
    vi.mocked(axios.head).mockResolvedValue({
      status: 200,
      headers: { "last-modified": new Date("2024-01-01T00:00:00Z").toUTCString() },
    } as any);

    const res = makeRes();
    await proxy.handleRequest(
      makeReq(`${MODULE}/1.0.0/jars/sbt-bloop.jar`) as any,
      res as any,
    );

    expect(res.status).not.toHaveBeenCalledWith(404);
  });

  it("blocks a revision newer than the cutoff", async () => {
    vi.mocked(axios.head).mockResolvedValue({
      status: 200,
      headers: { "last-modified": new Date("2024-02-01T00:00:00Z").toUTCString() },
    } as any);

    const res = makeRes();
    await proxy.handleRequest(
      makeReq(`${MODULE}/2.0.0/jars/sbt-bloop.jar`) as any,
      res as any,
    );

    expect(res.status).toHaveBeenCalledWith(404);
  });

  it("blocks when ivy.xml cannot be read", async () => {
    vi.mocked(axios.head).mockResolvedValue({ status: 404, headers: {} } as any);

    const res = makeRes();
    await proxy.handleRequest(
      makeReq(`${MODULE}/1.0.0/jars/sbt-bloop.jar`) as any,
      res as any,
    );

    expect(res.status).toHaveBeenCalledWith(404);
  });

  it("gates a module without cross-version segments", async () => {
    vi.mocked(axios.head).mockResolvedValue({
      status: 200,
      headers: { "last-modified": new Date("2024-01-01T00:00:00Z").toUTCString() },
    } as any);

    await proxy.handleRequest(
      makeReq("/org.scala-sbt/sbt/1.10.7/ivys/ivy.xml") as any,
      makeRes() as any,
    );

    expect(vi.mocked(axios.head).mock.calls[0]?.[0]).toBe(
      `${UPSTREAM}/org.scala-sbt/sbt/1.10.7/ivys/ivy.xml`,
    );
  });
});
