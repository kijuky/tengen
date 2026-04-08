import { describe, it, expect } from 'vitest';
import { MavenRegistryProxy, parseMavenPath, filterMavenMetadataXml } from './maven.ts';

const proxy = new MavenRegistryProxy({
  upstream: 'https://repo1.maven.org/maven2',
  delayMs: 7 * 24 * 60 * 60 * 1000,
});

const CUTOFF = new Date('2024-01-15T00:00:00Z');

function makeXml(versions: string[], release = '', latest = ''): string {
  const versionTags = versions.map((v) => `    <version>${v}</version>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<metadata>
  <groupId>com.example</groupId>
  <artifactId>mylib</artifactId>
  <versioning>
    <latest>${latest || versions[versions.length - 1] || ''}</latest>
    <release>${release || versions[versions.length - 1] || ''}</release>
    <versions>
${versionTags}
    </versions>
    <lastUpdated>20240201000000</lastUpdated>
  </versioning>
</metadata>`;
}

describe('MavenRegistryProxy.isMetadataPath', () => {
  it('returns true for maven-metadata.xml paths', () => {
    expect(proxy.isMetadataPath('/com/example/mylib/maven-metadata.xml')).toBe(true);
    expect(proxy.isMetadataPath('/org/springframework/spring-core/maven-metadata.xml')).toBe(true);
  });

  it('returns false for artifact paths', () => {
    expect(proxy.isMetadataPath('/com/example/mylib/1.0.0/mylib-1.0.0.jar')).toBe(false);
    expect(proxy.isMetadataPath('/com/example/mylib/1.0.0/mylib-1.0.0.pom')).toBe(false);
    expect(proxy.isMetadataPath('/com/example/mylib/1.0.0/mylib-1.0.0.jar.sha1')).toBe(false);
  });
});

describe('parseMavenPath', () => {
  it('parses groupId and artifactId from path', () => {
    expect(parseMavenPath('/com/example/mylib/maven-metadata.xml')).toEqual({
      groupId: 'com.example',
      artifactId: 'mylib',
    });
  });

  it('handles deeply nested groupIds', () => {
    expect(parseMavenPath('/org/springframework/boot/spring-boot/maven-metadata.xml')).toEqual({
      groupId: 'org.springframework.boot',
      artifactId: 'spring-boot',
    });
  });
});

describe('filterMavenMetadataXml', () => {
  it('removes versions not in the allowed set', () => {
    const xml = makeXml(['1.0.0', '1.1.0', '2.0.0']);
    const allowed = new Set(['1.0.0', '1.1.0']);

    const result = filterMavenMetadataXml(xml, allowed, '1.1.0');

    expect(result).toContain('<version>1.0.0</version>');
    expect(result).toContain('<version>1.1.0</version>');
    expect(result).not.toContain('<version>2.0.0</version>');
  });

  it('updates <release> and <latest> to latestVersion', () => {
    const xml = makeXml(['1.0.0', '1.1.0', '2.0.0'], '2.0.0', '2.0.0');
    const allowed = new Set(['1.0.0', '1.1.0']);

    const result = filterMavenMetadataXml(xml, allowed, '1.1.0')!;

    expect(result).toContain('<release>1.1.0</release>');
    expect(result).toContain('<latest>1.1.0</latest>');
  });

  it('returns null when all versions are filtered out', () => {
    const xml = makeXml(['2.0.0', '2.1.0']);
    const allowed = new Set<string>();

    expect(filterMavenMetadataXml(xml, allowed, '')).toBeNull();
  });

  it('keeps versions that are in the allowed set exactly', () => {
    const xml = makeXml(['1.0.0']);
    const allowed = new Set(['1.0.0']);

    const result = filterMavenMetadataXml(xml, allowed, '1.0.0');
    expect(result).not.toBeNull();
    expect(result).toContain('<version>1.0.0</version>');
  });

  it('does not mutate the input string', () => {
    const xml = makeXml(['1.0.0', '2.0.0']);
    const original = xml;
    const allowed = new Set(['1.0.0']);

    filterMavenMetadataXml(xml, allowed, '1.0.0');
    expect(xml).toBe(original);
  });
});
