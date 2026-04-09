import { parseArgs as nodeParseArgs } from "node:util";

export interface Config {
  /** Host address to bind on */
  host: string;
  /** Port to listen on */
  port: number;
  /** Upstream registry base URLs per package manager */
  upstreams: {
    npm: string;
    pypi: string;
    rubygems: string;
    go: string;
    composer: string;
    maven: string;
  };
  /** Versions published within this many days are excluded from responses */
  delayDays: number;
}

const OPTIONS = {
  host: {
    type: "string" as const,
    short: "h",
    default: "127.0.0.1",
    description: "Host address to bind on",
  },
  port: {
    type: "string" as const,
    short: "p",
    default: "3000",
    description: "Port to listen on",
  },
  "npm-upstream": {
    type: "string" as const,
    default: "https://registry.npmjs.org",
    description: "Upstream URL for npm",
  },
  "pypi-upstream": {
    type: "string" as const,
    default: "https://pypi.org",
    description: "Upstream URL for PyPI",
  },
  "rubygems-upstream": {
    type: "string" as const,
    default: "https://rubygems.org",
    description: "Upstream URL for RubyGems",
  },
  "go-upstream": {
    type: "string" as const,
    default: "https://proxy.golang.org",
    description: "Upstream URL for Go module proxy",
  },
  "composer-upstream": {
    type: "string" as const,
    default: "https://packagist.org",
    description: "Upstream URL for Composer (Packagist)",
  },
  "maven-upstream": {
    type: "string" as const,
    default: "https://repo1.maven.org/maven2",
    description: "Upstream URL for Maven Central",
  },
  "delay-days": {
    type: "string" as const,
    short: "d",
    default: "7",
    description: "Exclude versions published within this many days",
  },
  help: {
    type: "boolean" as const,
    description: "Show this help message",
  },
};

function buildHelp(): string {
  const lines = ["Usage: tengen [options]", "", "Options:"];
  for (const [name, opt] of Object.entries(OPTIONS)) {
    const short = "short" in opt ? `-${opt.short}, ` : "    ";
    const flag = `  ${short}--${name}${"default" in opt ? " <value>" : ""}`;
    const desc =
      "default" in opt
        ? `${opt.description} (default: ${opt.default})`
        : opt.description;
    lines.push(`${flag.padEnd(36)}${desc}`);
  }
  return lines.join("\n");
}

export function loadConfig(argv = process.argv.slice(2)): Config {
  const { values } = nodeParseArgs({ args: argv, options: OPTIONS });

  if (values["help"]) {
    console.log(buildHelp());
    process.exit(0);
  }

  return {
    host: values["host"] as string,
    port: parseInt(values["port"] as string, 10),
    upstreams: {
      npm: values["npm-upstream"] as string,
      pypi: values["pypi-upstream"] as string,
      rubygems: values["rubygems-upstream"] as string,
      go: values["go-upstream"] as string,
      composer: values["composer-upstream"] as string,
      maven: values["maven-upstream"] as string,
    },
    delayDays: parseFloat(values["delay-days"] as string),
  };
}
