import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function makeHome(): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-resources-'));
  tempDirs.push(home);
  return home;
}

function makeProject(): string {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-resources-project-'));
  tempDirs.push(project);
  return project;
}

function runProbe(
  home: string,
  project: string,
  code: string,
): { stdout: string; stderr: string; status: number | null } {
  const result = spawnSync('node', ['--import', 'tsx', '-e', code], {
    cwd: APP_ROOT,
    encoding: 'utf-8',
    env: {
      ...process.env,
      HOME: home,
      AGENTS_NO_UPDATE_CHECK: '1',
      AGENTS_NO_AUTOPULL: '1',
      AGENTS_SKIP_MIGRATION: '1',
      AGENTS_SECRETS_NO_AGENT: '1',
    },
  });
  return { stdout: result.stdout ?? '', stderr: result.stderr ?? '', status: result.status };
}

describe('resource resolution', () => {
  it('falls through to a lower layer when the top match is excluded by the active profile', () => {
    const home = makeHome();
    const project = makeProject();

    fs.mkdirSync(path.join(project, '.agents', 'skills'), { recursive: true });
    fs.mkdirSync(path.join(home, '.agents', 'skills'), { recursive: true });
    fs.writeFileSync(path.join(project, '.agents', 'skills', 'deploy.md'), 'project deploy');
    fs.writeFileSync(path.join(home, '.agents', 'skills', 'deploy.md'), 'user deploy');

    const result = runProbe(home, project, `
      const { resolveResource, listResources } = await import('./src/lib/resources.ts');
      const { setActiveResourceProfile, upsertResourceProfilePreset } = await import('./src/lib/resource-profiles.ts');

      upsertResourceProfilePreset('work', { skills: ['user:deploy'] });
      setActiveResourceProfile('work');

      console.log(JSON.stringify({
        resolved: resolveResource('skills', 'deploy', ${JSON.stringify(project)}),
        listed: listResources('skills', ${JSON.stringify(project)}),
      }));
    `);

    expect(result.status, result.stderr).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.resolved).toMatchObject({ name: 'deploy', source: 'user' });
    expect(parsed.listed).toHaveLength(1);
    expect(parsed.listed[0]).toMatchObject({ name: 'deploy', source: 'user' });
  });

  it('never treats a directory doc as a resource, so /README is not installed as a command', () => {
    const home = makeHome();
    const project = makeProject();

    const commands = path.join(home, '.agents', 'commands');
    fs.mkdirSync(commands, { recursive: true });
    fs.writeFileSync(path.join(commands, 'plan.md'), 'real command');
    fs.writeFileSync(path.join(commands, 'README.md'), '# Commands');
    fs.writeFileSync(path.join(commands, 'AGENTS.md'), '# contract');
    fs.symlinkSync('AGENTS.md', path.join(commands, 'CLAUDE.md'));
    fs.symlinkSync('AGENTS.md', path.join(commands, 'GEMINI.md'));

    const result = runProbe(home, project, `
      const { resolveResource, listResources } = await import('./src/lib/resources.ts');
      console.log(JSON.stringify({
        listed: listResources('commands', ${JSON.stringify(project)}).map((r) => r.name).sort(),
        readme: resolveResource('commands', 'README', ${JSON.stringify(project)}),
        agents: resolveResource('commands', 'AGENTS', ${JSON.stringify(project)}),
        plan: resolveResource('commands', 'plan', ${JSON.stringify(project)}),
      }));
    `);

    expect(result.status, result.stderr).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.listed).toEqual(['plan']);
    expect(parsed.readme).toBeNull();
    expect(parsed.agents).toBeNull();
    expect(parsed.plan).toMatchObject({ name: 'plan', source: 'user' });
  });

  it('still resolves a resource DIRECTORY named agents/, which is not a doc', () => {
    const home = makeHome();
    const project = makeProject();

    const skills = path.join(home, '.agents', 'skills');
    fs.mkdirSync(path.join(skills, 'agents'), { recursive: true });
    fs.writeFileSync(path.join(skills, 'agents', 'SKILL.md'), '---\nname: agents\n---\n');
    fs.writeFileSync(path.join(skills, 'README.md'), '# Skills');

    const result = runProbe(home, project, `
      const { resolveResource, listResources } = await import('./src/lib/resources.ts');
      console.log(JSON.stringify({
        listed: listResources('skills', ${JSON.stringify(project)}).map((r) => r.name).sort(),
        resolved: resolveResource('skills', 'agents', ${JSON.stringify(project)}),
      }));
    `);

    expect(result.status, result.stderr).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.listed).toEqual(['agents']);
    expect(parsed.resolved).toMatchObject({ name: 'agents', source: 'user' });
  });

  it('keeps listCentralCommands in step with resolveResource — no listed-but-unopenable name', () => {
    const home = makeHome();
    const project = makeProject();

    const commands = path.join(home, '.agents', 'commands');
    fs.mkdirSync(commands, { recursive: true });
    fs.writeFileSync(path.join(commands, 'plan.md'), 'real command');
    fs.writeFileSync(path.join(commands, 'README.md'), '# Commands');
    fs.writeFileSync(path.join(commands, 'AGENTS.md'), '# contract');

    const result = runProbe(home, project, `
      const { listCentralCommands } = await import('./src/lib/commands.ts');
      const { resolveResource } = await import('./src/lib/resources.ts');
      const listed = listCentralCommands().sort();
      console.log(JSON.stringify({
        listed,
        unopenable: listed.filter((n) => resolveResource('commands', n, ${JSON.stringify(project)}) === null),
      }));
    `);

    expect(result.status, result.stderr).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.listed).toEqual(['plan']);
    expect(parsed.unopenable).toEqual([]);
  });

  it('still resolves rules/AGENTS.md, where the doc filename IS the resource', () => {
    const home = makeHome();
    const project = makeProject();

    const rules = path.join(home, '.agents', 'rules');
    fs.mkdirSync(rules, { recursive: true });
    fs.writeFileSync(path.join(rules, 'AGENTS.md'), '# the composed ruleset');

    const result = runProbe(home, project, `
      const { resolveResource, listResources } = await import('./src/lib/resources.ts');
      console.log(JSON.stringify({
        listed: listResources('rules', ${JSON.stringify(project)}).map((r) => r.name),
        resolved: resolveResource('rules', 'AGENTS', ${JSON.stringify(project)}),
      }));
    `);

    expect(result.status, result.stderr).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.listed).toEqual(['AGENTS']);
    expect(parsed.resolved).toMatchObject({ name: 'AGENTS', source: 'user' });
  });

  it('#12: stamps repoRoot + a real snapshotSha when the DotAgents dir is a git repo', () => {
    const home = makeHome();
    const project = makeProject();

    const userAgentsDir = path.join(home, '.agents');
    fs.mkdirSync(path.join(userAgentsDir, 'skills'), { recursive: true });
    fs.writeFileSync(path.join(userAgentsDir, 'skills', 'deploy.md'), 'user deploy');
    spawnSync('git', ['init', '-q', userAgentsDir]);
    spawnSync('git', ['-C', userAgentsDir, 'config', 'user.email', 'test@example.com']);
    spawnSync('git', ['-C', userAgentsDir, 'config', 'user.name', 'Test']);
    spawnSync('git', ['-C', userAgentsDir, 'commit', '--allow-empty', '-q', '-m', 'init']);
    const expectedSha = spawnSync('git', ['-C', userAgentsDir, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf-8' })
      .stdout.trim();

    const result = runProbe(home, project, `
      const { resolveResource, listResources } = await import('./src/lib/resources.ts');
      console.log(JSON.stringify({
        resolved: resolveResource('skills', 'deploy', ${JSON.stringify(project)}),
        listed: listResources('skills', ${JSON.stringify(project)}),
      }));
    `);

    expect(result.status, result.stderr).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.resolved).toMatchObject({ name: 'deploy', source: 'user', repoRoot: userAgentsDir, snapshotSha: expectedSha });
    expect(parsed.listed[0]).toMatchObject({ repoRoot: userAgentsDir, snapshotSha: expectedSha });
  });

  it('#12: repoRoot is stamped even when the DotAgents dir is NOT a git repo — snapshotSha is simply absent', () => {
    const home = makeHome();
    const project = makeProject();

    const userAgentsDir = path.join(home, '.agents');
    fs.mkdirSync(path.join(userAgentsDir, 'skills'), { recursive: true });
    fs.writeFileSync(path.join(userAgentsDir, 'skills', 'deploy.md'), 'user deploy');

    const result = runProbe(home, project, `
      const { resolveResource } = await import('./src/lib/resources.ts');
      const resolved = resolveResource('skills', 'deploy', ${JSON.stringify(project)});
      console.log(JSON.stringify({ resolved }));
    `);

    expect(result.status, result.stderr).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.resolved).toMatchObject({ name: 'deploy', repoRoot: userAgentsDir });
    expect(parsed.resolved.snapshotSha).toBeUndefined();
  });
});

