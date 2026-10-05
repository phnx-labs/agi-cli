import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

let TEST_ROOT: string;
let PRIMARY_AGENTS_DIR: string;
let EXTRA_ROOT: string;
let ENABLED_EXTRAS: Array<{ alias: string; dir: string; url: string }>;

vi.mock('../src/lib/state.js', () => {
  return {
    get getAgentsDir() { return () => PRIMARY_AGENTS_DIR; },
    get getSystemAgentsDir() { return () => PRIMARY_AGENTS_DIR; },
    get getUserAgentsDir() { return () => PRIMARY_AGENTS_DIR; },
    get getSkillsDir() { return () => path.join(PRIMARY_AGENTS_DIR, 'skills'); },
    get getSystemSkillsDir() { return () => path.join(PRIMARY_AGENTS_DIR, 'skills'); },
    get getUserSkillsDir() { return () => path.join(PRIMARY_AGENTS_DIR, 'skills'); },
    get getProjectAgentsDir() { return () => null; },
    get getEnabledExtraRepos() { return () => ENABLED_EXTRAS; },
    get ensureAgentsDir() { return () => fs.mkdirSync(PRIMARY_AGENTS_DIR, { recursive: true }); },
  };
});

vi.mock('../src/lib/agents.js', () => ({
  AGENTS: {},
  SKILLS_CAPABLE_AGENTS: [],
  ensureSkillsDir: () => {},
}));

vi.mock('../src/lib/installations/versions.js', () => ({
  getEffectiveHome: () => '',
  getVersionHomePath: () => '',
  listInstalledVersions: () => [],
}));

async function importSkillsLib() {
  return await import('../src/lib/plugins/skills.js');
}

function writeSkill(baseSkillsDir: string, name: string, description: string): void {
  const dir = path.join(baseSkillsDir, name);
  fs.mkdirSync(dir, { recursive: true });
  const frontmatter = `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n`;
  fs.writeFileSync(path.join(dir, 'SKILL.md'), frontmatter);
}

describe('listInstalledSkills with extra repos', () => {
  beforeEach(() => {
    TEST_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-extra-'));
    PRIMARY_AGENTS_DIR = path.join(TEST_ROOT, 'primary');
    EXTRA_ROOT = path.join(TEST_ROOT, 'extras');
    fs.mkdirSync(path.join(PRIMARY_AGENTS_DIR, 'skills'), { recursive: true });
    fs.mkdirSync(EXTRA_ROOT, { recursive: true });
    ENABLED_EXTRAS = [];
  });

  afterEach(() => {
    if (fs.existsSync(TEST_ROOT)) {
      fs.rmSync(TEST_ROOT, { recursive: true, force: true });
    }
  });

  it('returns only primary skills when no extras are registered', async () => {
    writeSkill(path.join(PRIMARY_AGENTS_DIR, 'skills'), 'linear', 'primary linear');
    writeSkill(path.join(PRIMARY_AGENTS_DIR, 'skills'), 'debug', 'primary debug');

    const { listInstalledSkills } = await importSkillsLib();
    const skills = listInstalledSkills();

    expect(skills.size).toBe(2);
    expect(skills.get('linear')?.source).toBeUndefined();
    expect(skills.get('debug')?.source).toBeUndefined();
  });

  it('merges skills from primary and one extra repo', async () => {
    writeSkill(path.join(PRIMARY_AGENTS_DIR, 'skills'), 'linear', 'primary linear');

    const workDir = path.join(EXTRA_ROOT, 'work');
    writeSkill(path.join(workDir, 'skills'), 'work-tracker', 'private work tracker');
    ENABLED_EXTRAS = [{ alias: 'work', dir: workDir, url: 'gh:me/.agents-work' }];

    const { listInstalledSkills } = await importSkillsLib();
    const skills = listInstalledSkills();

    expect(skills.size).toBe(2);
    expect(skills.get('linear')?.source).toBeUndefined();
    expect(skills.get('work-tracker')?.source).toBe('work');
  });

  it('primary wins on name collision with an extra', async () => {
    writeSkill(path.join(PRIMARY_AGENTS_DIR, 'skills'), 'linear', 'primary linear');

    const workDir = path.join(EXTRA_ROOT, 'work');
    writeSkill(path.join(workDir, 'skills'), 'linear', 'extra linear — should lose');
    ENABLED_EXTRAS = [{ alias: 'work', dir: workDir, url: 'gh:me/.agents-work' }];

    const { listInstalledSkills } = await importSkillsLib();
    const linear = listInstalledSkills().get('linear');

    expect(linear).toBeDefined();
    expect(linear!.source).toBeUndefined();
    expect(linear!.metadata.description).toBe('primary linear');
    expect(linear!.path).toBe(path.join(PRIMARY_AGENTS_DIR, 'skills', 'linear'));
  });

  it('earlier extra wins on name collision with a later extra', async () => {
    const workDir = path.join(EXTRA_ROOT, 'work');
    const teamDir = path.join(EXTRA_ROOT, 'team');
    writeSkill(path.join(workDir, 'skills'), 'shared', 'from work');
    writeSkill(path.join(teamDir, 'skills'), 'shared', 'from team — should lose');
    ENABLED_EXTRAS = [
      { alias: 'work', dir: workDir, url: 'gh:me/.agents-work' },
      { alias: 'team', dir: teamDir, url: 'gh:team/skills' },
    ];

    const { listInstalledSkills } = await importSkillsLib();
    const shared = listInstalledSkills().get('shared');

    expect(shared?.source).toBe('work');
    expect(shared?.metadata.description).toBe('from work');
  });

  it('ignores hidden directories in primary and extras', async () => {
    writeSkill(path.join(PRIMARY_AGENTS_DIR, 'skills'), '.hidden-system', 'should be skipped');
    writeSkill(path.join(PRIMARY_AGENTS_DIR, 'skills'), 'real', 'normal skill');

    const workDir = path.join(EXTRA_ROOT, 'work');
    writeSkill(path.join(workDir, 'skills'), '.private', 'should be skipped too');
    ENABLED_EXTRAS = [{ alias: 'work', dir: workDir, url: 'gh:me/.agents-work' }];

    const { listInstalledSkills } = await importSkillsLib();
    const skills = listInstalledSkills();

    expect(skills.has('.hidden-system')).toBe(false);
    expect(skills.has('.private')).toBe(false);
    expect(skills.has('real')).toBe(true);
  });
});
