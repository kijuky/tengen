import { describe, it, expect } from 'vitest';
import { PypiRegistryProxy } from './pypi.ts';

const proxy = new PypiRegistryProxy({
  upstream: 'https://pypi.org',
  delayMs: 7 * 24 * 60 * 60 * 1000,
});

const CUTOFF = new Date('2024-01-15T00:00:00Z');

function makeFile(uploadTime: string): Record<string, unknown> {
  return { upload_time_iso_8601: uploadTime, filename: 'pkg.tar.gz' };
}

describe('PypiRegistryProxy.filterMetadata', () => {
  it('returns data unchanged when releases and urls are missing', () => {
    const data = { info: { name: 'pkg', version: '1.0.0' } };
    expect(proxy.filterMetadata(data, CUTOFF)).toBe(data);
  });

  describe('version-specific endpoint (no releases field)', () => {
    it('returns null when urls are after cutoff', () => {
      const data = {
        info: { name: 'pkg', version: '1.1.0' },
        urls: [makeFile('2024-02-01T00:00:00Z')],  // after cutoff
      };
      expect(proxy.filterMetadata(data, CUTOFF)).toBeNull();
    });

    it('returns data unchanged when urls are before cutoff', () => {
      const data = {
        info: { name: 'pkg', version: '1.0.0' },
        urls: [makeFile('2024-01-01T00:00:00Z')],  // before cutoff
      };
      expect(proxy.filterMetadata(data, CUTOFF)).toBe(data);
    });

    it('uses the earliest url upload time when multiple files', () => {
      const data = {
        info: { name: 'pkg', version: '1.0.0' },
        urls: [
          makeFile('2024-01-10T00:00:00Z'),  // before cutoff
          makeFile('2024-01-20T00:00:00Z'),  // after cutoff
        ],
      };
      // earliest is before cutoff -> allowed
      expect(proxy.filterMetadata(data, CUTOFF)).toBe(data);
    });
  });

  it('filters out versions published after cutoff date', () => {
    const data = {
      info: { name: 'pkg', version: '1.1.0' },
      last_serial: 1,
      releases: {
        '1.0.0': [makeFile('2024-01-01T00:00:00Z')],  // before cutoff -> allowed
        '1.1.0': [makeFile('2024-02-01T00:00:00Z')],  // after cutoff -> filtered
      },
      urls: [makeFile('2024-02-01T00:00:00Z')],
    };

    const result = proxy.filterMetadata(data, CUTOFF) as typeof data;

    expect(Object.keys(result.releases)).toEqual(['1.0.0']);
  });

  it('includes versions published exactly at the cutoff date', () => {
    const data = {
      info: { name: 'pkg', version: '1.0.0' },
      last_serial: 1,
      releases: {
        '1.0.0': [makeFile('2024-01-15T00:00:00Z')],  // exactly at cutoff -> allowed
      },
      urls: [],
    };

    const result = proxy.filterMetadata(data, CUTOFF) as typeof data;
    expect(Object.keys(result.releases)).toEqual(['1.0.0']);
  });

  it('updates info.version to the latest allowed version', () => {
    const data = {
      info: { name: 'pkg', version: '1.2.0' },
      last_serial: 1,
      releases: {
        '1.0.0': [makeFile('2024-01-01T00:00:00Z')],  // allowed
        '1.1.0': [makeFile('2024-01-10T00:00:00Z')],  // allowed, newer
        '1.2.0': [makeFile('2024-02-01T00:00:00Z')],  // filtered
      },
      urls: [makeFile('2024-02-01T00:00:00Z')],
    };

    const result = proxy.filterMetadata(data, CUTOFF) as typeof data;
    expect(result.info.version).toBe('1.1.0');
  });

  it('updates urls to files of the latest allowed version', () => {
    const file100 = makeFile('2024-01-01T00:00:00Z');
    const file110 = makeFile('2024-01-10T00:00:00Z');
    const data = {
      info: { name: 'pkg', version: '1.2.0' },
      last_serial: 1,
      releases: {
        '1.0.0': [file100],
        '1.1.0': [file110],
        '1.2.0': [makeFile('2024-02-01T00:00:00Z')],
      },
      urls: [makeFile('2024-02-01T00:00:00Z')],
    };

    const result = proxy.filterMetadata(data, CUTOFF) as typeof data;
    expect(result.urls).toEqual([file110]);
  });

  it('returns null when all versions are filtered out', () => {
    const data = {
      info: { name: 'pkg', version: '1.0.0' },
      last_serial: 1,
      releases: {
        '1.0.0': [makeFile('2024-02-01T00:00:00Z')],  // after cutoff -> filtered
      },
      urls: [],
    };

    expect(proxy.filterMetadata(data, CUTOFF)).toBeNull();
  });

  it('skips empty file arrays in releases', () => {
    const data = {
      info: { name: 'pkg', version: '1.1.0' },
      last_serial: 1,
      releases: {
        '1.0.0': [],  // empty -> skipped
        '1.1.0': [makeFile('2024-02-01T00:00:00Z')],  // filtered
      },
      urls: [],
    };

    expect(proxy.filterMetadata(data, CUTOFF)).toBeNull();
  });

  it('uses the earliest file upload time when a release has multiple files', () => {
    const data = {
      info: { name: 'pkg', version: '1.0.0' },
      last_serial: 1,
      releases: {
        // earliest file is before cutoff, so the version should be allowed
        '1.0.0': [
          makeFile('2024-01-10T00:00:00Z'),  // earlier, before cutoff
          makeFile('2024-01-20T00:00:00Z'),  // later, after cutoff
        ],
      },
      urls: [],
    };

    const result = proxy.filterMetadata(data, CUTOFF) as typeof data;
    expect(Object.keys(result.releases)).toEqual(['1.0.0']);
  });

  it('does not mutate the original data', () => {
    const data = {
      info: { name: 'pkg', version: '1.1.0' },
      last_serial: 1,
      releases: {
        '1.0.0': [makeFile('2024-01-01T00:00:00Z')],
        '1.1.0': [makeFile('2024-02-01T00:00:00Z')],
      },
      urls: [makeFile('2024-02-01T00:00:00Z')],
    };

    const original = JSON.parse(JSON.stringify(data));
    proxy.filterMetadata(data, CUTOFF);
    expect(data).toEqual(original);
  });
});
