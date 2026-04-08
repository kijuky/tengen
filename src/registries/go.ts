import type { Request, Response } from 'express';
import axios from 'axios';
import { RegistryProxy } from './base.ts';

interface GoVersionInfo {
  Version: string;
  Time: string;
}

export class GoRegistryProxy extends RegistryProxy {
  readonly name = 'go';

  /**
   * Metadata paths:
   *   /{module}/@v/{version}.info  — version timestamp metadata
   *
   * /@v/list and /@latest are handled separately in handleRequest.
   * Binary artifacts (/@v/{version}.mod, /@v/{version}.zip) are passed through.
   */
  isMetadataPath(path: string): boolean {
    return path.endsWith('.info');
  }

  filterMetadata(data: unknown, cutoffDate: Date): unknown | null {
    const info = data as GoVersionInfo;
    if (!info.Time) return data;
    return new Date(info.Time) <= cutoffDate ? info : null;
  }

  override async handleRequest(req: Request, res: Response): Promise<void> {
    if (req.path.endsWith('/@v/list')) {
      try {
        await this.handleList(req.path, res);
      } catch (err) {
        if (!res.headersSent) {
          res.status(502).json({ error: 'Bad Gateway', message: String(err) });
        }
      }
      return;
    }
    if (req.path.endsWith('/@latest')) {
      try {
        await this.handleLatest(req.path, res);
      } catch (err) {
        if (!res.headersSent) {
          res.status(502).json({ error: 'Bad Gateway', message: String(err) });
        }
      }
      return;
    }
    await super.handleRequest(req, res);
  }

  private upstreamOrigin(): string {
    return new URL(this.config.upstream).origin;
  }

  private async fetchInfo(
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

  private async handleList(path: string, res: Response): Promise<void> {
    const cutoffDate = new Date(Date.now() - this.config.delayMs);
    const origin = this.upstreamOrigin();

    const listRes = await axios.get<string>(`${origin}${path}`, {
      responseType: 'text',
      validateStatus: () => true,
      maxRedirects: 0,
    });

    if (listRes.status !== 200) {
      res.status(listRes.status).send(listRes.data);
      return;
    }

    const versions = listRes.data.split('\n').filter((v) => v.trim());
    const modulePath = path.slice(0, path.length - '/@v/list'.length);

    const results = await Promise.all(
      versions.map(async (version) => {
        const info = await this.fetchInfo(origin, modulePath, version);
        if (info && new Date(info.Time) <= cutoffDate) return version;
        return null;
      }),
    );

    const allowed = results.filter((v): v is string => v !== null);
    if (allowed.length === 0) {
      res.status(404).send('not found');
      return;
    }

    res.status(200).type('text/plain').send(allowed.join('\n') + '\n');
  }

  private async handleLatest(path: string, res: Response): Promise<void> {
    const cutoffDate = new Date(Date.now() - this.config.delayMs);
    const origin = this.upstreamOrigin();

    const latestRes = await axios.get<GoVersionInfo>(`${origin}${path}`, {
      validateStatus: () => true,
      maxRedirects: 0,
    });

    if (latestRes.status !== 200) {
      res.status(latestRes.status).json(latestRes.data);
      return;
    }

    const latestInfo = latestRes.data;
    if (new Date(latestInfo.Time) <= cutoffDate) {
      res.status(200).json(latestInfo);
      return;
    }

    // Latest upstream version is too new — find the most recent allowed version
    const modulePath = path.slice(0, path.length - '/@latest'.length);
    const listRes = await axios.get<string>(
      `${origin}${modulePath}/@v/list`,
      { responseType: 'text', validateStatus: () => true, maxRedirects: 0 },
    );

    if (listRes.status !== 200) {
      res.status(404).json({ error: 'Not found' });
      return;
    }

    const versions = listRes.data.split('\n').filter((v) => v.trim());
    const infos = await Promise.all(
      versions.map(async (version) => {
        const info = await this.fetchInfo(origin, modulePath, version);
        if (info) return { info, time: new Date(info.Time) };
        return null;
      }),
    );

    const allowed = infos
      .filter(
        (v): v is { info: GoVersionInfo; time: Date } =>
          v !== null && v.time <= cutoffDate,
      )
      .sort((a, b) => b.time.getTime() - a.time.getTime());

    if (allowed.length === 0) {
      res.status(404).json({ error: 'Not found' });
      return;
    }

    res.status(200).json(allowed[0].info);
  }
}
