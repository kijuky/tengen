import { describe, it, expect, vi, afterEach } from "vitest";
import { loadConfig, type Config } from "./config.ts";

/** The first upstream URL of the registry mounted at `name`. */
function upstreamOf(config: Config, name: string): string | undefined {
  return config.registries.find((r) => r.name === name)?.upstreams[0]?.url;
}

describe("loadConfig", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns defaults when no args are provided", () => {
    const config = loadConfig([]);
    expect(config.port).toBe(3000);
    expect(upstreamOf(config, "npm")).toBe("https://registry.npmjs.org");
    expect(upstreamOf(config, "pypi")).toBe("https://pypi.org");
    expect(upstreamOf(config, "rubygems")).toBe("https://rubygems.org");
    expect(upstreamOf(config, "go")).toBe("https://proxy.golang.org");
    expect(upstreamOf(config, "composer")).toBe("https://packagist.org");
    expect(upstreamOf(config, "maven")).toBe("https://repo.maven.apache.org/maven2");
    expect(config.delayDays).toBe(7);
  });

  it("parses --port", () => {
    const config = loadConfig(["--port", "8080"]);
    expect(config.port).toBe(8080);
  });

  it("parses -p shorthand", () => {
    const config = loadConfig(["-p", "9000"]);
    expect(config.port).toBe(9000);
  });

  it("parses --npm-upstream", () => {
    const config = loadConfig(["--npm-upstream", "https://my-npm.example.com"]);
    expect(upstreamOf(config, "npm")).toBe("https://my-npm.example.com");
  });

  it("parses --pypi-upstream", () => {
    const config = loadConfig([
      "--pypi-upstream",
      "https://my-pypi.example.com",
    ]);
    expect(upstreamOf(config, "pypi")).toBe("https://my-pypi.example.com");
  });

  it("parses --rubygems-upstream", () => {
    const config = loadConfig([
      "--rubygems-upstream",
      "https://my-gems.example.com",
    ]);
    expect(upstreamOf(config, "rubygems")).toBe("https://my-gems.example.com");
  });

  it("parses --go-upstream", () => {
    const config = loadConfig(["--go-upstream", "https://my-go.example.com"]);
    expect(upstreamOf(config, "go")).toBe("https://my-go.example.com");
  });

  it("parses --composer-upstream", () => {
    const config = loadConfig([
      "--composer-upstream",
      "https://my-composer.example.com",
    ]);
    expect(upstreamOf(config, "composer")).toBe("https://my-composer.example.com");
  });

  it("parses --maven-upstream", () => {
    const config = loadConfig([
      "--maven-upstream",
      "https://my-maven.example.com",
    ]);
    expect(upstreamOf(config, "maven")).toBe("https://my-maven.example.com");
  });

  it("parses --delay-days", () => {
    const config = loadConfig(["--delay-days", "14"]);
    expect(config.delayDays).toBe(14);
  });

  it("parses -d shorthand", () => {
    const config = loadConfig(["-d", "30"]);
    expect(config.delayDays).toBe(30);
  });

  it("parses fractional delay days", () => {
    const config = loadConfig(["--delay-days", "0.5"]);
    expect(config.delayDays).toBe(0.5);
  });

  it("parses multiple options together", () => {
    const config = loadConfig([
      "-p",
      "4000",
      "--npm-upstream",
      "https://npm.example.com",
      "--pypi-upstream",
      "https://pypi.example.com",
      "-d",
      "3",
    ]);
    expect(config.port).toBe(4000);
    expect(upstreamOf(config, "npm")).toBe("https://npm.example.com");
    expect(upstreamOf(config, "pypi")).toBe("https://pypi.example.com");
    expect(config.delayDays).toBe(3);
  });

  it("defaults upstreamAccess to direct", () => {
    const config = loadConfig([]);
    expect(config.upstreamAccess).toBe("direct");
  });

  it("parses --upstream-access proxied (with required --base-url)", () => {
    const config = loadConfig([
      "--upstream-access",
      "proxied",
      "--base-url",
      "https://tengen.example.com",
    ]);
    expect(config.upstreamAccess).toBe("proxied");
  });

  it("exits with an error when --upstream-access proxied is missing --base-url", () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit called");
    });

    expect(() => loadConfig(["--upstream-access", "proxied"])).toThrow(
      "process.exit called",
    );
    expect(errSpy).toHaveBeenCalled();
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("exits with an error on an invalid --upstream-access", () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit called");
    });

    expect(() => loadConfig(["--upstream-access", "bogus"])).toThrow(
      "process.exit called",
    );
    expect(errSpy).toHaveBeenCalled();
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("leaves baseUrl undefined by default", () => {
    const config = loadConfig([]);
    expect(config.baseUrl).toBeUndefined();
  });

  it("parses --base-url", () => {
    const config = loadConfig(["--base-url", "https://tengen.example.com"]);
    expect(config.baseUrl).toBe("https://tengen.example.com");
  });

  it("strips a trailing slash from --base-url", () => {
    const config = loadConfig(["--base-url", "https://tengen.example.com/"]);
    expect(config.baseUrl).toBe("https://tengen.example.com");
  });

  it("exits with an error on a non-http(s) --base-url", () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit called");
    });

    expect(() => loadConfig(["--base-url", "ftp://nope.example.com"])).toThrow(
      "process.exit called",
    );
    expect(errSpy).toHaveBeenCalled();
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("exits with an error on a malformed --base-url", () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit called");
    });

    expect(() => loadConfig(["--base-url", "not a url"])).toThrow(
      "process.exit called",
    );
    expect(errSpy).toHaveBeenCalled();
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("prints help and calls process.exit(0) when --help is passed", () => {
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit called");
    });

    expect(() => loadConfig(["--help"])).toThrow("process.exit called");
    expect(consoleSpy).toHaveBeenCalledOnce();
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  /** Run loadConfig expecting it to exit with an error; returns the message. */
  function loadConfigError(args: string[]): string {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit called");
    });
    expect(() => loadConfig(args)).toThrow("process.exit called");
    expect(exitSpy).toHaveBeenCalledWith(1);
    return String(errSpy.mock.calls[0]?.[0]);
  }

  it("serves the built-in registries, and no Ivy one, by default", () => {
    const config = loadConfig([]);
    expect(config.registries.map((r) => r.name)).toEqual([
      "npm",
      "pypi",
      "rubygems",
      "go",
      "composer",
      "maven",
      "gradle-plugins",
    ]);
  });

  it("replaces a built-in registry with a --registry of its type", () => {
    const config = loadConfig([
      "--registry",
      "maven=https://a.example.com/m2,https://b.example.com/m2",
    ]);
    const maven = config.registries.find((r) => r.name === "maven");
    expect(maven?.upstreams.map((u) => u.url)).toEqual([
      "https://a.example.com/m2",
      "https://b.example.com/m2",
    ]);
    expect(config.registries.filter((r) => r.name === "maven")).toHaveLength(1);
  });

  it("adds a --registry with its own name after the built-in ones", () => {
    const config = loadConfig([
      "--registry",
      "ivy=https://a.example.com/ivy#index=artifactory",
      "--registry",
      "maven:internal=https://m2.example.com",
    ]);
    expect(config.registries.slice(-2)).toEqual([
      {
        type: "ivy",
        name: "ivy",
        upstreams: [{ url: "https://a.example.com/ivy", index: "artifactory" }],
      },
      {
        type: "maven",
        name: "internal",
        upstreams: [{ url: "https://m2.example.com", timestamps: "last-modified" }],
      },
    ]);
  });

  it("refuses a registry set by both --<type>-upstream and --registry", () => {
    expect(
      loadConfigError([
        "--npm-upstream",
        "https://a.example.com",
        "--registry",
        "npm=https://b.example.com",
      ]),
    ).toContain("both --npm-upstream and --registry");
  });

  it("treats --gradle-plugins-upstream as the gradle-plugins registry", () => {
    const config = loadConfig([
      "--gradle-plugins-upstream",
      "https://plugins.example.com/m2",
    ]);
    expect(config.registries.find((r) => r.name === "gradle-plugins")).toEqual({
      type: "gradle-plugins",
      name: "gradle-plugins",
      upstreams: [{ url: "https://plugins.example.com/m2", timestamps: "deps-dev" }],
    });
  });

  it("refuses a malformed --registry", () => {
    expect(loadConfigError(["--registry", "nope=https://a.example.com"])).toContain(
      "unknown registry type",
    );
  });
});
