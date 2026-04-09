import { describe, it, expect } from 'vitest';
import { RubygemsRegistryProxy } from './rubygems.ts';

const proxy = new RubygemsRegistryProxy({
  upstream: 'https://rubygems.org',
  delayMs: 7 * 24 * 60 * 60 * 1000,
});

const CUTOFF = new Date('2024-01-15T00:00:00Z');

function makeVersion(number: string, createdAt: string): Record<string, unknown> {
  return { number, created_at: createdAt, authors: 'test' };
}

describe('RubygemsRegistryProxy.filterMetadata', () => {
  it('returns data unchanged when it is not an array', () => {
    const data = { name: 'rails' };
    expect(proxy.filterMetadata(data, CUTOFF)).toBe(data);
  });

  it('filters out versions published after cutoff date', () => {
    const data = [
      makeVersion('7.0.0', '2024-01-01T00:00:00Z'),  // before cutoff -> allowed
      makeVersion('7.1.0', '2024-02-01T00:00:00Z'),  // after cutoff -> filtered
    ];

    const result = proxy.filterMetadata(data, CUTOFF) as typeof data;

    expect(result).toHaveLength(1);
    expect(result[0].number).toBe('7.0.0');
  });

  it('includes versions published exactly at the cutoff date', () => {
    const data = [
      makeVersion('7.0.0', '2024-01-15T00:00:00Z'),  // exactly at cutoff -> allowed
    ];

    const result = proxy.filterMetadata(data, CUTOFF) as typeof data;
    expect(result).toHaveLength(1);
  });

  it('returns null when all versions are filtered out', () => {
    const data = [
      makeVersion('7.1.0', '2024-02-01T00:00:00Z'),  // after cutoff -> filtered
    ];

    expect(proxy.filterMetadata(data, CUTOFF)).toBeNull();
  });

  it('preserves all fields of allowed versions', () => {
    const version = {
      number: '7.0.0',
      created_at: '2024-01-01T00:00:00Z',
      authors: 'DHH',
      description: 'Rails!',
      prerelease: false,
    };
    const data = [version];

    const result = proxy.filterMetadata(data, CUTOFF) as typeof data;
    expect(result[0]).toEqual(version);
  });

  it('does not mutate the original data', () => {
    const data = [
      makeVersion('7.0.0', '2024-01-01T00:00:00Z'),
      makeVersion('7.1.0', '2024-02-01T00:00:00Z'),
    ];

    const original = JSON.parse(JSON.stringify(data));
    proxy.filterMetadata(data, CUTOFF);
    expect(data).toEqual(original);
  });
});
