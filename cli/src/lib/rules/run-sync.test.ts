import { afterAll, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-cli-rules-run-sync-'));
process.env.HOME = TEST_HOME;

const { AGENTS, agentConfigDirName } = await import('../agents.js');
const { setActiveRulesPreset } = await import('../state.js');
const { getVersionHomePath } = await import('../installations/versions.js');
const { applyActiveRulesPresetAtRun } = await import('./run-sync.js');

const AGENT = 'claude' as const;

function writeFile(rel: string, content: string): void {
  const abs = path.join(TEST_HOME, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

function destFile(version: string): string {
  const cap = AGENTS[AGENT].capabilities.rules;
  if (cap === false) throw new Error('test agent must support rules');
  return path.join(getVersionHomePath(AGENT, version), agentConfigDirName(AGENT), cap.file);
}

function sleepPastMtimeGranularity(): void {
  const target = Date.now() + 25;
  while (Date.now() < target) {  }
}

afterAll(() => {
  fs.rmSync(TEST_HOME, { recursive: true, force: true });
});

// System-layer presets never auto-append an un-named subrule (only user/extra layers do, see
// rules/compose.ts), so 'default' and 'alt' resolve to genuinely disjoint source-file sets, the
// realistic shape of a preset switch (see .system/rules/rules.yaml in this repo).
writeFile(
  '.agents/.system/rules/rules.yaml',
  'presets:\n  default:\n    subrules: [alpha]\n  alt:\n    subrules: [beta]\n',
);
writeFile('.agents/.system/rules/subrules/alpha.md', 'ALPHA RULE BODY');
writeFile('.agents/.system/rules/subrules/beta.md', 'BETA RULE BODY');

describe('applyActiveRulesPresetAtRun', () => {
  const VERSION = '9.9.9';

  it('writes the composed preset into the version home on first apply', () => {
    const versionHome = getVersionHomePath(AGENT, VERSION);
    const applied = applyActiveRulesPresetAtRun(AGENT, VERSION, versionHome);

    expect(applied).toBe(true);
    expect(fs.readFileSync(destFile(VERSION), 'utf-8')).toContain('ALPHA RULE BODY');
  });

  it('skips the write on a second call with nothing changed (skip-fast)', () => {
    const versionHome = getVersionHomePath(AGENT, VERSION);
    const mtimeBefore = fs.statSync(destFile(VERSION)).mtimeMs;
    sleepPastMtimeGranularity();

    const applied = applyActiveRulesPresetAtRun(AGENT, VERSION, versionHome);

    expect(applied).toBe(false);
    expect(fs.statSync(destFile(VERSION)).mtimeMs).toBe(mtimeBefore);
    expect(fs.readFileSync(destFile(VERSION), 'utf-8')).toContain('ALPHA RULE BODY');
  });

  it('re-applies WITHOUT an explicit `rules switch` when the active preset changes', () => {
    const versionHome = getVersionHomePath(AGENT, VERSION);

    setActiveRulesPreset(AGENT, VERSION, 'alt');

    const applied = applyActiveRulesPresetAtRun(AGENT, VERSION, versionHome);

    expect(applied).toBe(true);
    const content = fs.readFileSync(destFile(VERSION), 'utf-8');
    expect(content).toContain('BETA RULE BODY');
    expect(content).not.toContain('ALPHA RULE BODY');
  });

  it('skips fast again once the new preset has been applied', () => {
    const versionHome = getVersionHomePath(AGENT, VERSION);
    const mtimeBefore = fs.statSync(destFile(VERSION)).mtimeMs;
    sleepPastMtimeGranularity();

    const applied = applyActiveRulesPresetAtRun(AGENT, VERSION, versionHome);

    expect(applied).toBe(false);
    expect(fs.statSync(destFile(VERSION)).mtimeMs).toBe(mtimeBefore);
  });

  it('is a no-op for a version with no version home to sync into yet', () => {
    // First-run-after-add shape: nothing synced for this version yet, but the preset still resolves
    // from the system layer, so the ordinary compose+write path runs and must not throw for an
    // unseen version.
    const version = '0.0.1-unsynced';
    const versionHome = getVersionHomePath(AGENT, version);
    expect(() => applyActiveRulesPresetAtRun(AGENT, version, versionHome)).not.toThrow();
    expect(fs.existsSync(destFile(version))).toBe(true);
  });
});

describe('applyActiveRulesPresetAtRun — preset switch with an unchanged file set', () => {
  // User-layer subrules auto-append into EVERY preset that doesn't exclude them, so two
  // differently-named presets can resolve to the identical source-file set. isRulesStale's
  // fingerprint alone would miss a preset switch; the sentinel also tracks the preset name.
  const VERSION = '8.8.8';

  writeFile(
    '.agents/rules/rules.yaml',
    'presets:\n    p1:\n      subrules: []\n    p2:\n      subrules: []\n',
  );
  writeFile('.agents/rules/subrules/shared.md', 'SHARED RULE BODY');

  it('reports a fresh apply when only the preset name changes, even with an identical file set', () => {
    const versionHome = getVersionHomePath(AGENT, VERSION);

    setActiveRulesPreset(AGENT, VERSION, 'p1');
    expect(applyActiveRulesPresetAtRun(AGENT, VERSION, versionHome)).toBe(true);

    const mtimeBefore = fs.statSync(destFile(VERSION)).mtimeMs;
    sleepPastMtimeGranularity();

    setActiveRulesPreset(AGENT, VERSION, 'p2');
    const applied = applyActiveRulesPresetAtRun(AGENT, VERSION, versionHome);

    expect(applied).toBe(true);
    expect(fs.statSync(destFile(VERSION)).mtimeMs).not.toBe(mtimeBefore);
  });
});
