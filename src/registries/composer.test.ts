import { describe, it, expect } from 'vitest';
import { ComposerRegistryProxy } from './composer.ts';

const proxy = new ComposerRegistryProxy({
  upstream: 'https://packagist.org',
  delayMs: 7 * 24 * 60 * 60 * 1000,
});

const CUTOFF = new Date('2024-01-15T00:00:00Z');

function makeV1Version(version: string, time: string): Record<string, unknown> {
  return { version, time, description: 'test' };
}

function makeV2Version(version: string, time: string): Record<string, unknown> {
  return { version, version_normalized: version + '.0', time };
}

describe('ComposerRegistryProxy.isMetadataPath', () => {
  it('returns true for v1 packages API paths', () => {
    expect(proxy.isMetadataPath('/packages/symfony/console.json')).toBe(true);
    expect(proxy.isMetadataPath('/packages/laravel/framework.json')).toBe(true);
  });

  it('returns true for v2 p2 API paths', () => {
    expect(proxy.isMetadataPath('/p2/symfony/console.json')).toBe(true);
    expect(proxy.isMetadataPath('/p2/symfony/console~dev.json')).toBe(true);
  });

  it('returns false for non-metadata paths', () => {
    expect(proxy.isMetadataPath('/packages.json')).toBe(false);
    expect(proxy.isMetadataPath('/p/providers-latest.json')).toBe(false);
  });
});

describe('ComposerRegistryProxy.filterMetadata (v1)', () => {
  it('returns data unchanged when structure is unrecognized', () => {
    const data = { foo: 'bar' };
    expect(proxy.filterMetadata(data, CUTOFF)).toBe(data);
  });

  it('filters out versions published after cutoff date', () => {
    const data = {
      package: {
        name: 'symfony/console',
        versions: {
          '6.0.0': makeV1Version('6.0.0', '2024-01-01T00:00:00Z'), // before -> allowed
          '6.1.0': makeV1Version('6.1.0', '2024-02-01T00:00:00Z'), // after  -> filtered
        },
      },
    };

    const result = proxy.filterMetadata(data, CUTOFF) as typeof data;
    expect(Object.keys(result.package.versions)).toEqual(['6.0.0']);
  });

  it('includes versions published exactly at the cutoff date', () => {
    const data = {
      package: {
        name: 'symfony/console',
        versions: {
          '6.0.0': makeV1Version('6.0.0', '2024-01-15T00:00:00Z'), // exactly at cutoff
        },
      },
    };

    const result = proxy.filterMetadata(data, CUTOFF) as typeof data;
    expect(Object.keys(result.package.versions)).toEqual(['6.0.0']);
  });

  it('includes versions without a time field', () => {
    const data = {
      package: {
        name: 'symfony/console',
        versions: {
          'dev-main': { version: 'dev-main', description: 'dev' }, // no time
        },
      },
    };

    const result = proxy.filterMetadata(data, CUTOFF) as typeof data;
    expect(Object.keys(result.package.versions)).toEqual(['dev-main']);
  });

  it('returns null when all versions are filtered out', () => {
    const data = {
      package: {
        name: 'symfony/console',
        versions: {
          '6.1.0': makeV1Version('6.1.0', '2024-02-01T00:00:00Z'), // after cutoff
        },
      },
    };

    expect(proxy.filterMetadata(data, CUTOFF)).toBeNull();
  });

  it('does not mutate the original data', () => {
    const data = {
      package: {
        name: 'symfony/console',
        versions: {
          '6.0.0': makeV1Version('6.0.0', '2024-01-01T00:00:00Z'),
          '6.1.0': makeV1Version('6.1.0', '2024-02-01T00:00:00Z'),
        },
      },
    };

    const original = JSON.parse(JSON.stringify(data));
    proxy.filterMetadata(data, CUTOFF);
    expect(data).toEqual(original);
  });
});

describe('ComposerRegistryProxy.filterMetadata (v2)', () => {
  it('filters out versions published after cutoff date', () => {
    const data = {
      packages: {
        'symfony/console': [
          makeV2Version('6.0.0', '2024-01-01T00:00:00Z'), // before -> allowed
          makeV2Version('6.1.0', '2024-02-01T00:00:00Z'), // after  -> filtered
        ],
      },
      minified: 'composer/2.0',
    };

    const result = proxy.filterMetadata(data, CUTOFF) as typeof data;
    expect(result.packages['symfony/console']).toHaveLength(1);
    expect(result.packages['symfony/console'][0].version).toBe('6.0.0');
  });

  it('includes versions published exactly at the cutoff date', () => {
    const data = {
      packages: {
        'symfony/console': [
          makeV2Version('6.0.0', '2024-01-15T00:00:00Z'),
        ],
      },
    };

    const result = proxy.filterMetadata(data, CUTOFF) as typeof data;
    expect(result.packages['symfony/console']).toHaveLength(1);
  });

  it('preserves top-level fields like minified', () => {
    const data = {
      packages: {
        'symfony/console': [makeV2Version('6.0.0', '2024-01-01T00:00:00Z')],
      },
      minified: 'composer/2.0',
    };

    const result = proxy.filterMetadata(data, CUTOFF) as typeof data;
    expect((result as Record<string, unknown>).minified).toBe('composer/2.0');
  });

  it('returns null when all versions are filtered out', () => {
    const data = {
      packages: {
        'symfony/console': [
          makeV2Version('6.1.0', '2024-02-01T00:00:00Z'), // after cutoff
        ],
      },
    };

    expect(proxy.filterMetadata(data, CUTOFF)).toBeNull();
  });

  it('does not mutate the original data', () => {
    const data = {
      packages: {
        'symfony/console': [
          makeV2Version('6.0.0', '2024-01-01T00:00:00Z'),
          makeV2Version('6.1.0', '2024-02-01T00:00:00Z'),
        ],
      },
    };

    const original = JSON.parse(JSON.stringify(data));
    proxy.filterMetadata(data, CUTOFF);
    expect(data).toEqual(original);
  });
});
