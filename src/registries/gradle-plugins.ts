import type { Request } from 'express';
import axios from 'axios';
import { MavenRegistryProxy } from './maven.ts';

/** Upper bound on 303 hops when resolving metadata. */
const MAX_METADATA_REDIRECTS = 3;

/**
 * Proxy for the Gradle Plugin Portal (https://plugins.gradle.org/m2).
 *
 * The portal serves artifacts in standard Maven m2 layout — plugin marker
 * artifacts (`{pluginId}.gradle.plugin`) and the real implementation modules
 * alike — so routing, metadata filtering, and download gating are inherited
 * verbatim from MavenRegistryProxy. deps.dev indexes the marker artifacts under
 * the Maven ecosystem, so the age filter resolves publish dates the same way.
 *
 * Three things differ from plain Maven:
 *   - `name` mounts this proxy under a distinct URL prefix (/gradle-plugins)
 *   - `dbKey` points the malicious/allowlist lookups at the shared "maven"
 *     ecosystem, since OSV tracks Gradle plugin artifacts there.
 *   - `fetchUpstreamXml` follows the portal's 303 redirects for backing
 *     implementation modules so their metadata still gets filtered (see below).
 */
export class GradlePluginsRegistryProxy extends MavenRegistryProxy {
  readonly name = 'gradle-plugins';

  protected override get dbKey(): string {
    return 'maven';
  }

  /**
   * The Gradle Plugin Portal answers maven-metadata.xml for backing
   * implementation modules with a 303 to the hosting repo. Follow it server-side
   * so the resolved metadata still flows through the age/malicious filter
   * instead of being handed to the client as an unfiltered redirect.
   */
  protected override async fetchUpstreamXml(req: Request) {
    let res = await super.fetchUpstreamXml(req);
    const base = this.config.upstream.replace(/\/$/, '');
    for (let hops = 0; hops < MAX_METADATA_REDIRECTS; hops++) {
      const location = res.headers['location'];
      if (res.status !== 303 || typeof location !== 'string') break;
      let target: string;
      try {
        target = new URL(location, base).toString();
      } catch {
        break;
      }
      res = await axios.get<string>(target, {
        responseType: 'text',
        validateStatus: () => true,
        maxRedirects: 0,
      });
    }
    return res;
  }
}
