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

/**
 * Spawn a subprocess with an isolated HOME so os.homedir() returns tempHome.
 * Evaluates `expression` after importing from skills.ts and returns the result.
 */
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

/**
 * Create a minimal valid skill directory with SKILL.md frontmatter.
 */
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

/**
 * Create a fake installed version for an agent so listInstalledVersions() includes it.
 * listInstalledVersions checks for the binary at versions/<agent>/<version>/node_modules/.bin/<cliCommand>.
 * For claude the cliCommand is 'claude'.
 */
function fakeInstalledVersion(home: string, agent: string, version: string, cliCommand: string = agent): void {
  const binDir = path.join(home, '.agents', '.history', 'versions', agent, version, 'node_modules', '.bin');
  fs.mkdirSync(binDir, { recursive: true });
  const binPath = path.join(binDir, cliCommand);
  fs.writeFileSync(binPath, '#!/bin/sh\necho stub\n', { mode: 0o755 });
}

/**
 * Create the skills directory for a specific version home and optionally plant a skill.
 * Path: ~/.agents/versions/<agent>/<version>/home/.<agent>/skills/<skillName>/
 */
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

// ─── removeSkillFromVersion ───────────────────────────────────────────────────

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

    // Original path is gone
    expect(fs.existsSync(skillInVersion), 'skill must be gone from version home').toBe(false);

    // Trash root must exist
    const trashRoot = path.join(home, '.agents', '.history', 'trash', 'skills', agent, version, skillName);
    expect(fs.existsSync(trashRoot), 'trash root for skill must exist').toBe(true);

    // Exactly one timestamped snapshot inside trash root
    const snapshots = fs.readdirSync(trashRoot);
    expect(snapshots).toHaveLength(1);

    // Snapshot must contain SKILL.md
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

    // rules/rule-one.md must survive in the snapshot
    expect(fs.existsSync(path.join(snapshotDir, 'rules', 'rule-one.md'))).toBe(true);
  });

  it('returns success without error when skill does not exist', () => {
    const home = makeTempHome();
    // No skill planted — skills dir doesn't even exist
    const result = runSkills(home, `skills.removeSkillFromVersion('claude', '2.0.0', 'nonexistent')`);
    expect(result).toMatchObject({ success: true });
    // No trash directory should be created for a missing skill
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
    // 0o700 = owner rwx only. NTFS has no POSIX mode bits — POSIX-only assertion.
    expect(stat.mode & 0o777).toBe(0o700);
  });

  it('accumulates multiple snapshots for successive removals of the same skill name', () => {
    const home = makeTempHome();
    const agent = 'claude';
    const version = '2.0.0';
    const skillName = 'repeated-skill';

    // First removal
    plantSkillInVersionHome(home, agent, version, skillName);
    runSkills(home, `skills.removeSkillFromVersion('${agent}', '${version}', '${skillName}')`);

    // Second removal — re-plant the skill
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

    // Structure: .trash/skills/<agent>/<version>/<skillName>/<timestamp>/
    const agentDir = path.join(expectedTrashBase, agent);
    expect(fs.existsSync(agentDir)).toBe(true);

    const versionDir = path.join(agentDir, version);
    expect(fs.existsSync(versionDir)).toBe(true);

    const skillDir = path.join(versionDir, skillName);
    expect(fs.existsSync(skillDir)).toBe(true);

    const [timestamp] = fs.readdirSync(skillDir);
    // Timestamp must look like an ISO string with colons/dots replaced by dashes
    // e.g. 2026-05-09T12-30-00-000Z
    expect(timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z$/);
  });
});

// ─── diffVersionSkills — plugin-provided skills are not orphans (PHNX-3185) ─────

/**
 * Create a plugin under a base repo (`~/.agents` or `~/.agents/.system`) that
 * bundles a skill: `plugins/<plugin>/{.claude-plugin/plugin.json, skills/<name>}`.
 * The manifest carries the name+version pluginSkillDirs requires. Returns the
 * bundled skill's source dir so the caller can mirror its content into a home.
 */
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
  // Codex only sees plugin skills through the flattened top-level copies, so
  // the copy is legitimate there. Claude loads them from the plugin itself
  // (nativePluginSkills), so the same copy is a duplicate — see the last case.
  it('credits a plugin-bundled skill as matched on a flattening harness, never an orphan', () => {
    const home = makeTempHome();
    const agent = 'codex';
    const version = '0.150.0';
    const systemRepo = path.join(home, '.agents', '.system');

    // Source: a plugin bundles `design`. Home: the materialized copy (identical
    // content, so it must read as `matched`, not `toUpdate`).
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

    // A skill in the version home that no source root — central, extra, or
    // plugin — provides. This is the real orphan the detector must still catch.
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
    plantSkillInVersionHome(home, agent, version, 'blog');       // plugin-backed → not orphan
    plantSkillInVersionHome(home, agent, version, 'dead-one');   // no source → orphan

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

    // Claude Code registers the plugin and lists `design:design` itself; the
    // top-level skills/design copy is the second `/design` row in the picker.
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

// ─── diffVersionSkills ────────────────────────────────────────────────────────

describe('diffVersionSkills — orphan detection', () => {
  it('detects a skill in version home that is absent from central as an orphan', () => {
    const home = makeTempHome();
    const agent = 'claude';
    const version = '2.0.0';
    const skillName = 'orphaned-skill';

    // Plant skill in version home but NOT in central ~/.agents/skills/
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

    // Plant skill in central user skills dir only
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

    // Plant identical skill in both central and version home
    const centralSkillsDir = path.join(home, '.agents', 'skills');
    fs.mkdirSync(centralSkillsDir, { recursive: true });
    makeSkillDir(centralSkillsDir, skillName);

    plantSkillInVersionHome(home, agent, version, skillName);
    // Make the version home skill content identical to central
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

    // Central has one version of SKILL.md
    const centralSkillsDir = path.join(home, '.agents', 'skills');
    fs.mkdirSync(centralSkillsDir, { recursive: true });
    const centralSkillDir = path.join(centralSkillsDir, skillName);
    fs.mkdirSync(centralSkillDir, { recursive: true });
    fs.writeFileSync(
      path.join(centralSkillDir, 'SKILL.md'),
      `---\nname: ${skillName}\ndescription: Updated description\n---\n`,
      'utf-8'
    );

    // Version home has an older version
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

    // A command-runtime install writes commands as skill wrappers carrying the
    // `agents_command` marker. It is a command (reconciled by the commands diff),
    // NOT a skill — it must never surface as a skill orphan, or `prune cleanup`
    // would delete a live command (tickets, swarm-plan, …).
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

// ─── iterSkillsCapableVersions ────────────────────────────────────────────────

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
    // No versions installed at all

    const result = runSkills(
      home,
      `skills.iterSkillsCapableVersions({ agent: 'claude', version: '9.9.9' })`
    ) as Array<{ agent: string; version: string }>;

    expect(result).toHaveLength(0);
  });
});
