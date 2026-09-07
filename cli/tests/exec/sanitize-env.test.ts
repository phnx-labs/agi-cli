import { describe, it, expect } from 'vitest';
import { sanitizeProcessEnv } from '../../src/lib/secrets-client.js';

describe('sanitizeProcessEnv', () => {
  it('strips loader and interpreter env vars from a process.env-shaped input', () => {
    const input: NodeJS.ProcessEnv = {
      PATH: '/usr/bin',
      HOME: '/home/u',
      DYLD_INSERT_LIBRARIES: '/tmp/evil.dylib',
      DYLD_LIBRARY_PATH: '/tmp',
      LD_PRELOAD: '/tmp/evil.so',
      NODE_OPTIONS: '--require /tmp/evil.js',
      PYTHONPATH: '/tmp',
      BASH_ENV: '/tmp/x',
      MY_TOKEN: 'keep-me',
    };

    const out = sanitizeProcessEnv(input);

    expect(out.DYLD_INSERT_LIBRARIES).toBeUndefined();
    expect(out.DYLD_LIBRARY_PATH).toBeUndefined();
    expect(out.LD_PRELOAD).toBeUndefined();
    expect(out.NODE_OPTIONS).toBeUndefined();
    expect(out.PYTHONPATH).toBeUndefined();
    expect(out.BASH_ENV).toBeUndefined();
    expect(out.PATH).toBe('/usr/bin');
    expect(out.HOME).toBe('/home/u');
    expect(out.MY_TOKEN).toBe('keep-me');
  });

  it('strips loader vars set on real process.env', () => {
    const prevDyld = process.env.DYLD_INSERT_LIBRARIES;
    const prevNode = process.env.NODE_OPTIONS;
    process.env.DYLD_INSERT_LIBRARIES = '/tmp/evil.dylib';
    process.env.NODE_OPTIONS = '--require /tmp/evil.js';
    try {
      const out = sanitizeProcessEnv();
      expect(out.DYLD_INSERT_LIBRARIES).toBeUndefined();
      expect(out.NODE_OPTIONS).toBeUndefined();
    } finally {
      if (prevDyld === undefined) delete process.env.DYLD_INSERT_LIBRARIES;
      else process.env.DYLD_INSERT_LIBRARIES = prevDyld;
      if (prevNode === undefined) delete process.env.NODE_OPTIONS;
      else process.env.NODE_OPTIONS = prevNode;
    }
  });
});
