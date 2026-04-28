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
    this.addCustomRoute({
      condition: (req) => req.path.endsWith('/@latest'),
      handle: (req, res) => this.handleLatest(req, res),
    });

    this.addMetadataRoute<string>({
      condition: (req) => req.path.endsWith('/@v/list'),
      getVersions: (metadata, req) => this.getListVersions(metadata, req),
      filterMetadata: filterListText,
      respond: respondList,
    });

    this.addDownloadRoute({
      condition: (req) => /\/@v\/[^/]+\.(zip|mod)$/.test(req.path),
      getVersionMetadata: (req) => this.getDownloadVersionMetadata(req),
    });
  }

  private async getDownloadVersionMetadata(
    req: Request,
  ): Promise<VersionMetadata | null> {
    const origin = new URL(this.config.upstream).origin;
    const match = req.path.match(/^(.+)\/@v\/([^/]+)\.(zip|mod)$/);
    if (!match) return null;
    const [, modulePath, version] = match;
    const packageName = modulePath.slice(1);
    const info = await fetchGoInfo(origin, modulePath, version);
    if (!info) return null;
    return {
      packageName,
      version: info.Version,
      published: new Date(info.Time),
    };
  }

  private async getListVersions(
    metadata: string,
    req: Request,
  ): Promise<VersionMetadata[]> {
    const origin = new URL(this.config.upstream).origin;
    const modulePath = req.path.slice(0, req.path.length - '/@v/list'.length);
    const packageName = modulePath.slice(1);

    // golang.org/toolchain has a huge number of versions (one per Go version × architecture).
    // Only fetch .info for one representative per Go version and apply its publish time to all arch variants.
    if (isToolchainModule(modulePath)) {
      const allVersions = metadata.split('\n').filter((v) => v.trim());
      const { representatives, groupMap } =
        deduplicateToolchainVersions(allVersions);
      const repInfos = await fetchAllInfos(
        origin,
        modulePath,
        representatives.join('\n'),
      );
      const infoByVersion = new Map(repInfos.map((i) => [i.Version, i]));
      const result: VersionMetadata[] = [];
      for (const [, group] of groupMap) {
        // Expand the representative's info to all arch variants of this Go version
        const info = infoByVersion.get(group[0]);
        if (!info) continue;
        for (const v of group) {
          result.push({
            packageName,
            version: v,
            published: new Date(info.Time),
          });
        }
      }
      return result;
    }

    const infos = await fetchAllInfos(origin, modulePath, metadata);
    return infos.map((v) => ({
      packageName,
      version: v.Version,
      published: new Date(v.Time),
    }));
  }

  private async handleLatest(req: Request, res: Response): Promise<void> {
    const origin = new URL(this.config.upstream).origin;
    const modulePath = req.path.slice(0, req.path.length - '/@latest'.length);
    const packageName = modulePath.slice(1);
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
      {
        packageName,
        version: latestInfo.Version,
        published: new Date(latestInfo.Time),
      },
    ]);
    if (latestAllowed) {
      res.status(200).json(latestInfo);
      return;
    }
    // Latest is too new — fetch full list and find newest allowed version
    const listRes = await axios.get<string>(`${origin}${modulePath}/@v/list`, {
      responseType: 'text',
      validateStatus: () => true,
      maxRedirects: 0,
    });
    if (listRes.status !== 200) {
      res.status(404).send('not found');
      return;
    }
    // For toolchain, only fetch .info for one representative per Go version
    let infos: GoVersionInfo[];
    if (isToolchainModule(modulePath)) {
      const allVersions = listRes.data
        .split('\n')
        .filter((v: string) => v.trim());
      const { representatives } = deduplicateToolchainVersions(allVersions);
      infos = await fetchAllInfos(
        origin,
        modulePath,
        representatives.join('\n'),
      );
    } else {
      infos = await fetchAllInfos(origin, modulePath, listRes.data);
    }
    const allowedSet = new Set(
      this.filterVersions(
        infos.map((v) => ({
          packageName,
          version: v.Version,
          published: new Date(v.Time),
        })),
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

function isToolchainModule(modulePath: string): boolean {
  const cleaned = modulePath.startsWith('/') ? modulePath.slice(1) : modulePath;
  return cleaned === 'golang.org/toolchain';
}

// Strip the OS-arch suffix: "v0.0.1-go1.21.0.linux-amd64" -> "v0.0.1-go1.21.0"
function getToolchainBaseVersion(version: string): string {
  const match = version.match(/^(v[\d.]+-go[\d.]+(?:(?:rc|beta)\d+)?)\./);
  return match ? match[1] : version;
}

// Group versions by Go version base, returning one representative per group (prefer linux variants)
function deduplicateToolchainVersions(versions: string[]): {
  representatives: string[];
  groupMap: Map<string, string[]>;
} {
  const groupMap = new Map<string, string[]>();
  for (const v of versions) {
    const base = getToolchainBaseVersion(v);
    const group = groupMap.get(base);
    if (group) {
      group.push(v);
    } else {
      groupMap.set(base, [v]);
    }
  }
  const representatives: string[] = [];
  for (const group of groupMap.values()) {
    const linuxIdx = group.findIndex((v) => v.includes('.linux-'));
    if (linuxIdx > 0) {
      [group[0], group[linuxIdx]] = [group[linuxIdx], group[0]];
    }
    representatives.push(group[0]);
  }
  return { representatives, groupMap };
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