function writeSkill(root: string, name: string, frontmatter: Record<string, unknown>): void {
  const dir = path.join(root, '.agents', 'skills', name);
  fs.mkdirSync(dir, { recursive: true });
  const yamlLines = Object.entries({ name, ...frontmatter })
    .map(([k, v]) => (Array.isArray(v) ? `${k}: [${v.join(', ')}]` : `${k}: ${v}`))
    .join('\n');
  fs.writeFileSync(path.join(dir, 'SKILL.md'), `---\n${yamlLines}\n---\nbody\n`);
}

// Canonical names outrank aliases across layers; alias-vs-alias only uses layer precedence.
describe('resource aliases (RUSH-2504)', () => {
  it('resolves a skill by a declared alias, returning the canonical resource', () => {
    const home = makeHome();
    const project = makeProject();
    writeSkill(home, 'browser', { description: 'drive a browser', aliases: ['agi-browser', 'web'] });

    const result = runProbe(home, project, `
      const { resolveResource } = await import('./src/lib/resources.ts');
      console.log(JSON.stringify({
        byAlias: resolveResource('skills', 'agi-browser', ${JSON.stringify(project)}),
        byAlias2: resolveResource('skills', 'web', ${JSON.stringify(project)}),
        byCanonical: resolveResource('skills', 'browser', ${JSON.stringify(project)}),
        unknown: resolveResource('skills', 'nope', ${JSON.stringify(project)}),
      }));
    `);

    expect(result.status, result.stderr).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.byAlias).toMatchObject({ name: 'browser', source: 'user' });
    expect(parsed.byAlias2).toMatchObject({ name: 'browser', source: 'user' });
    expect(parsed.byCanonical).toMatchObject({ name: 'browser', source: 'user' });
    expect(parsed.byAlias.aliases.sort()).toEqual(['agi-browser', 'web']);
    expect(parsed.unknown).toBeNull();
  });

  it('resolves a command by a declared alias', () => {
    const home = makeHome();
    const project = makeProject();
    const dir = path.join(home, '.agents', 'commands');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'deploy.md'), '---\nname: deploy\ndescription: ship it\naliases: [ship, release]\n---\nbody\n');

    const result = runProbe(home, project, `
      const { resolveResource } = await import('./src/lib/resources.ts');
      console.log(JSON.stringify({
        byAlias: resolveResource('commands', 'ship', ${JSON.stringify(project)}),
        byCanonical: resolveResource('commands', 'deploy', ${JSON.stringify(project)}),
      }));
    `);

    expect(result.status, result.stderr).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.byAlias).toMatchObject({ name: 'deploy', source: 'user' });
    expect(parsed.byCanonical).toMatchObject({ name: 'deploy', source: 'user' });
    expect(parsed.byAlias.aliases.sort()).toEqual(['release', 'ship']);
  });

  it('canonical name always wins a collision with another resource that aliases it', () => {
    const home = makeHome();
    const project = makeProject();
    writeSkill(home, 'browser', { description: 'the real browser skill' });
    writeSkill(home, 'agi-browser', { description: 'imposter', aliases: ['browser'] });

    const result = runProbe(home, project, `
      const { resolveResource } = await import('./src/lib/resources.ts');
      const r = resolveResource('skills', 'browser', ${JSON.stringify(project)});
      console.log(JSON.stringify({ name: r?.name, path: r?.path }));
    `);

    expect(result.status, result.stderr).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.name).toBe('browser');
    expect(parsed.path.endsWith(path.join('skills', 'browser'))).toBe(true);
  });

  it('canonical in a lower layer still beats an alias in a higher layer', () => {
    const home = makeHome();
    const project = makeProject();
    writeSkill(project, 'shipper', { description: 'aliaser', aliases: ['deploy'] });
    writeSkill(home, 'deploy', { description: 'the real deploy skill' });

    const result = runProbe(home, project, `
      const { resolveResource } = await import('./src/lib/resources.ts');
      const r = resolveResource('skills', 'deploy', ${JSON.stringify(project)});
      console.log(JSON.stringify({ name: r?.name, source: r?.source }));
    `);

    expect(result.status, result.stderr).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed).toMatchObject({ name: 'deploy', source: 'user' });
  });

  it('a higher layer wins when two resources alias the same name (no canonical)', () => {
    const home = makeHome();
    const project = makeProject();
    writeSkill(project, 'proj-skill', { description: 'project', aliases: ['shared'] });
    writeSkill(home, 'user-skill', { description: 'user', aliases: ['shared'] });

    const result = runProbe(home, project, `
      const { resolveResource } = await import('./src/lib/resources.ts');
      const r = resolveResource('skills', 'shared', ${JSON.stringify(project)});
      console.log(JSON.stringify({ name: r?.name, source: r?.source }));
    `);

    expect(result.status, result.stderr).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed).toMatchObject({ name: 'proj-skill', source: 'project' });
  });

  it('listResources exposes the declared aliases on each resource', () => {
    const home = makeHome();
    const project = makeProject();
    writeSkill(home, 'browser', { description: 'd', aliases: ['web'] });
    writeSkill(home, 'plain', { description: 'd' });

    const result = runProbe(home, project, `
      const { listResources } = await import('./src/lib/resources.ts');
      const listed = listResources('skills', ${JSON.stringify(project)});
      console.log(JSON.stringify(listed.map((r) => ({ name: r.name, aliases: r.aliases }))));
    `);

    expect(result.status, result.stderr).toBe(0);
    const parsed = JSON.parse(result.stdout).sort((a, b) => a.name.localeCompare(b.name));
    expect(parsed).toEqual([
      { name: 'browser', aliases: ['web'] },
      { name: 'plain' },
    ]);
  });
});
