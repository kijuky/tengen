import { describe, it, expect, vi, afterEach } from "vitest";
import { loadConfig } from "./config.ts";

describe("loadConfig", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns defaults when no args are provided", () => {
    const config = loadConfig([]);
    expect(config.port).toBe(3000);
    expect(config.upstreams.npm).toBe("https://registry.npmjs.org");
    expect(config.upstreams.pypi).toBe("https://pypi.org");
    expect(config.upstreams.rubygems).toBe("https://rubygems.org");
    expect(config.upstreams.go).toBe("https://proxy.golang.org");
    expect(config.upstreams.composer).toBe("https://packagist.org");
    expect(config.upstreams.maven).toBe("https://repo.maven.apache.org/maven2");
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
    expect(config.upstreams.npm).toBe("https://my-npm.example.com");
  });

  it("parses --pypi-upstream", () => {
    const config = loadConfig([
      "--pypi-upstream",
      "https://my-pypi.example.com",
    ]);
    expect(config.upstreams.pypi).toBe("https://my-pypi.example.com");
  });

  it("parses --rubygems-upstream", () => {
    const config = loadConfig([
      "--rubygems-upstream",
      "https://my-gems.example.com",
    ]);
    expect(config.upstreams.rubygems).toBe("https://my-gems.example.com");
  });

  it("parses --go-upstream", () => {
    const config = loadConfig(["--go-upstream", "https://my-go.example.com"]);
    expect(config.upstreams.go).toBe("https://my-go.example.com");
  });

  it("parses --composer-upstream", () => {
    const config = loadConfig([
      "--composer-upstream",
      "https://my-composer.example.com",
    ]);
    expect(config.upstreams.composer).toBe("https://my-composer.example.com");
  });

  it("parses --maven-upstream", () => {
    const config = loadConfig([
      "--maven-upstream",
      "https://my-maven.example.com",
    ]);
    expect(config.upstreams.maven).toBe("https://my-maven.example.com");
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
    expect(config.upstreams.npm).toBe("https://npm.example.com");
    expect(config.upstreams.pypi).toBe("https://pypi.example.com");
    expect(config.delayDays).toBe(3);
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
});
