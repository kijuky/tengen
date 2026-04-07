import type { Request, Response } from "express";
import axios, {
  type AxiosResponseHeaders,
  type RawAxiosResponseHeaders,
} from "axios";

export interface RegistryConfig {
  /** Upstream registry base URL */
  upstream: string;
  /** Filter out versions published within this many milliseconds */
  delayMs: number;
}

/**
 * Base class for registry proxies.
 *
 * To add a new registry (e.g. PyPI, RubyGems), extend this class and implement:
 *   - isMetadataPath(path): return true if the request is for package metadata
 *   - filterMetadata(data, cutoffDate): filter out versions newer than cutoffDate
 */
export abstract class RegistryProxy {
  protected readonly config: RegistryConfig;

  constructor(config: RegistryConfig) {
    this.config = config;
  }

  /** The human-readable name of this registry (e.g. "npm", "pypi") */
  abstract readonly name: string;

  /**
   * Returns true if this request path is for package metadata (JSON),
   * as opposed to binary artifacts (tarballs, wheels, gems, etc.).
   */
  abstract isMetadataPath(path: string): boolean;

  /**
   * Filter the upstream metadata, removing any versions released
   * after cutoffDate.  Must not mutate the original object.
   * Returns null when all versions are filtered out (treat as 404).
   */
  abstract filterMetadata(data: unknown, cutoffDate: Date): unknown | null;

  /** Entry point called by the Express router for every incoming request. */
  async handleRequest(req: Request, res: Response): Promise<void> {
    const cutoffDate = new Date(Date.now() - this.config.delayMs);
    const upstreamUrl = `${this.config.upstream}${req.url}`;

    try {
      if (this.isMetadataPath(req.path)) {
        await this.handleMetadataRequest(req, res, upstreamUrl, cutoffDate);
      } else {
        await this.handlePassthrough(req, res, upstreamUrl);
      }
    } catch (err) {
      if (!res.headersSent) {
        res.status(502).json({ error: "Bad Gateway", message: String(err) });
      }
    }
  }

  private async handleMetadataRequest(
    req: Request,
    res: Response,
    upstreamUrl: string,
    cutoffDate: Date,
  ): Promise<void> {
    const response = await axios.get<unknown>(upstreamUrl, {
      headers: this.selectForwardHeaders(req),
      validateStatus: () => true,
    });

    if (response.status !== 200) {
      res.status(response.status).json(response.data);
      return;
    }

    const filtered = this.filterMetadata(response.data, cutoffDate);
    if (filtered === null) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    res.status(200).json(filtered);
  }

  private async handlePassthrough(
    req: Request,
    res: Response,
    upstreamUrl: string,
  ): Promise<void> {
    const response = await axios.get<NodeJS.ReadableStream>(upstreamUrl, {
      headers: this.selectForwardHeaders(req),
      responseType: "stream",
      validateStatus: () => true,
    });

    res.status(response.status);
    this.forwardResponseHeaders(response.headers, res);
    response.data.pipe(res);
  }

  private selectForwardHeaders(req: Request): Record<string, string> {
    const headers: Record<string, string> = {};
    const forward = ["accept", "accept-encoding", "authorization"];
    for (const key of forward) {
      const value = req.headers[key];
      if (typeof value === "string") headers[key] = value;
    }
    return headers;
  }

  private forwardResponseHeaders(
    headers: AxiosResponseHeaders | RawAxiosResponseHeaders,
    res: Response,
  ): void {
    const skip = new Set(["transfer-encoding", "connection"]);
    for (const [key, value] of Object.entries(headers)) {
      if (!skip.has(key.toLowerCase()) && value !== undefined) {
        res.setHeader(key, value as string | string[]);
      }
    }
  }
}
