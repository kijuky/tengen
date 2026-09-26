import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { MavenRegistryProxy } from "./maven.ts";
import { __resetCachesForTesting } from "./base.ts";
import { makeReq, makeRes } from "./test-helpers.ts";

vi.mock("axios", () => ({
  default: { get: vi.fn() },
}));
vi.mock("node:fs", () => ({
  readFileSync: vi.fn(),
}));

const mockReadFileSync = vi.mocked(readFileSync);

import axios from "axios";

const DELAY_MS = 7 * 24 * 60 * 60 * 1000;
const CUTOFF = new Date("2024-01-15T00:00:00Z");
const NOW = new Date(CUTOFF.getTime() + DELAY_MS);

const BEFORE_CUTOFF = new Date("2024-01-01T00:00:00Z").getTime();
const AT_CUTOFF = CUTOFF.getTime();
const AFTER_CUTOFF = new Date("2024-02-01T00:00:00Z").getTime();

type DepsDevVersionEntry = { versionKey: { version: string }; publishedAt: string };

let proxy: MavenRegistryProxy;

beforeEach(() => {
  vi.resetAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  proxy = new MavenRegistryProxy({
    upstream: "https://repo1.maven.org/maven2",
    delayMs: DELAY_MS,
    maliciousDbPath: "/dev/null",
  });
});

afterEach(() => {
  vi.useRealTimers();
});

