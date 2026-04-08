import express from "express";
import type { Config } from "./config.ts";
import { MavenRegistryProxy } from "./registries/maven.ts";
import { NpmRegistryProxy } from "./registries/npm.ts";
import { PypiRegistryProxy } from "./registries/pypi.ts";
import { RubygemsRegistryProxy } from "./registries/rubygems.ts";
import { GoRegistryProxy } from "./registries/go.ts";
import { ComposerRegistryProxy } from "./registries/composer.ts";

export function createServer(config: Config): express.Express {
  const app = express();

  const delayMs = config.delayDays * 24 * 60 * 60 * 1000;

  const registries = [
    new NpmRegistryProxy({ upstream: config.upstreams.npm, delayMs }),
    new PypiRegistryProxy({ upstream: config.upstreams.pypi, delayMs }),
    new RubygemsRegistryProxy({ upstream: config.upstreams.rubygems, delayMs }),
    new GoRegistryProxy({ upstream: config.upstreams.go, delayMs }),
    new ComposerRegistryProxy({ upstream: config.upstreams.composer, delayMs }),
    new MavenRegistryProxy({ upstream: config.upstreams.maven, delayMs }),
  ];

  for (const registry of registries) {
    app.use(`/${registry.name}`, (req, res) => {
      const start = Date.now();
      console.log(`[${registry.name}] ${req.method} ${req.path}`);

      res.on("finish", () => {
        const ms = Date.now() - start;
        console.log(
          `[${registry.name}] ${req.method} ${req.path} -> ${res.statusCode} (${ms}ms)`
        );
      });

      registry.handleRequest(req, res).catch((err) => {
        console.error(`[${registry.name}] ${req.method} ${req.path} error:`, err);
        if (!res.headersSent) {
          res
            .status(500)
            .json({ error: "Internal Server Error", message: String(err) });
        }
      });
    });
  }

  return app;
}
