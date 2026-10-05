import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as crypto from 'crypto';
import { spawnSync } from 'child_process';

const repoRoot = process.cwd();
const cliEntry = path.join(repoRoot, 'src', 'index.ts');
const tsxBin = path.join(repoRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs');

function mkdir(p: string): void {
  fs.mkdirSync(p, { recursive: true });
}

function writeFile(p: string, content: string): void {
  mkdir(path.dirname(p));
  fs.writeFileSync(p, content, 'utf-8');
}

/** Build a tmp HOME with one Claude version at 9.9.9, a default pin in agents.yaml, and a few
 * user-scoped resources visible to inspect. */
function makeFixture(): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'inspect-test-' + crypto.randomBytes(4).toString('hex') + '-'));

  mkdir(path.join(home, '.agents', '.system', '.git'));
  writeFile(path.join(home, '.agents', '.system', 'hooks.yaml'), '{}\n');

  const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf-8')) as { version: string };
  mkdir(path.join(home, '.agents', '.cache'));
  // A normal (non-isolated) install owns the bare shim; the fixture omitted it and described an
  // impossible state. `inspect` now reports the shim only when it exists, since a phantom path
  // told isolated users their copy was on PATH.
  mkdir(path.join(home, '.agents', '.cache', 'shims'));
  writeFile(path.join(home, '.agents', '.cache', 'shims', 'claude'), '#!/bin/sh\nexit 0\n');
  fs.chmodSync(path.join(home, '.agents', '.cache', 'shims', 'claude'), 0o755);
  writeFile(
    path.join(home, '.agents', '.cache', '.update-check'),
    JSON.stringify({ lastCheck: Date.now(), latestVersion: pkg.version })
  );

  const versionHome = path.join(home, '.agents', '.history', 'versions', 'claude', '9.9.9', 'home');
  const claudeCfg = path.join(versionHome, '.claude');
  mkdir(claudeCfg);
  writeFile(path.join(claudeCfg, 'hooks', 'local-only.sh'), '#!/bin/sh\nexit 0\n');

  writeFile(
    path.join(home, '.agents', 'agents.yaml'),
    'agents:\n  claude: 9.9.9\nrun:\n  claude:\n    strategy: balanced\n'
  );

  const skillDir = path.join(claudeCfg, 'skills', 'demo-skill');
  writeFile(
    path.join(skillDir, 'SKILL.md'),
    '---\nname: demo-skill\ndescription: A demo skill for inspect tests.\ntriggers: demo, hello\n---\n\nBody.\n'
  );

  const skill2Dir = path.join(claudeCfg, 'skills', 'release');
  writeFile(
    path.join(skill2Dir, 'SKILL.md'),
    '---\nname: release\ndescription: Publish packages to a registry.\n---\n\nBody.\n'
  );

  writeFile(
    path.join(claudeCfg, 'commands', 'hello.md'),
    '---\ndescription: Say hello.\n---\n\nGreet the user.\n'
  );

  return home;
}

function run(home: string, args: string[], cwd: string = home) {
  return spawnSync(process.execPath, [tsxBin, cliEntry, ...args], {
    cwd,
    env: {
      ...process.env,
      HOME: home,
      PATH: `${path.join(home, 'bin')}${path.delimiter}${process.env.PATH || ''}`,
      AGENTS_SKIP_MIGRATION: '1',
      NODE_NO_WARNINGS: '1',
    },
    encoding: 'utf-8',
  });
}

/** Build a project dir (separate from HOME's ~/.agents) with resources under `.agents/`, plus decoy
 * top-level `agents.yaml` and `skills/` that must not be mistaken for the DotAgents tree. It holds
 * a skill, a command, and a plugin bundling its own skill. */
function makeProjectRepo(): string {
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'inspect-proj-' + crypto.randomBytes(4).toString('hex') + '-'));

  writeFile(path.join(proj, 'agents.yaml'), 'agents:\n  claude: 9.9.9\n');
  writeFile(
    path.join(proj, 'skills', 'decoy-skill', 'SKILL.md'),
    '---\nname: decoy-skill\ndescription: Top-level source skill, not a DotAgents resource.\n---\n\nBody.\n'
  );

  const dot = path.join(proj, '.agents');
  writeFile(
    path.join(dot, 'skills', 'proj-skill', 'SKILL.md'),
    '---\nname: proj-skill\ndescription: A project-scoped skill.\n---\n\nBody.\n'
  );
  writeFile(path.join(dot, 'commands', 'proj-cmd.md'), '---\ndescription: Project command.\n---\n\nDo it.\n');

  const plugin = path.join(dot, 'plugins', 'myplugin');
  writeFile(
    path.join(plugin, '.claude-plugin', 'plugin.json'),
    JSON.stringify({ name: 'myplugin', description: 'A bundled plugin.', version: '0.0.1' })
  );
  writeFile(
    path.join(plugin, 'skills', 'bundled', 'SKILL.md'),
    '---\nname: bundled\ndescription: Skill shipped inside the plugin.\n---\n\nBody.\n'
  );

  return proj;
}

