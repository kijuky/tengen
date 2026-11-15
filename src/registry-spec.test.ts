import { describe, it, expect } from "vitest";
import {
  RegistrySpecError,
  defaultTimestampSource,
  parseRegistrySpec,
  resolveRegistries,
} from "./registry-spec.ts";

describe("parseRegistrySpec", () => {
  it("names the registry after its type unless told otherwise", () => {
    expect(parseRegistrySpec("npm=https://npm.example.com")).toEqual({
      type: "npm",
      name: "npm",
      upstreams: [{ url: "https://npm.example.com" }],
    });
    expect(parseRegistrySpec("maven:internal=https://m2.example.com").name).toBe(
      "internal",
    );
  });

  it("reads two or more upstreams as a group, in the order written", () => {
    const spec = parseRegistrySpec(
      "maven=https://repo.maven.apache.org/maven2,https://m2.example.com/",
    );
    expect(spec.upstreams).toEqual([
      { url: "https://repo.maven.apache.org/maven2", timestamps: "deps-dev" },
      { url: "https://m2.example.com", timestamps: "last-modified" },
    ]);
  });

  it("reads upstream settings from the URL fragment", () => {
    const spec = parseRegistrySpec(
      "ivy=https://ivy.example.com/releases#index=artifactory,https://ivy.example.com/snapshots",
    );
    expect(spec.upstreams).toEqual([
      { url: "https://ivy.example.com/releases", index: "artifactory" },
      { url: "https://ivy.example.com/snapshots" },
    ]);
  });

  it("lets a fragment override the timestamp source", () => {
    const spec = parseRegistrySpec(
      "maven=https://mirror.example.com/central#timestamps=deps-dev",
    );
    expect(spec.upstreams[0]).toEqual({
      url: "https://mirror.example.com/central",
      timestamps: "deps-dev",
    });
  });

  it("reads registry settings after ';'", () => {
    expect(
      parseRegistrySpec(
        "npm=https://registry.npmjs.org;public-url=https://npm.example.com/",
      ).publicUrl,
    ).toBe("https://npm.example.com");
  });

  it.each([
    ["no '='", "npm"],
    ["no upstream", "npm="],
    ["an unknown type", "cargo=https://a.example.com"],
    ["an invalid name", "maven:Internal=https://a.example.com"],
    ["a relative upstream", "npm=/npm"],
    ["a non-http upstream", "npm=ftp://a.example.com"],
    ["a group of a type that cannot group", "npm=https://a.example.com,https://b.example.com"],
    ["an upstream setting the type does not use", "npm=https://a.example.com#index=artifactory"],
    ["an unknown index source", "ivy=https://a.example.com#index=nexus"],
    ["an unknown timestamp source", "maven=https://a.example.com#timestamps=git"],
    ["an unknown registry setting", "npm=https://a.example.com;cache=off"],
    ["a public URL for Maven", "maven=https://a.example.com;public-url=https://b.example.com"],
    ["a public URL for Ivy", "ivy=https://a.example.com;public-url=https://b.example.com"],
    ["a relative public URL", "npm=https://a.example.com;public-url=/npm"],
    ["a public URL given twice", "npm=https://a.example.com;public-url=https://b.example.com;public-url=https://c.example.com"],
  ])("refuses %s", (_label, raw) => {
    expect(() => parseRegistrySpec(raw)).toThrow(RegistrySpecError);
  });
});

describe("defaultTimestampSource", () => {
  it.each([
    ["maven", "https://repo.maven.apache.org/maven2", "deps-dev"],
    ["maven", "https://repo1.maven.org/maven2", "deps-dev"],
    ["maven", "https://maven-central.storage-download.googleapis.com/maven2", "deps-dev"],
    ["maven", "https://repo.scala-sbt.org/scalasbt/maven-releases", "last-modified"],
    ["gradle-plugins", "https://plugins.gradle.org/m2", "deps-dev"],
  ] as const)("dates %s at %s from %s", (type, url, expected) => {
    expect(defaultTimestampSource(type, url)).toBe(expected);
  });
});

describe("resolveRegistries", () => {
  it("fills in the built-in registries that were not declared", () => {
    const registries = resolveRegistries(
      [parseRegistrySpec("ivy=https://ivy.example.com")],
      { npm: "https://npm.example.com" },
    );
    expect(registries.map((r) => `${r.name}=${r.upstreams[0]!.url}`)).toEqual([
      "npm=https://npm.example.com",
      "pypi=https://pypi.org",
      "rubygems=https://rubygems.org",
      "go=https://proxy.golang.org",
      "composer=https://packagist.org",
      "maven=https://repo.maven.apache.org/maven2",
      "gradle-plugins=https://plugins.gradle.org/m2",
      "ivy=https://ivy.example.com",
    ]);
  });

  it("refuses a name declared twice", () => {
    expect(() =>
      resolveRegistries(
        [
          parseRegistrySpec("maven:x=https://a.example.com"),
          parseRegistrySpec("ivy:x=https://b.example.com"),
        ],
        {},
      ),
    ).toThrow("declared more than once");
  });

  it("refuses a registry that takes a built-in one's name with another type", () => {
    expect(() =>
      resolveRegistries([parseRegistrySpec("ivy:maven=https://a.example.com")], {}),
    ).toThrow("taken by the built-in maven registry");
  });
});
