import { afterAll, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// Isolate HOME before any module that captures path constants at import time.
const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-cli-system-run-sync-'));
process.env.HOME = TEST_HOME;

const { getVersionHomePath } = await import('./installations/versions.js');
const { applySystemResourcesAtRun } = await import('./system-run-sync.js');
const { upsertResourceProfilePreset, setActiveResourceProfile } = await import('./resource-profiles.js');

const AGENT = 'claude' as const;
const VERSION = '9.9.9';

function writeFile(rel: string, content: string): void {
  const abs = path.join(TEST_HOME, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

function installedSkill(name: string): string {
  return path.join(getVersionHomePath(AGENT, VERSION), '.claude', 'skills', name, 'SKILL.md');
}

function installedSubagent(name: string): string {
  return path.join(getVersionHomePath(AGENT, VERSION), '.claude', 'agents', `${name}.md`);
}

function sleepPastMtimeGranularity(): void {
  const target = Date.now() + 25;
  while (Date.now() < target) { /* spin */ }
}

afterAll(() => {
  fs.rmSync(TEST_HOME, { recursive: true, force: true });
});

writeFile('.agents/.system/skills/artifacts/SKILL.md', '---\nname: artifacts\ndescription: v1\n---\nAlso include at least one Markdown table.\n');
writeFile('.agents/.system/subagents/code-reviewer/AGENT.md', '---\nname: code-reviewer\ndescription: reviews\n---\nReview body.\n');

describe('applySystemResourcesAtRun', () => {
  it('copies the system skills and subagents into the version home on first run', () => {
    const home = getVersionHomePath(AGENT, VERSION);
    const result = applySystemResourcesAtRun(AGENT, VERSION, home);
    expect(result.skills).toEqual(['artifacts']);
    expect(result.subagents).toEqual(['code-reviewer']);
    expect(fs.readFileSync(installedSkill('artifacts'), 'utf-8')).toContain('at least one Markdown table');
    expect(fs.existsSync(installedSubagent('code-reviewer'))).toBe(true);
  });

  it('skips the write when nothing in the system layer changed (skip-fast)', () => {
    const home = getVersionHomePath(AGENT, VERSION);
    const before = fs.statSync(installedSkill('artifacts')).mtimeMs;
    sleepPastMtimeGranularity();
    const result = applySystemResourcesAtRun(AGENT, VERSION, home);
    expect(result).toEqual({ skills: [], subagents: [] });
    expect(fs.statSync(installedSkill('artifacts')).mtimeMs).toBe(before);
  });

  it('rewrites a skill whose source changed, and only that kind', () => {
    const home = getVersionHomePath(AGENT, VERSION);
    sleepPastMtimeGranularity();
    writeFile('.agents/.system/skills/artifacts/SKILL.md', '---\nname: artifacts\ndescription: v2\n---\nPresent information visually. A table is the last resort.\n');
    const result = applySystemResourcesAtRun(AGENT, VERSION, home);
    expect(result.skills).toEqual(['artifacts']);
    expect(result.subagents).toEqual([]);
    expect(fs.readFileSync(installedSkill('artifacts'), 'utf-8')).toContain('Present information visually');
    expect(fs.readFileSync(installedSkill('artifacts'), 'utf-8')).not.toContain('at least one Markdown table');
  });

  it('adds a subagent that appeared in the system layer since the last run', () => {
    const home = getVersionHomePath(AGENT, VERSION);
    sleepPastMtimeGranularity();
    writeFile('.agents/.system/subagents/artifact-critic/AGENT.md', '---\nname: artifact-critic\ndescription: judges shape\n---\nCritic body.\n');
    const result = applySystemResourcesAtRun(AGENT, VERSION, home);
    expect(result.subagents.sort()).toEqual(['artifact-critic', 'code-reviewer']);
    expect(fs.existsSync(installedSubagent('artifact-critic'))).toBe(true);
  });

  it('filters subagents and skills through the active resource profile, like the full sync does', () => {
    const home = getVersionHomePath(AGENT, VERSION);
    upsertResourceProfilePreset('client', { skills: ['artifacts'], subagents: ['code-reviewer'] });
    setActiveResourceProfile('client');
    try {
      sleepPastMtimeGranularity();
      writeFile('.agents/.system/subagents/noise/AGENT.md', '---\nname: noise\ndescription: not for this client\n---\nNoise.\n');
      writeFile('.agents/.system/skills/other/SKILL.md', '---\nname: other\ndescription: not for this client\n---\nOther.\n');
      const result = applySystemResourcesAtRun(AGENT, VERSION, home);
      expect(result.subagents).toEqual(['code-reviewer']);
      expect(result.skills).toEqual(['artifacts']);
      expect(fs.existsSync(installedSubagent('noise'))).toBe(false);
      expect(fs.existsSync(installedSkill('other'))).toBe(false);
    } finally {
      setActiveResourceProfile(null);
    }
  });

  it('retries on the next run when a subagent source fails to write, instead of advancing the sentinel', () => {
    const home = getVersionHomePath(AGENT, VERSION);
    sleepPastMtimeGranularity();
    writeFile('.agents/.system/subagents/broken/AGENT.md', 'no frontmatter at all\n');
    const first = applySystemResourcesAtRun(AGENT, VERSION, home);
    expect(first.subagents).not.toContain('broken');
    // Nothing changed in the source since, yet the kind is attempted again.
    const second = applySystemResourcesAtRun(AGENT, VERSION, home);
    expect(second.subagents.length).toBeGreaterThan(0);
    expect(second.skills).toEqual([]);
  });
});
