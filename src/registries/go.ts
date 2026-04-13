import axios from 'axios';
import type { Request, Response } from 'express';
import { RegistryProxy, type VersionMetadata } from './base.ts';

interface GoVersionInfo {
  Version: string;
  Time: string;
}

export class GoRegistryProxy extends RegistryProxy {
  readonly name = 'go';

  public setRouting() {
    this.addMetadataRoute<string>({
      condition: (req) => req.path.endsWith('/@v/list'),
      getVersions: (metadata, req) => this.getListVersions(metadata, req),
      filterMetadata: filterListText,
      respond: respondList,
    });
  }

  async handleRequest(req: Request, res: Response) {
    if (req.path.endsWith('/@latest')) {
      await this.handleLatest(req, res);
      return;
    }
    await super.handleRequest(req, res);
  }

  private async getListVersions(
    metadata: string,
    req: Request,
  ): Promise<VersionMetadata[]> {
    const origin = new URL(this.config.upstream).origin;
    const modulePath = req.path.slice(0, req.path.length - '/@v/list'.length);
    const infos = await fetchAllInfos(origin, modulePath, metadata);
    return infos.map((v) => ({
      version: v.Version,
      published: new Date(v.Time),
    }));
  }

  private async handleLatest(req: Request, res: Response): Promise<void> {
    const origin = new URL(this.config.upstream).origin;
    const latestRes = await axios.get<GoVersionInfo>(
      this.buildUpstreamUrl(req),
      {
        validateStatus: () => true,
        maxRedirects: 0,
      },
    );
    if (latestRes.status !== 200) {
      res
        .status(latestRes.status)
        .type(latestRes.headers['content-type'] || 'plain/text')
        .send(latestRes.data);
      return;
    }
    const latestInfo = latestRes.data;
    const [latestAllowed] = this.filterVersions([
      { version: latestInfo.Version, published: new Date(latestInfo.Time) },
    ]);
    if (latestAllowed) {
      res.status(200).json(latestInfo);
      return;
    }
    // Latest is too new — fetch full list and find newest allowed version
    const modulePath = req.path.slice(0, req.path.length - '/@latest'.length);
    const listRes = await axios.get<string>(`${origin}${modulePath}/@v/list`, {
      responseType: 'text',
      validateStatus: () => true,
      maxRedirects: 0,
    });
    if (listRes.status !== 200) {
      res.status(404).send('not found');
      return;
    }
    const infos = await fetchAllInfos(origin, modulePath, listRes.data);
    const allowedSet = new Set(
      this.filterVersions(
        infos.map((v) => ({ version: v.Version, published: new Date(v.Time) })),
      ).map((v) => v.version),
    );
    const allowedInfos = infos
      .filter((v) => allowedSet.has(v.Version))
      .sort((a, b) => new Date(b.Time).getTime() - new Date(a.Time).getTime());
    if (allowedInfos.length === 0) {
      res.status(404).send('not found');
      return;
    }
    res.status(200).json(allowedInfos[0]);
  }
}

function filterListText(
  metadata: string,
  allowedVersions: VersionMetadata[],
): string {
  const allowed = new Set(allowedVersions.map((v) => v.version));
  const lines = metadata
    .split('\n')
    .filter((v) => v.trim() && allowed.has(v.trim()));
  return lines.length > 0 ? lines.join('\n') + '\n' : '';
}

function respondList(res: Response, filteredText: string): void {
  if (!filteredText) {
    res.status(404).send('');
    return;
  }
  res.status(200).type('text/plain').send(filteredText);
}

async function fetchAllInfos(
  origin: string,
  modulePath: string,
  listText: string,
): Promise<GoVersionInfo[]> {
  const versions = listText.split('\n').filter((v) => v.trim());
  const infos = await Promise.all(
    versions.map((v) => fetchGoInfo(origin, modulePath, v)),
  );
  return infos.filter((v): v is GoVersionInfo => v !== null);
}

async function fetchGoInfo(
  origin: string,
  modulePath: string,
  version: string,
): Promise<GoVersionInfo | null> {
  try {
    const res = await axios.get<GoVersionInfo>(
      `${origin}${modulePath}/@v/${version}.info`,
      { validateStatus: () => true, maxRedirects: 0 },
    );
    if (res.status === 200 && res.data.Time) return res.data;
  } catch {
    // ignore
  }
  return null;
}