function makeXml(versions: string[], release = "", latest = ""): string {
  const versionTags = versions
    .map((v) => `    <version>${v}</version>`)
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<metadata>
  <groupId>com.example</groupId>
  <artifactId>mylib</artifactId>
  <versioning>
    <latest>${latest || versions[versions.length - 1] || ""}</latest>
    <release>${release || versions[versions.length - 1] || ""}</release>
    <versions>
${versionTags}
    </versions>
    <lastUpdated>20240201000000</lastUpdated>
  </versioning>
</metadata>`;
}

// Maven makes two sequential axios.get calls for metadata paths:
//   1. upstream maven-metadata.xml
//   2. deps.dev package API for version timestamps
async function handle(
  path: string,
  xml: string,
  versions: DepsDevVersionEntry[] = [],
  upstreamStatus = 200,
): Promise<ReturnType<typeof makeRes>> {
  vi.mocked(axios.get)
    .mockResolvedValueOnce({ status: upstreamStatus, data: xml, headers: {} })
    .mockResolvedValueOnce({
      status: 200,
      data: { versions },
      headers: {},
    });
  const res = makeRes();
  await proxy.handleRequest(makeReq(path), res);
  return res;
}

describe("MavenRegistryProxy – routing", () => {
  it("redirects paths with fewer than 4 segments (not download/metadata) as passthrough", async () => {
    const res = makeRes();
    await proxy.handleRequest(makeReq("/archetype-catalog.xml"), res);
    expect(res.redirect).toHaveBeenCalledWith(
      307,
      "https://repo1.maven.org/maven2/archetype-catalog.xml",
    );
  });

  it("constructs correct packageName for deeply nested groupId", async () => {
    const xml = makeXml(["1.0.0"]);
    await handle("/org/springframework/boot/spring-boot/maven-metadata.xml", xml, [
      { versionKey: { version: "1.0.0" }, publishedAt: new Date(BEFORE_CUTOFF).toISOString() },
    ]);
    expect(vi.mocked(axios.get)).toHaveBeenCalledWith(
      "https://api.deps.dev/v3alpha/systems/maven/packages/org.springframework.boot:spring-boot",
      expect.any(Object),
    );
  });

  it("responds to maven-metadata.xml with XML content-type (not streamed)", async () => {
    const xml = makeXml(["1.0.0"]);
    const res = await handle("/com/example/mylib/maven-metadata.xml", xml, [
      { versionKey: { version: "1.0.0" }, publishedAt: new Date(BEFORE_CUTOFF).toISOString() },
    ]);
    expect(res.type).toHaveBeenCalledWith("application/xml");
    expect(res.send).toHaveBeenCalled();
  });
});

describe("MavenRegistryProxy – download routing", () => {
  it("redirects JARs for allowed versions", async () => {
    vi.mocked(axios.get).mockResolvedValueOnce({
      status: 200,
      data: { versionKey: { version: "1.0.0" }, publishedAt: new Date(BEFORE_CUTOFF).toISOString() },
      headers: {},
    });
    const res = makeRes();
    await proxy.handleRequest(
      makeReq("/com/example/mylib/1.0.0/mylib-1.0.0.jar"),
      res,
    );
    expect(res.redirect).toHaveBeenCalledWith(
      307,
      "https://repo1.maven.org/maven2/com/example/mylib/1.0.0/mylib-1.0.0.jar",
    );
  });

  it("blocks JARs for versions published after the cutoff", async () => {
    vi.mocked(axios.get).mockResolvedValueOnce({
      status: 200,
      data: { versionKey: { version: "2.0.0" }, publishedAt: new Date(AFTER_CUTOFF).toISOString() },
      headers: {},
    });
    const res = makeRes();
    await proxy.handleRequest(
      makeReq("/com/example/mylib/2.0.0/mylib-2.0.0.jar"),
      res,
    );
    expect(res.status).toHaveBeenCalledWith(404);
  });

  it("blocks JARs when deps.dev returns no result", async () => {
    vi.mocked(axios.get).mockResolvedValueOnce({
      status: 404,
      data: {},
      headers: {},
    });
    const res = makeRes();
    await proxy.handleRequest(
      makeReq("/com/example/mylib/1.0.0/mylib-1.0.0.jar"),
      res,
    );
    expect(res.status).toHaveBeenCalledWith(404);
  });

  it("also checks POMs and sources JARs", async () => {
    vi.mocked(axios.get).mockResolvedValueOnce({
      status: 200,
      data: { versionKey: { version: "1.0.0" }, publishedAt: new Date(AFTER_CUTOFF).toISOString() },
      headers: {},
    });
    const res = makeRes();
    await proxy.handleRequest(
      makeReq("/com/example/mylib/1.0.0/mylib-1.0.0.pom"),
      res,
    );
    expect(res.status).toHaveBeenCalledWith(404);
  });
});

describe("MavenRegistryProxy – metadata filtering", () => {
  it("removes versions published after the cutoff", async () => {
    const xml = makeXml(["1.0.0", "2.0.0"]);
    const res = await handle("/com/example/mylib/maven-metadata.xml", xml, [
      { versionKey: { version: "1.0.0" }, publishedAt: new Date(BEFORE_CUTOFF).toISOString() }, // allowed
      { versionKey: { version: "2.0.0" }, publishedAt: new Date(AFTER_CUTOFF).toISOString() }, // filtered
    ]);
    const body = vi.mocked(res.send).mock.calls[0][0] as string;
    expect(body).toContain("<version>1.0.0</version>");
    expect(body).not.toContain("<version>2.0.0</version>");
  });

  it("includes versions published exactly at the cutoff", async () => {
    const xml = makeXml(["1.0.0"]);
    const res = await handle("/com/example/mylib/maven-metadata.xml", xml, [
      { versionKey: { version: "1.0.0" }, publishedAt: new Date(AT_CUTOFF).toISOString() },
    ]);
    expect(res.status).toHaveBeenCalledWith(200);
    const body = vi.mocked(res.send).mock.calls[0][0] as string;
    expect(body).toContain("<version>1.0.0</version>");
  });

  it("updates <release>, <latest>, and <lastUpdated> to the latest allowed version", async () => {
    const xml = makeXml(["1.0.0", "1.1.0", "2.0.0"], "2.0.0", "2.0.0");
    const res = await handle("/com/example/mylib/maven-metadata.xml", xml, [
      { versionKey: { version: "1.0.0" }, publishedAt: new Date(BEFORE_CUTOFF).toISOString() },
      { versionKey: { version: "1.1.0" }, publishedAt: new Date(BEFORE_CUTOFF + 1000).toISOString() }, // newest allowed
      { versionKey: { version: "2.0.0" }, publishedAt: new Date(AFTER_CUTOFF).toISOString() },
    ]);
    const body = vi.mocked(res.send).mock.calls[0][0] as string;
    expect(body).toContain("<release>1.1.0</release>");
    expect(body).toContain("<latest>1.1.0</latest>");
    // 1.1.0 published at 2024-01-01T00:00:01Z → Maven yyyyMMddHHmmss (UTC)
    expect(body).toContain("<lastUpdated>20240101000001</lastUpdated>");
    expect(body).not.toContain("<lastUpdated>20240201000000</lastUpdated>");
  });

  it("returns 404 when all versions are filtered out", async () => {
    const xml = makeXml(["2.0.0"]);
    const res = await handle("/com/example/mylib/maven-metadata.xml", xml, [
      { versionKey: { version: "2.0.0" }, publishedAt: new Date(AFTER_CUTOFF).toISOString() },
    ]);
    expect(res.status).toHaveBeenCalledWith(404);
  });

  it("proxies upstream non-200 status without calling the search API", async () => {
    const res = await handle(
      "/com/example/mylib/maven-metadata.xml",
      "",
      [],
      404,
    );
    expect(res.status).toHaveBeenCalledWith(404);
    expect(vi.mocked(axios.get)).toHaveBeenCalledTimes(1);
  });

  it("passes through group-level metadata (no <versions> block) without calling the search API", async () => {
    const groupXml = `<?xml version="1.0" encoding="UTF-8"?>
<metadata>
  <plugins><plugin><name>MyPlugin</name></plugin></plugins>
</metadata>`;
    vi.mocked(axios.get).mockResolvedValueOnce({
      status: 200,
      data: groupXml,
      headers: {},
    });
    const res = makeRes();
    await proxy.handleRequest(makeReq("/com/example/maven-metadata.xml"), res);
    expect(vi.mocked(axios.get)).toHaveBeenCalledTimes(1);
    expect(res.status).toHaveBeenCalledWith(200);
    const body = vi.mocked(res.send).mock.calls[0][0] as string;
    expect(body).toBe(groupXml);
  });
});

describe("MavenRegistryProxy – checksum endpoints", () => {
  // The proxy rewrites <lastUpdated> to the latest allowed version's publish
  // timestamp, so the checksum is computed over that filtered XML, not the raw upstream.
  function withRolledBackLastUpdated(xml: string): string {
    return xml.replace(
      "<lastUpdated>20240201000000</lastUpdated>",
      "<lastUpdated>20240101000000</lastUpdated>",
    );
  }

  it("returns SHA1 of the filtered XML for .sha1 path", async () => {
    const xml = makeXml(["1.0.0"]);
    const expected = createHash("sha1")
      .update(withRolledBackLastUpdated(xml))
      .digest("hex");
    const res = await handle(
      "/com/example/mylib/maven-metadata.xml.sha1",
      xml,
      [{ versionKey: { version: "1.0.0" }, publishedAt: new Date(BEFORE_CUTOFF).toISOString() }],
    );
    expect(res.status).toHaveBeenCalledWith(200);
    const body = vi.mocked(res.send).mock.calls[0][0] as string;
    expect(body).toBe(expected);
  });

  it("returns MD5 of the filtered XML for .md5 path", async () => {
    const xml = makeXml(["1.0.0"]);
    const expected = createHash("md5")
      .update(withRolledBackLastUpdated(xml))
      .digest("hex");
    const res = await handle("/com/example/mylib/maven-metadata.xml.md5", xml, [
      { versionKey: { version: "1.0.0" }, publishedAt: new Date(BEFORE_CUTOFF).toISOString() },
    ]);
    expect(res.status).toHaveBeenCalledWith(200);
    const body = vi.mocked(res.send).mock.calls[0][0] as string;
    expect(body).toBe(expected);
  });

  it("returns 404 for .sha1 when all versions are filtered out", async () => {
    const xml = makeXml(["2.0.0"]);
    const res = await handle(
      "/com/example/mylib/maven-metadata.xml.sha1",
      xml,
      [{ versionKey: { version: "2.0.0" }, publishedAt: new Date(AFTER_CUTOFF).toISOString() }],
    );
    expect(res.status).toHaveBeenCalledWith(404);
  });
});

describe("MavenRegistryProxy – malicious filtering", () => {
  // Maven OSV package name format: "groupId:artifactId"
  // /com/example/evil/maven-metadata.xml → "com.example:evil"
  // /com/example/mylib/maven-metadata.xml → "com.example:mylib"
  const MALICIOUS_DB = JSON.stringify({
    maven: { maliciousPackages: ["com.example:evil"], maliciousVersions: { "com.example:mylib": ["1.0.0"] } },
  });

  let maliciousProxy: MavenRegistryProxy;

  beforeEach(() => {
    mockReadFileSync.mockReturnValue(MALICIOUS_DB);
    maliciousProxy = new MavenRegistryProxy({
      upstream: "https://repo1.maven.org/maven2",
      delayMs: DELAY_MS,
      maliciousDbPath: "/dev/null",
    });
  });

  afterEach(() => {
    mockReadFileSync.mockReset();
  });

  it("returns 404 when the artifact is fully malicious", async () => {
    const xml = makeXml(["1.0.0"]);
    vi.mocked(axios.get)
      .mockResolvedValueOnce({ status: 200, data: xml, headers: {} })
      .mockResolvedValueOnce({
        status: 200,
        data: { versions: [{ versionKey: { version: "1.0.0" }, publishedAt: new Date(BEFORE_CUTOFF).toISOString() }] },
        headers: {},
      });
    const res = makeRes();
    await maliciousProxy.handleRequest(
      makeReq("/com/example/evil/maven-metadata.xml"),
      res,
    );
    expect(res.status).toHaveBeenCalledWith(404);
  });

  it("blocks a specific malicious version while keeping safe ones", async () => {
    const xml = makeXml(["1.0.0", "2.0.0"]);
    vi.mocked(axios.get)
      .mockResolvedValueOnce({ status: 200, data: xml, headers: {} })
      .mockResolvedValueOnce({
        status: 200,
        data: {
          versions: [
            { versionKey: { version: "1.0.0" }, publishedAt: new Date(BEFORE_CUTOFF).toISOString() }, // malicious → blocked
            { versionKey: { version: "2.0.0" }, publishedAt: new Date(BEFORE_CUTOFF + 1000).toISOString() }, // safe → allowed
          ],
        },
        headers: {},
      });
    const res = makeRes();
    await maliciousProxy.handleRequest(
      makeReq("/com/example/mylib/maven-metadata.xml"),
      res,
    );
    const body = vi.mocked(res.send).mock.calls[0][0] as string;
    expect(body).not.toContain("<version>1.0.0</version>");
    expect(body).toContain("<version>2.0.0</version>");
  });
});

describe("MavenRegistryProxy – metadata checksums", () => {
  const XML_PATH = "/com/example/mylib/maven-metadata.xml";

  beforeEach(() => {
    __resetCachesForTesting();
    mockReadFileSync.mockReturnValue(JSON.stringify({}));
    vi.mocked(axios.get).mockImplementation(((url: string) => {
      if (String(url).includes("api.deps.dev")) {
        return Promise.resolve({
          status: 200,
          data: {
            versions: [
              { versionKey: { version: "1.0.0" }, publishedAt: new Date(BEFORE_CUTOFF).toISOString() },
            ],
          },
          headers: {},
        });
      }
      return Promise.resolve({ status: 200, data: makeXml(["1.0.0"]), headers: {} });
    }) as any);
  });

  it.each(["sha1", "md5", "sha256", "sha512"] as const)(
    "recomputes the %s of the filtered metadata",
    async (algo) => {
      const docRes = makeRes();
      await proxy.handleRequest(makeReq(XML_PATH) as any, docRes as any);
      const filtered = String(vi.mocked(docRes.send).mock.calls[0]?.[0]);

      const sumRes = makeRes();
      await proxy.handleRequest(makeReq(`${XML_PATH}.${algo}`) as any, sumRes as any);

      expect(String(vi.mocked(sumRes.send).mock.calls[0]?.[0])).toBe(
        createHash(algo).update(filtered).digest("hex"),
      );
      expect(sumRes.status).toHaveBeenCalledWith(200);
    },
  );

  it("does not mistake a metadata checksum for an artifact download", async () => {
    // /com/example/mylib/maven-metadata.xml.sha512 has four path segments, the
    // same depth as an artifact, and used to be parsed as version "mylib".
    const res = makeRes();
    await proxy.handleRequest(makeReq(`${XML_PATH}.sha512`) as any, res as any);
    expect(res.status).not.toHaveBeenCalledWith(404);
  });
});

describe("MavenRegistryProxy – metadata redirects", () => {
  const PATH = "/com/example/mylib/maven-metadata.xml";
  const UPSTREAM = "https://repo1.maven.org/maven2";

  /**
   * Answer the metadata URL with `hops` redirects before the document, then
   * answer deps.dev.
   */
  function mockChain(hops: number, status = 302, xml = makeXml(["1.0.0"])) {
    let call = 0;
    vi.mocked(axios.get).mockImplementation(async (url: string) => {
      if (url.includes("api.deps.dev")) {
        return {
          status: 200,
          headers: {},
          data: {
            versions: [
              {
                versionKey: { version: "1.0.0" },
                publishedAt: new Date(BEFORE_CUTOFF).toISOString(),
              },
            ],
          },
        } as any;
      }
      if (call++ < hops) {
        return {
          status,
          headers: { location: `https://elsewhere.example.com/hop${call}` },
          data: "",
        } as any;
      }
      return { status: 200, headers: {}, data: xml } as any;
    });
  }

  it.each([301, 302, 303, 307, 308])(
    "follows a %i and filters the document it lands on",
    async (status) => {
      mockChain(1, status);

      const res = makeRes();
      await proxy.handleRequest(makeReq(PATH), res);

      expect(res.status).toHaveBeenCalledWith(200);
      expect(vi.mocked(res.send).mock.calls[0]?.[0]).toContain(
        "<version>1.0.0</version>",
      );
      expect(res.redirect).not.toHaveBeenCalled();
    },
  );

  it("resolves a relative Location against the request URL, not the repository root", async () => {
    vi.mocked(axios.get).mockImplementation(async (url: string) => {
      if (url === `${UPSTREAM}${PATH}`) {
        return {
          status: 302,
          headers: { location: "../other/maven-metadata.xml" },
          data: "",
        } as any;
      }
      if (url.includes("api.deps.dev")) {
        return { status: 200, headers: {}, data: { versions: [] } } as any;
      }
      return { status: 200, headers: {}, data: makeXml([]) } as any;
    });

    const res = makeRes();
    await proxy.handleRequest(makeReq(PATH), res);

    expect(vi.mocked(axios.get).mock.calls[1]?.[0]).toBe(
      "https://repo1.maven.org/maven2/com/example/other/maven-metadata.xml",
    );
  });

  it("refuses rather than forward a chain longer than the cap", async () => {
    // Forwarding the redirect would send the client to the upstream and skip
    // the filters entirely — the bypass the following exists to close.
    mockChain(99);

    const res = makeRes();
    await proxy.handleRequest(makeReq(PATH), res);

    expect(res.status).toHaveBeenCalledWith(502);
    expect(res.redirect).not.toHaveBeenCalled();
    expect(res.set).not.toHaveBeenCalledWith("location", expect.anything());
  });

  it("stops following at the cap", async () => {
    mockChain(99);

    await proxy.handleRequest(makeReq(PATH), makeRes());

    const metadataCalls = vi
      .mocked(axios.get)
      .mock.calls.filter((c) => !String(c[0]).includes("api.deps.dev"));
    expect(metadataCalls).toHaveLength(4); // the first request plus 3 hops
  });

  it("passes a non-redirect error status through unchanged", async () => {
    vi.mocked(axios.get).mockResolvedValue({
      status: 404,
      headers: {},
      data: "not found",
    } as any);

    const res = makeRes();
    await proxy.handleRequest(makeReq(PATH), res);

    expect(res.status).toHaveBeenCalledWith(404);
  });
});