let fixtureHome: string;

beforeEach(() => {
  fixtureHome = makeFixture();
});

afterEach(() => {
  try { fs.rmSync(fixtureHome, { recursive: true, force: true }); } catch {  }
});

describe('agents inspect', () => {
  it('exits non-zero on a target that is neither an agent nor a repo', () => {
    const r = run(fixtureHome, ['inspect', 'bogus']);
    expect(r.status).toBe(1);
    expect(r.stderr + r.stdout).toMatch(/Unknown target/);
  });

  it('summary --json carries paths, capabilities, and resource counts', () => {
    const r = run(fixtureHome, ['inspect', 'claude', '--json']);
    expect(r.status).toBe(0);
    const data = JSON.parse(r.stdout);
    expect(data.agent).toBe('claude');
    expect(data.version).toBe('9.9.9');
    expect(data.default).toBe(true);
    expect(data.home).toContain(path.join('versions', 'claude', '9.9.9', 'home'));
    expect(data.shim).toContain(path.join('shims', 'claude'));
    expect(data.alias).toContain('claude@9.9.9');
    expect(data.strategy).toBe('balanced');
    expect(data.capabilities.skills.ok).toBe(true);
    expect(data.resources.skills.total).toBeGreaterThanOrEqual(2);
    expect(data.resources.commands.total).toBeGreaterThanOrEqual(1);
    expect(data.resources.hooks.capable).toBe(true);
    expect(data.resources.hooks.onDisk.map((hook: { name: string }) => hook.name)).toContain('local-only');
    expect(data.resources.hooks.wired).toEqual([]);
    expect(data.resources.hooks.unmanaged.map((hook: { name: string }) => hook.name)).toContain('local-only');
    expect(data.resources.hooks.wiringSupported).toBe(true);
  });

  it('prints hook state counts instead of a bare Hooks (0)', () => {
    const r = run(fixtureHome, ['inspect', 'claude']);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('capable yes · on-disk 1 · wired 0 · unmanaged 1');
    expect(r.stdout).not.toContain('Hooks (0)');
  });

  it('--brief skips resources + sessions in JSON output', () => {
    const r = run(fixtureHome, ['inspect', 'claude', '--brief', '--json']);
    expect(r.status).toBe(0);
    const data = JSON.parse(r.stdout);
    expect(data.capabilities).toBeDefined();
    expect(data.resources).toBeNull();
    expect(data.sessions).toBeNull();
  });

  it('--skills lists installed skills with name + source + path', () => {
    const r = run(fixtureHome, ['inspect', 'claude', '--skills', '--json']);
    expect(r.status).toBe(0);
    const data = JSON.parse(r.stdout);
    expect(data.kind).toBe('skills');
    const names = (data.items as Array<{ name: string }>).map(i => i.name);
    expect(names).toContain('demo-skill');
    expect(names).toContain('release');
    const demo = (data.items as Array<{ name: string; path: string }>).find(i => i.name === 'demo-skill');
    expect(demo?.path).toMatch(/skills[\\/]demo-skill$/);
  });

  it('piped list output stays a plain table — never the interactive picker', () => {
    const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'inspect-piped-' + crypto.randomBytes(4).toString('hex') + '-'));
    for (const n of ['alpha', 'bravo', 'charlie']) {
      writeFile(path.join(proj, '.agents', 'skills', n, 'SKILL.md'),
        `---\nname: ${n}\ndescription: "Does the ${n} thing. Triggers on: ${n}, ${n}-alt."\n---\n\nBody.\n`);
    }

    const r = spawnSync(process.execPath, [tsxBin, cliEntry, 'inspect', proj, '--skills'], {
      cwd: proj, env: { ...process.env, HOME: fixtureHome, AGENTS_SKIP_MIGRATION: '1', NODE_NO_WARNINGS: '1', COLUMNS: '120' }, encoding: 'utf-8',
    });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/Name\s+Size\s+Description/);
    for (const n of ['alpha', 'bravo', 'charlie']) expect(r.stdout).toContain(n);
    expect(r.stdout).toContain('Does the alpha thing.');
    expect(r.stdout).not.toContain('Triggers on:');
    expect(r.stdout).not.toContain('Search skills');
    expect(r.stdout).not.toContain('navigate');
  });

  it('keeps each plugin\'s bundled resources on the piped path', () => {
    const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'inspect-groups-' + crypto.randomBytes(4).toString('hex') + '-'));
    const p = path.join(proj, '.agents', 'plugins', 'toolkit');
    writeFile(path.join(p, '.claude-plugin', 'plugin.json'),
      JSON.stringify({ name: 'toolkit', version: '1.0.0', description: 'A toolkit.' }));
    for (const n of ['alpha', 'bravo', 'charlie']) {
      writeFile(path.join(p, 'commands', `${n}.md`), `---\ndescription: ${n}\n---\n\nBody.\n`);
    }

    const r = spawnSync(process.execPath, [tsxBin, cliEntry, 'inspect', proj, '--plugins'], {
      cwd: proj, env: { ...process.env, HOME: fixtureHome, AGENTS_SKIP_MIGRATION: '1', NODE_NO_WARNINGS: '1', COLUMNS: '140' }, encoding: 'utf-8',
    });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/Name\s+Size\s+Description/);
    for (const n of ['alpha', 'bravo', 'charlie']) expect(r.stdout).toContain(`/toolkit:${n}`);
    expect(r.stdout).toContain('commands');
  });

  it('shows a hook what fires it, never a line of its own shell', () => {
    // The agent path specifically: the repo path hardcodes an empty hook description, so a repo
    // fixture cannot reproduce the bug where all 53 hooks under an agent home rendered
    // "!/usr/bin/env bash" as their description.
    const hooksDir = path.join(fixtureHome, '.agents', '.history', 'versions', 'claude', '9.9.9', 'home', '.claude', 'hooks');
    writeFile(path.join(hooksDir, 'guard.sh'), '#!/usr/bin/env bash\nset -euo pipefail\necho ok\n');
    writeFile(path.join(hooksDir, 'guard_test.sh'), '#!/usr/bin/env bash\nset -euo pipefail\n');

    const r = spawnSync(process.execPath, [tsxBin, cliEntry, 'inspect', 'claude', '--hooks'], {
      env: { ...process.env, HOME: fixtureHome, AGENTS_SKIP_MIGRATION: '1', NODE_NO_WARNINGS: '1', COLUMNS: '140' }, encoding: 'utf-8',
    });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).not.toContain('!/usr/bin/env bash');
    expect(r.stdout).not.toContain('set -euo pipefail');
    expect(r.stdout).toContain('guard');
    expect(r.stdout).toContain('guard_test');
  });

  it('renders every item of a long detail row, and survives a malformed manifest', () => {
    const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'inspect-rows-' + crypto.randomBytes(4).toString('hex') + '-'));
    const names = ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot', 'golf', 'hotel', 'india', 'juliet'];
    const many = path.join(proj, '.agents', 'plugins', 'many');
    writeFile(path.join(many, '.claude-plugin', 'plugin.json'),
      JSON.stringify({ name: 'many', description: 'Many commands.', version: '1.0.0' }));
    for (const n of names) writeFile(path.join(many, 'commands', `${n}.md`), `---\ndescription: ${n}.\n---\n\nb\n`);
    // Types that contradict the declared PluginManifest: loadPluginManifest validates only
    // name/version, so these reach the renderer as-is.
    const bad = path.join(proj, '.agents', 'plugins', 'wrongtypes');
    writeFile(path.join(bad, '.claude-plugin', 'plugin.json'),
      JSON.stringify({ name: 'wrongtypes', description: 42, version: 2, dependencies: 'some-plugin', author: ['a'] }));

    const narrow = { ...process.env, COLUMNS: '60' };
    const r = spawnSync(process.execPath, [tsxBin, cliEntry, 'inspect', proj, '--plugin', 'many'], {
      cwd: proj, env: { ...narrow, HOME: fixtureHome, AGENTS_SKIP_MIGRATION: '1', NODE_NO_WARNINGS: '1' }, encoding: 'utf-8',
    });
    expect(r.status).toBe(0);
    for (const n of names) expect(r.stdout).toContain(`/many:${n}`);

    const list = spawnSync(process.execPath, [tsxBin, cliEntry, 'inspect', proj, '--plugins'], {
      cwd: proj, env: { ...narrow, HOME: fixtureHome, AGENTS_SKIP_MIGRATION: '1', NODE_NO_WARNINGS: '1' }, encoding: 'utf-8',
    });
    expect(list.status).toBe(0);
    expect(list.stdout).toContain('many');
    expect(list.stdout).toContain('wrongtypes');

    for (const args of [['--plugin', 'wrongtypes'], ['--plugin', 'wrongtypes', '--json'], ['--plugins', '--json']]) {
      const r2 = spawnSync(process.execPath, [tsxBin, cliEntry, 'inspect', proj, ...args], {
        cwd: proj, env: { ...narrow, HOME: fixtureHome, AGENTS_SKIP_MIGRATION: '1', NODE_NO_WARNINGS: '1' }, encoding: 'utf-8',
      });
      expect(r2.status, `inspect ${args.join(' ')} exited ${r2.status}: ${r2.stderr}`).toBe(0);
    }
  }, 90_000);

  it('bare `inspect <repo>` survives an agents.yaml whose hook field types are wrong', () => {
    const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'inspect-hookfx-' + crypto.randomBytes(4).toString('hex') + '-'));
    writeFile(path.join(proj, '.agents', 'hooks', '10-demo.sh'), '#!/usr/bin/env bash\nexit 0\n');
    writeFile(path.join(proj, '.agents', 'agents.yaml'),
      'hooks:\n  demo:\n    script: 10-demo.sh\n    events: PreToolUse\n    matches:\n      prompt_contains: 12345\n      cwd_includes: 99\n');

    for (const args of [[], ['--json'], ['--hooks'], ['--brief']]) {
      const r = spawnSync(process.execPath, [tsxBin, cliEntry, 'inspect', proj, ...args], {
        cwd: proj, env: { ...process.env, HOME: fixtureHome, AGENTS_SKIP_MIGRATION: '1', NODE_NO_WARNINGS: '1' }, encoding: 'utf-8',
      });
      expect(r.status, `inspect ${args.join(' ')} exited ${r.status}: ${r.stderr}`).toBe(0);
    }
  }, 90_000);

  it('--skills <typo> resolves via fuzzy match; bogus query exits 1 with suggestions', () => {
    const ok = run(fixtureHome, ['inspect', 'claude', '--skills', 'rele', '--json']);
    expect(ok.status).toBe(0);
    const okData = JSON.parse(ok.stdout);
    expect(okData.match.name).toBe('release');

    const fuzzy = run(fixtureHome, ['inspect', 'claude', '--skills', 'demoo-skill', '--json']);
    expect(fuzzy.status).toBe(0);
    const fuzzyData = JSON.parse(fuzzy.stdout);
    expect(fuzzyData.match.name).toBe('demo-skill');
    expect(fuzzyData.match.matchKind).toBe('fuzzy');

    const miss = run(fixtureHome, ['inspect', 'claude', '--skills', 'absolutelynothing', '--json']);
    expect(miss.status).toBe(1);
    const missData = JSON.parse(miss.stdout);
    expect(missData.match).toBeNull();
    expect(Array.isArray(missData.suggestions)).toBe(true);
  });

  it('rejects multiple drill-down flags at once', () => {
    const r = run(fixtureHome, ['inspect', 'claude', '--skills', '--commands']);
    expect(r.status).toBe(1);
    expect(r.stderr + r.stdout).toMatch(/at most one drill-down flag/i);
  });
});

