import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  snapshotAuth,
  FLEET_AUTH_FILES,
  isPropagatableAgent,
  hasPortableAuthFiles,
  isCredentialSafeToPropagate,
  SINGLE_USE_ROTATING_REFRESH_AGENTS,
} from './auth-sync.js';

function seedFile(home: string, rel: string, content: string, mode = 0o600): void {
  const abs = path.join(home, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
  fs.chmodSync(abs, mode);
}

// RUSH-2527 / SING-1b: a native OAuth/session login must not be copied between devices, so
// `snapshotAuth` captures nothing for every agent on every platform. The old receive/materialize
// primitive is deleted, leaving no hidden write path.
describe('snapshotAuth — native OAuth logins are never captured (SING-1b)', () => {
  it('captures nothing even for a signed-in portable runtime (codex) on Linux', () => {
    const src = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-src-'));
    seedFile(src, '.codex/auth.json', '{"tokens":"codex-abc"}');
    const snap = snapshotAuth(['codex', 'gemini'], { home: src, platform: 'linux' });
    expect(snap.files).toEqual([]);
    expect(snap.bound).toEqual([]);
  });

  it('captures nothing for claude on Linux (was portable there) nor codex', () => {
    const src = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-src-'));
    seedFile(src, '.claude/.credentials.json', '{"claudeAiOauth":"linux-token"}');
    seedFile(src, '.codex/auth.json', '{"tokens":"x"}');
    const snap = snapshotAuth(['claude', 'codex'], { home: src, platform: 'linux' });
    expect(snap.files).toEqual([]);
    expect(snap.bound).toEqual([]);
  });

  it('captures nothing on macOS either — claude/antigravity are never read', () => {
    const src = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-src-'));
    seedFile(src, '.claude/.credentials.json', '{"claudeAiOauth":"x"}');
    const snap = snapshotAuth(['claude', 'antigravity', 'codex'], { home: src, platform: 'darwin' });
    expect(snap.files).toEqual([]);
    expect(snap.bound).toEqual([]);
  });

  it('captures nothing for a single-use rotating refresh token (droid) — same as every other login now', () => {
    const src = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-src-'));
    seedFile(src, '.factory/auth.v2.file', 'droid-file');
    seedFile(src, '.factory/auth.v2.key', 'droid-key');
    const snap = snapshotAuth(['droid'], { home: src, platform: 'linux' });
    expect(snap.files).toEqual([]);
    expect(snap.bound).toEqual([]);
  });
});

describe('FLEET_AUTH_FILES coverage', () => {
  it('maps the portable-auth agents but NONE are propagatable anymore (SING-1b)', () => {
    for (const agent of ['claude', 'codex', 'grok', 'kimi', 'opencode', 'antigravity']) {
      expect(FLEET_AUTH_FILES[agent]?.length).toBeGreaterThan(0);
      // Portable file on disk, but a native OAuth login is never copied between devices.
      expect(isCredentialSafeToPropagate(agent)).toBe(false);
      expect(isPropagatableAgent(agent)).toBe(false);
    }
  });

  it('droid stays documented as single-use rotating, and is unsafe to propagate like every other login', () => {
    expect(FLEET_AUTH_FILES['droid']?.length).toBeGreaterThan(0);
    expect(hasPortableAuthFiles('droid')).toBe(true);
    expect(SINGLE_USE_ROTATING_REFRESH_AGENTS.has('droid')).toBe(true);
    expect(isCredentialSafeToPropagate('droid')).toBe(false);
    expect(isPropagatableAgent('droid')).toBe(false);
  });
});

// PHNX-3940 T6: reserved-store sync must never reach a native OAuth/session file; only setup-tokens
// and API keys ride the fleet. A fixture home holding every FLEET_AUTH_FILES entry must yield an
// empty transfer plan on both platforms; this fails if one becomes propagatable.
describe('the transfer plan never selects any native login file (PHNX-3940 T6)', () => {
  function seedEveryAuthFile(home: string): void {
    for (const [agent, specs] of Object.entries(FLEET_AUTH_FILES)) {
      for (const spec of specs) seedFile(home, spec.rel, `{"native":"${agent}"}`);
    }
  }

  for (const platform of ['linux', 'darwin'] as const) {
    it(`captures nothing on ${platform} even with every native login present`, () => {
      const home = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-all-auth-'));
      try {
        seedEveryAuthFile(home);
        const snap = snapshotAuth(Object.keys(FLEET_AUTH_FILES), { home, platform });
        expect(snap.files).toEqual([]);
        for (const agent of Object.keys(FLEET_AUTH_FILES)) {
          expect(isCredentialSafeToPropagate(agent)).toBe(false);
        }
      } finally {
        fs.rmSync(home, { recursive: true, force: true });
      }
    });
  }
});
