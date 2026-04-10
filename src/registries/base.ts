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
 * To add a new registry (e.g. PyPI, RubyGems), extend this class and override
 * handleRequest(req, res) to implement registry-specific routing and filtering.
 */
export abstract class RegistryProxy {
  protected readonly config: RegistryConfig;

  constructor(config: RegistryConfig) {
    this.config = config;
  }

  /** The human-readable name of this registry (e.g. "npm", "pypi") */
  abstract readonly name: string;

  /** Build the full upstream URL from an incoming request. */
  protected buildUpstreamUrl(req: Request): string {
    const base = this.config.upstream.replace(/\/$/, "");
    const reqUrl = new URL(req.url, "http://dummy");
    return `${base}${reqUrl.pathname}${reqUrl.search}`;
  }

  /** Entry point called by the Express router for every incoming request. */
  abstract handleRequest(req: Request, res: Response): Promise<void>;

  /**
   * Fetch JSON from upstreamUrl, apply filter, and write the response.
   * Handles non-200 upstream status and null filter result (→ 404) automatically.
   */
  protected async handleFilteredJson(
    res: Response,
    upstreamUrl: string,
    filter: (data: unknown) => unknown | null,
  ): Promise<void> {
    const response = await axios.get<unknown>(upstreamUrl, {
      validateStatus: () => true,
      maxRedirects: 0,
    });
    if (response.status !== 200) {
      res.status(response.status).json(response.data);
      return;
    }
    const filtered = filter(response.data);
    if (filtered === null) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    res.status(200).json(filtered);
  }

  protected async handlePassthrough(
    req: Request,
    res: Response,
  ): Promise<void> {
    const upstreamUrl = this.buildUpstreamUrl(req);
    const response = await axios.get<NodeJS.ReadableStream>(upstreamUrl, {
      responseType: "stream",
      validateStatus: () => true,
      maxRedirects: 0,
    });

    res.status(response.status);
    this.forwardResponseHeaders(response.headers, res);
    response.data.pipe(res);
  }

  private forwardResponseHeaders(
    headers: AxiosResponseHeaders | RawAxiosResponseHeaders,
    res: Response,
  ): void {
    const skip = new Set(["transfer-encoding", "connection", "accept"]);
    for (const [key, value] of Object.entries(headers)) {
      if (!skip.has(key.toLowerCase()) && value !== undefined) {
        res.setHeader(key, value as string | string[]);
      }
    }
  }
}
