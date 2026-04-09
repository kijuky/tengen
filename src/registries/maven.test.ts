import { describe, it, expect } from 'vitest';
import { parseMavenPath, filterMavenMetadataXml } from './maven.ts';

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
