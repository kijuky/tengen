import type { Request, Response } from 'express';
import axios, { type AxiosResponse } from 'axios';

export interface RegistryConfig {
  /** Upstream registry base URL */
  upstream: string;
  /** Filter out versions published within this many milliseconds */
  delayMs: number;
}

export interface VersionMetadata {
  version: string;
  published: Date;
}

export interface MetadataRouting<
  MetadataType,
  VersionMetadataType = VersionMetadata,
> {
  condition: (req: Request) => boolean;
  requestUpstream?: (
    originalReq: Request,
  ) => Promise<AxiosResponse<MetadataType, any, {}>>;
  getVersions: (
    metadata: MetadataType,
    req: Request,
  ) => Promise<VersionMetadataType[]> | VersionMetadataType[];
  filterMetadata: (
    metadata: MetadataType,
    allowedVersions: VersionMetadataType[],
    req: Request,
  ) => Promise<MetadataType> | MetadataType;
  respond?: (
    res: Response,
    filteredMetadata: MetadataType,
    req: Request,
  ) => void;
}

/**
 * Base class for registry proxies.
 *
 * To add a new registry (e.g. PyPI, RubyGems), extend this class and override
 * handleRequest(req, res) to implement registry-specific routing and filtering.
 */
export abstract class RegistryProxy {
  /** The human-readable name of this registry (e.g. "npm", "pypi") */
  abstract readonly name: string;
  protected readonly config: RegistryConfig;
  private readonly metadataRouting: MetadataRouting<any, any>[] = [];

  constructor(config: RegistryConfig) {
    this.config = config;
    this.setRouting();
  }

  protected setRouting() {}

  protected addMetadataRoute<T, U extends VersionMetadata = VersionMetadata>(
    route: MetadataRouting<T, U>,
  ) {
    this.metadataRouting.push(route);
  }

  /** Build the full upstream URL from an incoming request. */
  protected buildUpstreamUrl(req: Request): string {
    const base = this.config.upstream.replace(/\/$/, '');
    const reqUrl = new URL(req.url, 'http://dummy');
    return `${base}${reqUrl.pathname}${reqUrl.search}`;
  }

  /** Entry point called by the Express router for every incoming request. */
  async handleRequest(req: Request, res: Response) {
    for (const route of this.metadataRouting) {
      if (route.condition(req)) {
        route.requestUpstream ??= async () => {
          return await axios.get(this.buildUpstreamUrl(req), {
            validateStatus: () => true,
            maxRedirects: 0,
          });
        };
        const response = await route.requestUpstream(req);
        if (response.status !== 200) {
          res
            .status(response.status)
            .type(response.headers['content-type'] || 'application/json')
            .send(response.data);
          return;
        }
        const metadata = response.data;
        const versions = await route.getVersions(metadata, req);
        const filteredVersions = this.filterVersions(versions);
        const filteredMetadata = await route.filterMetadata(
          metadata,
          filteredVersions,
          req,
        );
        if (route.respond) {
          route.respond(res, filteredMetadata, req);
        } else {
          res.status(200).json(filteredMetadata);
        }
        return;
      }
    }
    await this.handlePassthrough(req, res);
  }

  protected handlePassthrough(req: Request, res: Response): void {
    res.redirect(302, this.buildUpstreamUrl(req));
  }

  protected filterVersions(versions: VersionMetadata[]) {
    const cutoffDate = new Date(Date.now() - this.config.delayMs);
    return versions.filter((v) => v.published <= cutoffDate);
  }
}
