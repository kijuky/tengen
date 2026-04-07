import { parseArgs as nodeParseArgs } from "node:util";

export interface Config {
  /** Port to listen on */
  port: number;
  /** Upstream registry base URL (e.g. https://registry.npmjs.org) */
  upstream: string;
  /** Versions published within this many days are excluded from responses */
  delayDays: number;
}

const OPTIONS = {
  port: {
    type: "string" as const,
    short: "p",
    default: "3000",
    description: "Port to listen on",
  },
  upstream: {
    type: "string" as const,
    short: "u",
    default: "https://registry.npmjs.org",
    description: "Upstream registry base URL",
  },
  "delay-days": {
    type: "string" as const,
    short: "d",
    default: "7",
    description: "Exclude versions published within this many days",
  },
  help: {
    type: "boolean" as const,
    short: "h",
    description: "Show this help message",
  },
};

function buildHelp(): string {
  const lines = ["Usage: tengen [options]", "", "Options:"];
  for (const [name, opt] of Object.entries(OPTIONS)) {
    const flag = `  -${opt.short}, --${name}${"default" in opt ? " <value>" : ""}`;
    const desc =
      "default" in opt
        ? `${opt.description} (default: ${opt.default})`
        : opt.description;
    lines.push(`${flag.padEnd(32)}${desc}`);
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
    port: parseInt(values["port"] as string, 10),
    upstream: values["upstream"] as string,
    delayDays: parseFloat(values["delay-days"] as string),
  };
}
