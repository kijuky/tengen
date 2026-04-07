import express from "express";
import type { Config } from "./config.ts";
import { NpmRegistryProxy } from "./registries/npm.ts";

export function createServer(config: Config): express.Express {
  const app = express();

  const npmRegistry = new NpmRegistryProxy({
    upstream: config.upstream,
    delayMs: config.delayDays * 24 * 60 * 60 * 1000,
  });

  app.use("/npm", (req, res) => {
    npmRegistry.handleRequest(req, res).catch((err) => {
      if (!res.headersSent) {
        res
          .status(500)
          .json({ error: "Internal Server Error", message: String(err) });
      }
    });
  });

  return app;
}
