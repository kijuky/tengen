import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { MavenRegistryProxy, parseMavenPath } from "./maven.ts";
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

type SearchDoc = { v: string; timestamp: number };

let proxy: MavenRegistryProxy;

beforeEach(() => {
  vi.resetAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  proxy = new MavenRegistryProxy({
    upstream: "https://repo1.maven.org/maven2",
    delayMs: DELAY_MS,
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
//   2. Maven Central Search API for version timestamps
async function handle(
  path: string,
  xml: string,
  searchDocs: SearchDoc[] = [],
  upstreamStatus = 200,
): Promise<ReturnType<typeof makeRes>> {
  vi.mocked(axios.get)
    .mockResolvedValueOnce({ status: upstreamStatus, data: xml, headers: {} })
    .mockResolvedValueOnce({
      status: 200,
      data: { response: { docs: searchDocs, numFound: searchDocs.length } },
      headers: {},
    });
  const res = makeRes();
  await proxy.handleRequest(makeReq(path), res);
  return res;
}

describe("parseMavenPath", () => {
  it("parses groupId and artifactId from path", () => {
    expect(parseMavenPath("/com/example/mylib/maven-metadata.xml")).toEqual({
      groupId: "com.example",
      artifactId: "mylib",
    });
  });

  it("handles deeply nested groupIds", () => {
    expect(
      parseMavenPath(
        "/org/springframework/boot/spring-boot/maven-metadata.xml",
      ),
    ).toEqual({
      groupId: "org.springframework.boot",
      artifactId: "spring-boot",
    });
  });
});

describe("MavenRegistryProxy – routing", () => {
  it("redirects JARs and POMs as passthrough", async () => {
    const res = makeRes();
    await proxy.handleRequest(
      makeReq("/com/example/mylib/1.0.0/mylib-1.0.0.jar"),
      res,
    );
    expect(res.redirect).toHaveBeenCalledWith(
      302,
      "https://repo1.maven.org/maven2/com/example/mylib/1.0.0/mylib-1.0.0.jar",
    );
  });

  it("responds to maven-metadata.xml with XML content-type (not streamed)", async () => {
    const xml = makeXml(["1.0.0"]);
    const res = await handle("/com/example/mylib/maven-metadata.xml", xml, [
      { v: "1.0.0", timestamp: BEFORE_CUTOFF },
    ]);
    expect(res.type).toHaveBeenCalledWith("application/xml");
    expect(res.send).toHaveBeenCalled();
  });
});

describe("MavenRegistryProxy – metadata filtering", () => {
  it("removes versions published after the cutoff", async () => {
    const xml = makeXml(["1.0.0", "2.0.0"]);
    const res = await handle("/com/example/mylib/maven-metadata.xml", xml, [
      { v: "1.0.0", timestamp: BEFORE_CUTOFF }, // allowed
      { v: "2.0.0", timestamp: AFTER_CUTOFF }, // filtered
    ]);
    const body = vi.mocked(res.send).mock.calls[0][0] as string;
    expect(body).toContain("<version>1.0.0</version>");
    expect(body).not.toContain("<version>2.0.0</version>");
  });

  it("includes versions published exactly at the cutoff", async () => {
    const xml = makeXml(["1.0.0"]);
    const res = await handle("/com/example/mylib/maven-metadata.xml", xml, [
      { v: "1.0.0", timestamp: AT_CUTOFF },
    ]);
    expect(res.status).toHaveBeenCalledWith(200);
    const body = vi.mocked(res.send).mock.calls[0][0] as string;
    expect(body).toContain("<version>1.0.0</version>");
  });

  it("updates <release> and <latest> to the latest allowed version", async () => {
    const xml = makeXml(["1.0.0", "1.1.0", "2.0.0"], "2.0.0", "2.0.0");
    const res = await handle("/com/example/mylib/maven-metadata.xml", xml, [
      { v: "1.0.0", timestamp: BEFORE_CUTOFF },
      { v: "1.1.0", timestamp: BEFORE_CUTOFF + 1000 }, // newest allowed
      { v: "2.0.0", timestamp: AFTER_CUTOFF },
    ]);
    const body = vi.mocked(res.send).mock.calls[0][0] as string;
    expect(body).toContain("<release>1.1.0</release>");
    expect(body).toContain("<latest>1.1.0</latest>");
  });

  it("returns 404 when all versions are filtered out", async () => {
    const xml = makeXml(["2.0.0"]);
    const res = await handle("/com/example/mylib/maven-metadata.xml", xml, [
      { v: "2.0.0", timestamp: AFTER_CUTOFF },
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
  it("returns SHA1 of the filtered XML for .sha1 path", async () => {
    const xml = makeXml(["1.0.0"]);
    const expected = createHash("sha1").update(xml).digest("hex");
    const res = await handle(
      "/com/example/mylib/maven-metadata.xml.sha1",
      xml,
      [{ v: "1.0.0", timestamp: BEFORE_CUTOFF }],
    );
    expect(res.status).toHaveBeenCalledWith(200);
    const body = vi.mocked(res.send).mock.calls[0][0] as string;
    expect(body).toBe(expected);
  });

  it("returns MD5 of the filtered XML for .md5 path", async () => {
    const xml = makeXml(["1.0.0"]);
    const expected = createHash("md5").update(xml).digest("hex");
    const res = await handle("/com/example/mylib/maven-metadata.xml.md5", xml, [
      { v: "1.0.0", timestamp: BEFORE_CUTOFF },
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
      [{ v: "2.0.0", timestamp: AFTER_CUTOFF }],
    );
    expect(res.status).toHaveBeenCalledWith(404);
  });
});

describe("MavenRegistryProxy – malicious filtering", () => {
  // Maven OSV package name format: "groupId:artifactId"
  // /com/example/evil/maven-metadata.xml → "com.example:evil"
  // /com/example/mylib/maven-metadata.xml → "com.example:mylib"
  const MALICIOUS_DB = JSON.stringify({
    maliciousPackages: ["com.example:evil"],
    maliciousVersions: { "com.example:mylib": ["1.0.0"] },
  });

  let maliciousProxy: MavenRegistryProxy;

  beforeEach(() => {
    mockReadFileSync.mockReturnValue(MALICIOUS_DB);
    maliciousProxy = new MavenRegistryProxy({
      upstream: "https://repo1.maven.org/maven2",
      delayMs: DELAY_MS,
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
        data: { response: { docs: [{ v: "1.0.0", timestamp: BEFORE_CUTOFF }], numFound: 1 } },
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
          response: {
            docs: [
              { v: "1.0.0", timestamp: BEFORE_CUTOFF }, // malicious → blocked
              { v: "2.0.0", timestamp: BEFORE_CUTOFF + 1000 }, // safe → allowed
            ],
            numFound: 2,
          },
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
