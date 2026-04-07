import { describe, it, expect, vi, afterEach } from 'vitest';
import { loadConfig } from './config.ts';

describe('loadConfig', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns defaults when no args are provided', () => {
    const config = loadConfig([]);
    expect(config.port).toBe(3000);
    expect(config.upstream).toBe('https://registry.npmjs.org');
    expect(config.delayDays).toBe(7);
  });

  it('parses --port', () => {
    const config = loadConfig(['--port', '8080']);
    expect(config.port).toBe(8080);
  });

  it('parses -p shorthand', () => {
    const config = loadConfig(['-p', '9000']);
    expect(config.port).toBe(9000);
  });

  it('parses --upstream', () => {
    const config = loadConfig(['--upstream', 'https://my-registry.example.com']);
    expect(config.upstream).toBe('https://my-registry.example.com');
  });

  it('parses -u shorthand', () => {
    const config = loadConfig(['-u', 'https://my-registry.example.com']);
    expect(config.upstream).toBe('https://my-registry.example.com');
  });

  it('parses --delay-days', () => {
    const config = loadConfig(['--delay-days', '14']);
    expect(config.delayDays).toBe(14);
  });

  it('parses -d shorthand', () => {
    const config = loadConfig(['-d', '30']);
    expect(config.delayDays).toBe(30);
  });

  it('parses fractional delay days', () => {
    const config = loadConfig(['--delay-days', '0.5']);
    expect(config.delayDays).toBe(0.5);
  });

  it('parses multiple options together', () => {
    const config = loadConfig(['-p', '4000', '-u', 'https://example.com', '-d', '3']);
    expect(config.port).toBe(4000);
    expect(config.upstream).toBe('https://example.com');
    expect(config.delayDays).toBe(3);
  });

  it('prints help and calls process.exit(0) when --help is passed', () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('process.exit called');
    });

    expect(() => loadConfig(['--help'])).toThrow('process.exit called');
    expect(consoleSpy).toHaveBeenCalledOnce();
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it('prints help when -h shorthand is passed', () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('process.exit called');
    });

    expect(() => loadConfig(['-h'])).toThrow('process.exit called');
    expect(consoleSpy).toHaveBeenCalledOnce();
  });
});