describe('agents inspect <repo>', () => {
  let projectRepo: string;

  beforeEach(() => {
    projectRepo = makeProjectRepo();
  });

  afterEach(() => {
    try { fs.rmSync(projectRepo, { recursive: true, force: true }); } catch {  }
  });

  it('inspect . from a project root reads .agents/, not the top-level source dirs', () => {
    const r = run(fixtureHome, ['inspect', '.', '--json'], projectRepo);
    expect(r.status).toBe(0);
    const data = JSON.parse(r.stdout);
    expect(data.root).toMatch(/\.agents$/);
    expect(data.resources.skills.count).toBe(1);
    expect(data.resources.commands.count).toBe(1);
    expect(data.resources.plugins.count).toBe(1);
  });

  it('--skills lists the .agents/ skill, not the decoy top-level one', () => {
    const r = run(fixtureHome, ['inspect', '.', '--skills', '--json'], projectRepo);
    expect(r.status).toBe(0);
    const names = (JSON.parse(r.stdout).items as Array<{ name: string }>).map(i => i.name);
    expect(names).toContain('proj-skill');
    expect(names).not.toContain('decoy-skill');
  });

  it('--plugins surfaces the manifest description and bundled skills', () => {
    const list = run(fixtureHome, ['inspect', '.', '--plugins', '--json'], projectRepo);
    expect(list.status).toBe(0);
    const item = (JSON.parse(list.stdout).items as Array<{ name: string; description: string }>)
      .find(i => i.name === 'myplugin');
    expect(item?.description).toBe('A bundled plugin.');

    const detail = run(fixtureHome, ['inspect', '.', '--plugins', 'myplugin', '--json'], projectRepo);
    expect(detail.status).toBe(0);
    const match = JSON.parse(detail.stdout).match as { name: string; skills?: string };
    expect(match.name).toBe('myplugin');
    expect(match.skills).toContain('bundled');
  });

  it('resolves built-in repo layers (system) and reports resource counts', () => {
    const r = run(fixtureHome, ['inspect', 'system', '--json']);
    expect(r.status).toBe(0);
    const data = JSON.parse(r.stdout);
    expect(data.repo).toBe('system');
    expect(data.root).toMatch(/\.system$/);
  });
});
