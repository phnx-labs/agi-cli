import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { pathToFileURL } from 'url';
import { spawnSync } from 'child_process';
import { afterEach, describe, expect, it } from 'vitest';

const tempDirs: string[] = [];

function makeTempHome(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-cli-skills-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

const tsxBin = path.resolve('node_modules/.bin/tsx');
const skillsModuleUrl = pathToFileURL(path.resolve('src/lib/plugins/skills.ts')).href;

/** Spawn a subprocess with an isolated HOME and evaluate `expression` after importing from
 * skills.ts. */
function runSkills(home: string, expression: string): unknown {
  const child = spawnSync(tsxBin, ['-e', `
    import * as skills from ${JSON.stringify(skillsModuleUrl)};
    const result = ${expression};
    if (result && typeof result.then === 'function') {
      result.then((r: unknown) => console.log(JSON.stringify(r)));
    } else {
      console.log(JSON.stringify(result));
    }
  `], {
    env: { ...process.env, HOME: home },
    encoding: 'utf-8',
  });

  expect(child.status, child.stderr).toBe(0);
  return JSON.parse(child.stdout.trim());
}

function makeSkillDir(parentDir: string, skillName: string, opts: { withRules?: boolean } = {}): string {
  const skillDir = path.join(parentDir, skillName);
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(
    path.join(skillDir, 'SKILL.md'),
    `---\nname: ${skillName}\ndescription: Test skill for ${skillName}\n---\n\n# ${skillName}\n`,
    'utf-8'
  );
  if (opts.withRules) {
    const rulesDir = path.join(skillDir, 'rules');
    fs.mkdirSync(rulesDir, { recursive: true });
    fs.writeFileSync(path.join(rulesDir, 'rule-one.md'), '# Rule one\n', 'utf-8');
  }
  return skillDir;
}

/** Create a fake installed version so listInstalledVersions() includes it (it checks
 * versions/<agent>/<version>/node_modules/.bin/<cliCommand>). */
function fakeInstalledVersion(home: string, agent: string, version: string, cliCommand: string = agent): void {
  const binDir = path.join(home, '.agents', '.history', 'versions', agent, version, 'node_modules', '.bin');
  fs.mkdirSync(binDir, { recursive: true });
  const binPath = path.join(binDir, cliCommand);
  fs.writeFileSync(binPath, '#!/bin/sh\necho stub\n', { mode: 0o755 });
}

/** Create a version home's skills directory, optionally planting a skill, under
 * ~/.agents/versions/<agent>/<version>/home/.<agent>/skills/<name>/. */
function plantSkillInVersionHome(
  home: string,
  agent: string,
  version: string,
  skillName: string,
  opts: { withRules?: boolean } = {}
): string {
  const skillsDir = path.join(home, '.agents', '.history', 'versions', agent, version, 'home', `.${agent}`, 'skills');
  fs.mkdirSync(skillsDir, { recursive: true });
  return makeSkillDir(skillsDir, skillName, opts);
}


describe('removeSkillFromVersion — soft-delete', () => {
  it('moves the skill directory to trash instead of deleting it', () => {
    const home = makeTempHome();
    const agent = 'claude';
    const version = '2.0.0';
    const skillName = 'my-skill';

    plantSkillInVersionHome(home, agent, version, skillName);

    const skillInVersion = path.join(
      home, '.agents', '.history', 'versions', agent, version, 'home', `.${agent}`, 'skills', skillName
    );
    expect(fs.existsSync(skillInVersion), 'skill must exist before removal').toBe(true);

    const result = runSkills(home, `skills.removeSkillFromVersion('${agent}', '${version}', '${skillName}')`);
    expect(result).toMatchObject({ success: true });

    expect(fs.existsSync(skillInVersion), 'skill must be gone from version home').toBe(false);

    const trashRoot = path.join(home, '.agents', '.history', 'trash', 'skills', agent, version, skillName);
    expect(fs.existsSync(trashRoot), 'trash root for skill must exist').toBe(true);

    const snapshots = fs.readdirSync(trashRoot);
    expect(snapshots).toHaveLength(1);

    const snapshotDir = path.join(trashRoot, snapshots[0]);
    expect(fs.existsSync(path.join(snapshotDir, 'SKILL.md'))).toBe(true);
  });

  it('preserves nested files (rules/) in the trashed snapshot', () => {
    const home = makeTempHome();
    const agent = 'claude';
    const version = '2.0.0';
    const skillName = 'rule-skill';

    plantSkillInVersionHome(home, agent, version, skillName, { withRules: true });

    runSkills(home, `skills.removeSkillFromVersion('${agent}', '${version}', '${skillName}')`);

    const trashRoot = path.join(home, '.agents', '.history', 'trash', 'skills', agent, version, skillName);
    const [snapshot] = fs.readdirSync(trashRoot);
    const snapshotDir = path.join(trashRoot, snapshot);

    expect(fs.existsSync(path.join(snapshotDir, 'rules', 'rule-one.md'))).toBe(true);
  });

  it('returns success without error when skill does not exist', () => {
    const home = makeTempHome();
    const result = runSkills(home, `skills.removeSkillFromVersion('claude', '2.0.0', 'nonexistent')`);
    expect(result).toMatchObject({ success: true });
    const trashRoot = path.join(home, '.agents', '.history', 'trash', 'skills', 'claude', '2.0.0', 'nonexistent');
    expect(fs.existsSync(trashRoot)).toBe(false);
  });

  it.skipIf(process.platform === 'win32')('creates trash directory with mode 0o700', () => {
    const home = makeTempHome();
    const agent = 'claude';
    const version = '2.0.0';
    const skillName = 'secure-skill';

    plantSkillInVersionHome(home, agent, version, skillName);
    runSkills(home, `skills.removeSkillFromVersion('${agent}', '${version}', '${skillName}')`);

    const trashRoot = path.join(home, '.agents', '.history', 'trash', 'skills', agent, version, skillName);
    const stat = fs.statSync(trashRoot);
    expect(stat.mode & 0o777).toBe(0o700);
  });

  it('accumulates multiple snapshots for successive removals of the same skill name', () => {
    const home = makeTempHome();
    const agent = 'claude';
    const version = '2.0.0';
    const skillName = 'repeated-skill';

    plantSkillInVersionHome(home, agent, version, skillName);
    runSkills(home, `skills.removeSkillFromVersion('${agent}', '${version}', '${skillName}')`);

    plantSkillInVersionHome(home, agent, version, skillName);
    runSkills(home, `skills.removeSkillFromVersion('${agent}', '${version}', '${skillName}')`);

    const trashRoot = path.join(home, '.agents', '.history', 'trash', 'skills', agent, version, skillName);
    const snapshots = fs.readdirSync(trashRoot);
    expect(snapshots).toHaveLength(2);
  });

  it('trash path structure is <agent>/<version>/<skillName>/<timestamp>/', () => {
    const home = makeTempHome();
    const agent = 'claude';
    const version = '1.2.3';
    const skillName = 'path-test';

    plantSkillInVersionHome(home, agent, version, skillName);
    runSkills(home, `skills.removeSkillFromVersion('${agent}', '${version}', '${skillName}')`);

    const expectedTrashBase = path.join(home, '.agents', '.history', 'trash', 'skills');
    expect(fs.existsSync(expectedTrashBase)).toBe(true);

    const agentDir = path.join(expectedTrashBase, agent);
    expect(fs.existsSync(agentDir)).toBe(true);

    const versionDir = path.join(agentDir, version);
    expect(fs.existsSync(versionDir)).toBe(true);

    const skillDir = path.join(versionDir, skillName);
    expect(fs.existsSync(skillDir)).toBe(true);

    const [timestamp] = fs.readdirSync(skillDir);
    expect(timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z$/);
  });
});


/** Create a plugin under a base repo bundling a skill
 * (`plugins/<plugin>/{.claude-plugin/plugin.json, skills/<name>}`); the manifest carries the
 * name+version pluginSkillDirs requires. Returns the skill's source dir. */
function makePluginSkill(baseRepoDir: string, pluginName: string, skillName: string): string {
  const pluginRoot = path.join(baseRepoDir, 'plugins', pluginName);
  fs.mkdirSync(path.join(pluginRoot, '.claude-plugin'), { recursive: true });
  fs.writeFileSync(
    path.join(pluginRoot, '.claude-plugin', 'plugin.json'),
    JSON.stringify({ name: pluginName, version: '1.0.0' }),
    'utf-8',
  );
  const skillsDir = path.join(pluginRoot, 'skills');
  fs.mkdirSync(skillsDir, { recursive: true });
  return makeSkillDir(skillsDir, skillName);
}

describe('diffVersionSkills — plugin-provided skills (PHNX-3185)', () => {
  it('credits a plugin-bundled skill as matched on a flattening harness, never an orphan', () => {
    const home = makeTempHome();
    const agent = 'codex';
    const version = '0.150.0';
    const systemRepo = path.join(home, '.agents', '.system');

    makePluginSkill(systemRepo, 'design', 'design');
    plantSkillInVersionHome(home, agent, version, 'design');

    const diff = runSkills(home, `skills.diffVersionSkills('${agent}', '${version}')`) as {
      orphans: string[];
      matched: string[];
      toUpdate: string[];
    };

    expect(diff.orphans).not.toContain('design');
    expect(diff.matched).toContain('design');
    expect(diff.toUpdate).not.toContain('design');
  });

  it('still flags a genuinely dead skill (no source anywhere) as an orphan', () => {
    const home = makeTempHome();
    const agent = 'claude';
    const version = '2.1.226';

    plantSkillInVersionHome(home, agent, version, 'ghost-skill');

    const diff = runSkills(home, `skills.diffVersionSkills('${agent}', '${version}')`) as {
      orphans: string[];
    };

    expect(diff.orphans).toContain('ghost-skill');
  });

  it('credits a plugin skill from a user-repo plugin too, alongside a real orphan', () => {
    const home = makeTempHome();
    const agent = 'codex';
    const version = '0.150.0';
    const userRepo = path.join(home, '.agents');

    makePluginSkill(userRepo, 'write', 'blog');
    plantSkillInVersionHome(home, agent, version, 'blog');
    plantSkillInVersionHome(home, agent, version, 'dead-one');

    const diff = runSkills(home, `skills.diffVersionSkills('${agent}', '${version}')`) as {
      orphans: string[];
      matched: string[];
    };

    expect(diff.orphans).toEqual(['dead-one']);
    expect(diff.matched).toContain('blog');
  });

  it('flags a flattened plugin skill as an orphan on a harness that loads plugin skills natively', () => {
    const home = makeTempHome();
    const agent = 'claude';
    const version = '2.1.226';
    const systemRepo = path.join(home, '.agents', '.system');

    makePluginSkill(systemRepo, 'design', 'design');
    plantSkillInVersionHome(home, agent, version, 'design');

    const diff = runSkills(home, `skills.diffVersionSkills('${agent}', '${version}')`) as {
      orphans: string[];
      matched: string[];
      toAdd: string[];
    };

    expect(diff.orphans).toEqual(['design']);
    expect(diff.matched).not.toContain('design');
    expect(diff.toAdd).not.toContain('design');
  });
});


describe('diffVersionSkills — orphan detection', () => {
  it('detects a skill in version home that is absent from central as an orphan', () => {
    const home = makeTempHome();
    const agent = 'claude';
    const version = '2.0.0';
    const skillName = 'orphaned-skill';

    plantSkillInVersionHome(home, agent, version, skillName);

    const result = runSkills(
      home,
      `skills.diffVersionSkills('${agent}', '${version}')`
    ) as { orphans: string[]; toAdd: string[]; toUpdate: string[]; matched: string[] };

    expect(result.orphans).toContain(skillName);
    expect(result.toAdd).not.toContain(skillName);
  });

  it('detects a central skill missing from version home as toAdd', () => {
    const home = makeTempHome();
    const agent = 'claude';
    const version = '2.0.0';
    const skillName = 'new-central-skill';

    const centralSkillsDir = path.join(home, '.agents', 'skills');
    fs.mkdirSync(centralSkillsDir, { recursive: true });
    makeSkillDir(centralSkillsDir, skillName);

    const result = runSkills(
      home,
      `skills.diffVersionSkills('${agent}', '${version}')`
    ) as { toAdd: string[]; orphans: string[] };

    expect(result.toAdd).toContain(skillName);
    expect(result.orphans).not.toContain(skillName);
  });

  it('reports matched when version skill content equals central', () => {
    const home = makeTempHome();
    const agent = 'claude';
    const version = '2.0.0';
    const skillName = 'synced-skill';

    const centralSkillsDir = path.join(home, '.agents', 'skills');
    fs.mkdirSync(centralSkillsDir, { recursive: true });
    makeSkillDir(centralSkillsDir, skillName);

    plantSkillInVersionHome(home, agent, version, skillName);
    const versionSkillMd = path.join(
      home, '.agents', '.history', 'versions', agent, version, 'home', `.${agent}`, 'skills', skillName, 'SKILL.md'
    );
    const centralSkillMd = path.join(centralSkillsDir, skillName, 'SKILL.md');
    fs.writeFileSync(versionSkillMd, fs.readFileSync(centralSkillMd, 'utf-8'), 'utf-8');

    const result = runSkills(
      home,
      `skills.diffVersionSkills('${agent}', '${version}')`
    ) as { matched: string[]; toUpdate: string[]; orphans: string[] };

    expect(result.matched).toContain(skillName);
    expect(result.toUpdate).not.toContain(skillName);
    expect(result.orphans).not.toContain(skillName);
  });

  it('reports toUpdate when version skill content differs from central', () => {
    const home = makeTempHome();
    const agent = 'claude';
    const version = '2.0.0';
    const skillName = 'stale-skill';

    const centralSkillsDir = path.join(home, '.agents', 'skills');
    fs.mkdirSync(centralSkillsDir, { recursive: true });
    const centralSkillDir = path.join(centralSkillsDir, skillName);
    fs.mkdirSync(centralSkillDir, { recursive: true });
    fs.writeFileSync(
      path.join(centralSkillDir, 'SKILL.md'),
      `---\nname: ${skillName}\ndescription: Updated description\n---\n`,
      'utf-8'
    );

    plantSkillInVersionHome(home, agent, version, skillName);

    const result = runSkills(
      home,
      `skills.diffVersionSkills('${agent}', '${version}')`
    ) as { toUpdate: string[]; matched: string[] };

    expect(result.toUpdate).toContain(skillName);
    expect(result.matched).not.toContain(skillName);
  });

  it('returns empty arrays when version home has no skills and central is empty', () => {
    const home = makeTempHome();

    const result = runSkills(
      home,
      `skills.diffVersionSkills('claude', '2.0.0')`
    ) as { toAdd: string[]; toUpdate: string[]; matched: string[]; orphans: string[] };

    expect(result.toAdd).toHaveLength(0);
    expect(result.toUpdate).toHaveLength(0);
    expect(result.matched).toHaveLength(0);
    expect(result.orphans).toHaveLength(0);
  });

  it('does NOT flag a command-as-skill wrapper (agents_command marker) as a skill orphan', () => {
    const home = makeTempHome();
    const agent = 'claude';
    const version = '2.0.0';

    // A command-runtime install writes commands as skill wrappers with the `agents_command` marker.
    // They are commands, not skills, and must never surface as skill orphans or `prune cleanup`
    // would delete a live command.
    const skillsDir = path.join(home, '.agents', '.history', 'versions', agent, version, 'home', `.${agent}`, 'skills');
    fs.mkdirSync(path.join(skillsDir, 'tickets'), { recursive: true });
    fs.writeFileSync(
      path.join(skillsDir, 'tickets', 'SKILL.md'),
      `---\nname: "tickets"\ndescription: ticket wrapper\nagents_command: "tickets"\n---\n\n# /tickets\n`,
      'utf-8'
    );

    const result = runSkills(
      home,
      `skills.diffVersionSkills('${agent}', '${version}')`
    ) as { orphans: string[] };

    expect(result.orphans).not.toContain('tickets');
    expect(result.orphans).toHaveLength(0);
  });

  it('reports central skills as matched for Goose without a per-version copy', () => {
    const home = makeTempHome();
    const version = '1.43.0';
    const skillName = 'native-central-skill';

    const centralSkillsDir = path.join(home, '.agents', 'skills');
    fs.mkdirSync(centralSkillsDir, { recursive: true });
    makeSkillDir(centralSkillsDir, skillName);

    const result = runSkills(
      home,
      `skills.diffVersionSkills('goose', '${version}')`
    ) as { toAdd: string[]; toUpdate: string[]; matched: string[]; orphans: string[] };

    expect(result).toEqual({
      agent: 'goose',
      version,
      toAdd: [],
      toUpdate: [],
      matched: [skillName],
      orphans: [],
    });
    expect(fs.existsSync(
      path.join(home, '.agents', '.history', 'versions', 'goose', version, 'home', '.config', 'goose', 'skills')
    )).toBe(false);
  });
});


describe('iterSkillsCapableVersions', () => {
  it('returns empty array when no versions are installed', () => {
    const home = makeTempHome();
    const result = runSkills(home, 'skills.iterSkillsCapableVersions()') as Array<{ agent: string; version: string }>;
    expect(result).toEqual([]);
  });

  it('returns installed claude versions (claude supports skills)', () => {
    const home = makeTempHome();
    fakeInstalledVersion(home, 'claude', '2.0.0', 'claude');
    fakeInstalledVersion(home, 'claude', '2.1.0', 'claude');

    const result = runSkills(home, 'skills.iterSkillsCapableVersions()') as Array<{ agent: string; version: string }>;
    const claudeVersions = result.filter(p => p.agent === 'claude').map(p => p.version).sort();
    expect(claudeVersions).toEqual(['2.0.0', '2.1.0']);
  });

  it('filters to only the specified agent when agent filter is provided', () => {
    const home = makeTempHome();
    fakeInstalledVersion(home, 'claude', '2.0.0', 'claude');

    const result = runSkills(
      home,
      `skills.iterSkillsCapableVersions({ agent: 'claude' })`
    ) as Array<{ agent: string; version: string }>;

    expect(result.every(p => p.agent === 'claude')).toBe(true);
  });

  it('filters to only the specified version when version filter is provided', () => {
    const home = makeTempHome();
    fakeInstalledVersion(home, 'claude', '2.0.0', 'claude');
    fakeInstalledVersion(home, 'claude', '2.1.0', 'claude');

    const result = runSkills(
      home,
      `skills.iterSkillsCapableVersions({ version: '2.0.0' })`
    ) as Array<{ agent: string; version: string }>;

    expect(result.every(p => p.version === '2.0.0')).toBe(true);
    expect(result.some(p => p.version === '2.1.0')).toBe(false);
  });

  it('returns empty array when agent+version filter matches nothing installed', () => {
    const home = makeTempHome();

    const result = runSkills(
      home,
      `skills.iterSkillsCapableVersions({ agent: 'claude', version: '9.9.9' })`
    ) as Array<{ agent: string; version: string }>;

    expect(result).toHaveLength(0);
  });
});
