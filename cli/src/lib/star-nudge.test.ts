import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';

// star-nudge.ts imports state.ts, which resolves HOME at import time, so pin HOME to a temp dir
// before the module loads (top-level scope, then one dynamic import). No vi.resetModules, so it
// works under vitest and `bun test`.
const savedHome = process.env.HOME;
const savedCI = process.env.CI;
const savedOptOut = process.env.AGENTS_NO_NUDGE;
const savedStateDir = process.env.AGENTS_STATE_DIR;
const savedTTY = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');

const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-nudge-test-'));
process.env.HOME = TMP_HOME;
// The sentinel lives under getRuntimeStateDir(), which honors AGENTS_STATE_DIR ahead of HOME, and
// tests/setup.ts pins that fork-wide. Point it back at this file's HOME so the sentinel lands
// where the cases assert and `raceHome` still isolates.
process.env.AGENTS_STATE_DIR = path.join(TMP_HOME, '.agents', '.cache', 'state');
delete process.env.CI;
delete process.env.AGENTS_NO_NUDGE;

type Mod = typeof import('./star-nudge.js');
let mod: Mod;

beforeAll(async () => {
  mod = await import('./star-nudge.js');
});

afterAll(() => {
  if (savedHome === undefined) delete process.env.HOME; else process.env.HOME = savedHome;
  if (savedStateDir === undefined) delete process.env.AGENTS_STATE_DIR;
  else process.env.AGENTS_STATE_DIR = savedStateDir;
  if (savedCI === undefined) delete process.env.CI; else process.env.CI = savedCI;
  if (savedOptOut === undefined) delete process.env.AGENTS_NO_NUDGE; else process.env.AGENTS_NO_NUDGE = savedOptOut;
  if (savedTTY) Object.defineProperty(process.stdout, 'isTTY', savedTTY);
});

/** A fully "green light" context; override one field per case to prove the gate. */
function ctx(over: Partial<Parameters<Mod['shouldShowStarNudge']>[0]> = {}) {
  return { quiet: false, isTTY: true, ci: false, optedOut: false, alreadyShown: false, ...over };
}

describe('shouldShowStarNudge gate', () => {
  it('shows when interactive, first time, not quiet/CI/opted-out', () => {
    expect(mod.shouldShowStarNudge(ctx())).toBe(true);
  });

  it('skips quiet/JSON output', () => {
    expect(mod.shouldShowStarNudge(ctx({ quiet: true }))).toBe(false);
  });

  it('skips non-interactive terminals (pipes, redirects)', () => {
    expect(mod.shouldShowStarNudge(ctx({ isTTY: false }))).toBe(false);
  });

  it('skips under CI', () => {
    expect(mod.shouldShowStarNudge(ctx({ ci: true }))).toBe(false);
  });

  it('skips when opted out via AGENTS_NO_NUDGE', () => {
    expect(mod.shouldShowStarNudge(ctx({ optedOut: true }))).toBe(false);
  });

  it('skips once already shown (one-time)', () => {
    expect(mod.shouldShowStarNudge(ctx({ alreadyShown: true }))).toBe(false);
  });
});

/** Run a thunk with console.log captured; returns every logged line. Portable — no vi mocks. */
function captureLog(fn: () => void): string[] {
  const lines: string[] = [];
  const orig = console.log;
  console.log = (...args: unknown[]) => { lines.push(args.map(String).join(' ')); };
  try { fn(); } finally { console.log = orig; }
  return lines;
}

describe('maybeShowStarNudge one-time behavior', () => {
  it('prints exactly once, writes the sentinel, then stays silent', () => {
    // Force the TTY gate on for this non-interactive test process.
    Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });

    expect(mod.hasShownStarNudge()).toBe(false);
    const first = captureLog(() => mod.maybeShowStarNudge());
    const second = captureLog(() => mod.maybeShowStarNudge());
    const third = captureLog(() => mod.maybeShowStarNudge());

    expect(first).toHaveLength(1);
    expect(first[0]).toContain('github.com/phnx-labs/agi-cli');
    expect(second).toHaveLength(0);
    expect(third).toHaveLength(0);
    expect(mod.hasShownStarNudge()).toBe(true);
    // Sentinel really landed under the pinned throwaway HOME.
    expect(fs.existsSync(path.join(TMP_HOME, '.agents', '.cache', 'state', 'star-nudge-shown'))).toBe(true);
  });
});

// Why the guard uses an atomic O_EXCL create: `agents teams` spawns many processes finishing
// together, and existsSync+write is a cross-process TOCTOU race (a reviewer saw 3 of 5
// double-print).
describe('maybeShowStarNudge is race-safe across concurrent processes', () => {
  const tsxBin = fileURLToPath(new URL('../../node_modules/.bin/tsx', import.meta.url));
  const starNudgeSrc = fileURLToPath(new URL('./star-nudge.ts', import.meta.url));
  const runnable = process.platform !== 'win32' && fs.existsSync(tsxBin);

  it.skipIf(!runnable)('prints exactly once when 8 processes finish at once', async () => {
    const raceHome = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-nudge-race-'));
    const fixture = path.join(raceHome, 'child.mts');
    fs.writeFileSync(
      fixture,
      `import { maybeShowStarNudge } from ${JSON.stringify(starNudgeSrc)};\n` +
        `Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });\n` +
        `maybeShowStarNudge();\n`,
    );

    const runChild = () =>
      new Promise<string>((resolve, reject) => {
        const child = spawn(tsxBin, [fixture], {
          env: {
            ...process.env,
            HOME: raceHome,
            // Must travel with HOME: AGENTS_STATE_DIR outranks it, so inheriting
            // the parent's value would point every child at the outer test's
            // sentinel — which already exists, so no child would ever print.
            AGENTS_STATE_DIR: path.join(raceHome, '.agents', '.cache', 'state'),
            CI: '',
            AGENTS_NO_NUDGE: '',
          },
        });
        let out = '';
        child.stdout.on('data', (d) => { out += d.toString(); });
        child.on('error', reject);
        child.on('close', () => resolve(out));
      });

    const outputs = await Promise.all(Array.from({ length: 8 }, runChild));
    const prints = outputs.filter((o) => o.includes('Give it a star')).length;
    expect(prints).toBe(1);
  }, 30000);
});
