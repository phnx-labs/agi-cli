import { describe, expect, it } from 'vitest';
import * as path from 'node:path';
import { discoverChromiumProfilesAt, chromiumUserDataDir } from './chromium-discovery.js';

const testdata = path.join(import.meta.dirname, 'testdata', 'comet');

describe('discoverChromiumProfilesAt', () => {
  it('lists one agents-cli profile per Comet profile, pinned to its directory', () => {
    const dir = path.join(testdata, 'valid');
    const result = discoverChromiumProfilesAt('comet', dir);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.profiles).toEqual([
      { browser: 'comet', name: 'comet-work-default', userDataDir: dir, profileDirectory: 'Default', displayName: 'Work' },
      { browser: 'comet', name: 'comet-personal', userDataDir: dir, profileDirectory: 'Profile 1', displayName: 'Personal' },
      { browser: 'comet', name: 'comet-work-profile-2', userDataDir: dir, profileDirectory: 'Profile 2', displayName: 'Work' },
    ]);
  });

  it('fails closed on a profile without a name instead of inventing one', () => {
    expect(discoverChromiumProfilesAt('comet', path.join(testdata, 'malformed'))).toEqual({
      ok: false,
      kind: 'invalid',
      reason: 'comet Local State profile "Default" has no non-empty name',
    });
  });

  it('reports a missing store as not installed', () => {
    const result = discoverChromiumProfilesAt('comet', path.join(testdata, 'nowhere'));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe('not-installed');
  });

  it('honors the AGENTS_COMET_DIR override', () => {
    const previous = process.env.AGENTS_COMET_DIR;
    try {
      process.env.AGENTS_COMET_DIR = '/tmp/comet-override';
      expect(chromiumUserDataDir('comet')).toBe('/tmp/comet-override');
    } finally {
      if (previous === undefined) delete process.env.AGENTS_COMET_DIR;
      else process.env.AGENTS_COMET_DIR = previous;
    }
  });
});
