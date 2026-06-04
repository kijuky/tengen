import type { Request } from 'express';
import axios from 'axios';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { MavenRegistryProxy } from './maven.ts';

/** Upper bound on validated 303 hops when resolving metadata. */
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
   * instead of being handed to the client as an unfiltered redirect. Each hop is
   * SSRF-validated (https + public host) and redirects are not auto-followed, so
   * a poisoned Location cannot pivot to internal infra; an unsafe target falls
   * back to forwarding the 303 to the client.
   */
  protected override async fetchUpstreamXml(req: Request) {
    let res = await super.fetchUpstreamXml(req);
    const base = this.config.upstream.replace(/\/$/, '');
    for (let hops = 0; hops < MAX_METADATA_REDIRECTS; hops++) {
      const location = res.headers['location'];
      if (res.status !== 303 || typeof location !== 'string') break;
      const target = await resolveSafeRedirectTarget(location, base);
      if (!target) break;
      res = await axios.get<string>(target, {
        responseType: 'text',
        validateStatus: () => true,
        maxRedirects: 0,
      });
    }
    return res;
  }
}

/**
 * Resolve a redirect Location into a fetchable URL only if it is safe to
 * request server-side. Returns null (caller must not follow) when the target is
 * not https, unresolvable, or resolves to a non-public address — guarding
 * against SSRF via a poisoned upstream Location header.
 */
async function resolveSafeRedirectTarget(
  location: string,
  base: string,
): Promise<string | null> {
  let url: URL;
  try {
    url = new URL(location, base);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:') return null;
  const host = url.hostname.replace(/^\[|\]$/g, '');
  try {
    const addresses = isIP(host)
      ? [host]
      : (await lookup(host, { all: true })).map((a) => a.address);
    if (addresses.length === 0 || addresses.some(isBlockedAddress)) return null;
  } catch {
    return null;
  }
  return url.toString();
}

/** True for loopback / private / link-local / reserved IPs that must not be fetched. */
function isBlockedAddress(ip: string): boolean {
  const family = isIP(ip);
  if (family === 4) return isBlockedIpv4(ip);
  if (family === 6) return isBlockedIpv6(ip);
  return true;
}

function isBlockedIpv4(ip: string): boolean {
  const o = ip.split('.').map(Number);
  if (o.length !== 4 || o.some((n) => Number.isNaN(n) || n < 0 || n > 255)) {
    return true;
  }
  const [a, b] = o;
  if (a === 0) return true; // 0.0.0.0/8 "this host"
  if (a === 10) return true; // 10.0.0.0/8 private
  if (a === 127) return true; // 127.0.0.0/8 loopback
  if (a === 169 && b === 254) return true; // 169.254.0.0/16 link-local (cloud metadata)
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12 private
  if (a === 192 && b === 168) return true; // 192.168.0.0/16 private
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 CGNAT
  if (a >= 224) return true; // 224.0.0.0/4 multicast + 240.0.0.0/4 reserved
  return false;
}

function isBlockedIpv6(ip: string): boolean {
  const addr = ip.toLowerCase().split('%')[0]; // drop zone id
  const v4mapped = addr.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (v4mapped) return isBlockedIpv4(v4mapped[1]);
  if (addr === '::' || addr === '::1') return true; // unspecified / loopback
  if (/^fe[89ab]/.test(addr)) return true; // fe80::/10 link-local
  if (/^f[cd]/.test(addr)) return true; // fc00::/7 unique local
  return false;
}
