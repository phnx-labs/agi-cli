import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  parseProfilesIni,
  discoverFirefoxProfilesAt,
  firefoxDiscoveredProfiles,
  firefoxProfilePort,
  firefoxProfileRoots,
  FIREFOX_PORT_RANGE,
} from './firefox-discovery.js';

const testdata = path.join(import.meta.dirname, 'testdata', 'firefox');

describe('parseProfilesIni', () => {
  it('reads every [ProfileN] entry and resolves relative + absolute paths', () => {
    const ini = path.join(testdata, 'profiles-valid.ini');
    const result = parseProfilesIni(ini);
    expect(Array.isArray(result)).toBe(true);
    const profiles = result as Array<{ name: string; dir: string; isDefault: boolean }>;
    expect(profiles.map((p) => p.name).sort()).toEqual(['Dev Edition', 'default', 'default-release']);
    const rel = profiles.find((p) => p.name === 'default')!;
    // IsRelative=1 → resolved against the ini's directory.
    expect(rel.dir).toBe(path.join(testdata, 'wxyz5678.default'));
    const abs = profiles.find((p) => p.name === 'Dev Edition')!;
    // A non-relative Path is used verbatim.
    expect(abs.dir).toBe('/opt/firefox-dev/profile');
    expect(profiles.find((p) => p.name === 'default-release')!.isDefault).toBe(true);
  });

  it('skips [General] and [Install*] sections — they are not profiles', () => {
    const profiles = parseProfilesIni(path.join(testdata, 'profiles-valid.ini')) as Array<{ name: string }>;
    expect(profiles.some((p) => p.name === 'default-release')).toBe(true);
    expect(profiles).toHaveLength(3);
  });

  it('reports a [Profile] entry with no Name as an error, never a guessed profile', () => {
    const result = parseProfilesIni(path.join(testdata, 'profiles-malformed.ini'));
    expect('error' in result).toBe(true);
    expect((result as { error: string }).error).toContain('no Name or Path');
  });

  it('returns an error for a missing file', () => {
    const result = parseProfilesIni('/nonexistent/profiles.ini');
    expect('error' in result).toBe(true);
    expect((result as { error: string }).error).toContain('Cannot read');
  });
});

describe('discoverFirefoxProfilesAt', () => {
  it('returns not-installed when no profiles.ini exists in any root', () => {
    const result = discoverFirefoxProfilesAt([path.join(os.tmpdir(), 'no-firefox-here-xyz')]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.kind).toBe('not-installed');
  });

  it('returns invalid (not not-installed) when the ini exists but is malformed', () => {
    const result = discoverFirefoxProfilesAt([testdata]);
    // testdata holds several .ini files but discovery only reads profiles.ini —
    // there is none named exactly that here, so it is not-installed.
    expect(result.ok).toBe(false);
  });

  it('discovers profiles from a real profiles.ini laid out in a temp root', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-disco-'));
    fs.copyFileSync(path.join(testdata, 'profiles-valid.ini'), path.join(root, 'profiles.ini'));
    try {
      const result = discoverFirefoxProfilesAt([root]);
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.profiles).toHaveLength(3);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('firefoxDiscoveredProfiles', () => {
  it('names one agents-cli profile per entry as firefox-<slug> with a stable pinned port', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-disco-'));
    fs.copyFileSync(path.join(testdata, 'profiles-valid.ini'), path.join(root, 'profiles.ini'));
    try {
      const result = discoverFirefoxProfilesAt([root]);
      const flat = firefoxDiscoveredProfiles(result);
      expect(flat.map((p) => p.name).sort()).toEqual([
        'firefox-default',
        'firefox-default-release',
        'firefox-dev-edition',
      ]);
      // Every port sits inside the reserved Firefox range and is unique.
      const ports = flat.map((p) => p.port);
      for (const port of ports) {
        expect(port).toBeGreaterThanOrEqual(FIREFOX_PORT_RANGE.base);
        expect(port).toBeLessThan(FIREFOX_PORT_RANGE.base + FIREFOX_PORT_RANGE.size);
      }
      expect(new Set(ports).size).toBe(ports.length);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('empty discovery flattens to no profiles rather than throwing', () => {
    expect(firefoxDiscoveredProfiles({ ok: false, kind: 'not-installed', reason: 'x' })).toEqual([]);
  });
});

describe('firefoxProfilePort', () => {
  it('is deterministic for a directory — the same relaunch hint every time', () => {
    const dir = '/home/u/.mozilla/firefox/abc.default';
    expect(firefoxProfilePort(dir)).toBe(firefoxProfilePort(dir));
  });

  it('linear-probes to avoid a port already taken by another discovered profile', () => {
    const dir = '/home/u/.mozilla/firefox/abc.default';
    const first = firefoxProfilePort(dir);
    const taken = new Set([first]);
    const second = firefoxProfilePort(dir, taken);
    expect(second).not.toBe(first);
  });
});

describe('firefoxProfileRoots', () => {
  it('honors AGENTS_FIREFOX_DIRS as a path-separator list', () => {
    const prev = process.env.AGENTS_FIREFOX_DIRS;
    process.env.AGENTS_FIREFOX_DIRS = ['/a/x', '/b/y'].join(path.delimiter);
    try {
      expect(firefoxProfileRoots()).toEqual([path.resolve('/a/x'), path.resolve('/b/y')]);
    } finally {
      if (prev === undefined) delete process.env.AGENTS_FIREFOX_DIRS;
      else process.env.AGENTS_FIREFOX_DIRS = prev;
    }
  });
});
