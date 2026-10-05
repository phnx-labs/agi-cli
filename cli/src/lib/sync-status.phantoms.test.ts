import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * Real-filesystem regression tests for the "sync lies about success" cluster
 * (PHNX-3186): `agents sync status` (computeSyncStatus → diffVersionResources)
 * used to report DRIFT that the sync writer never creates and can never clear, so
 * re-running sync forever printed success while the phantom "N missing" stuck.
 *
 * Each test builds a temp HOME with a real version home + real sources, runs the
 * real computeSyncStatus / verifyVersionConverged in a subprocess with HOME
 * pointed at the fixture — no mocks — and asserts the mapping.
 */

let testHome: string;
let userDir: string;
let systemDir: string;
let projectDir: string;

beforeEach(() => {
  testHome = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-phantoms-test-'));
  userDir = path.join(testHome, '.agents');
  systemDir = path.join(userDir, '.system');
  projectDir = path.join(testHome, 'work');
  fs.mkdirSync(userDir, { recursive: true });
  fs.mkdirSync(systemDir, { recursive: true });
  fs.mkdirSync(projectDir, { recursive: true });
  fs.writeFileSync(path.join(userDir, 'agents.yaml'), 'agents: {}\n');
});

afterEach(() => {
  fs.rmSync(testHome, { recursive: true, force: true });
});

/**
 * Install a version for `agent` at `version`: version dir with an executable
 * launch binary (so listInstalledVersions/isVersionInstalled see it) and the
 * config dir. Returns the version home and its config dir.
 */
function makeInstalledVersion(agent: string, version: string, cliCommand: string, configDirName: string): { home: string; configDir: string } {
  const versionDir = path.join(userDir, '.history', 'versions', agent, version);
  const home = path.join(versionDir, 'home');
  const configDir = path.join(home, configDirName);
  fs.mkdirSync(configDir, { recursive: true });
  const binDir = path.join(versionDir, 'node_modules', '.bin');
  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(path.join(binDir, cliCommand), '#!/bin/sh\n');
  fs.chmodSync(path.join(binDir, cliCommand), 0o755);
  return { home, configDir };
}

interface AgentStatus {
  agent: string;
  version: string;
  counts: { synced: number; drifted: number; missing: number; orphan: number };
  needsSync: boolean;
  resources: Array<{ kind: string; name: string; status: string; detail?: string }>;
}

function runStatus(agent: string, kinds?: string[]): AgentStatus {
  const modulePath = path.resolve(process.cwd(), 'src/lib/sync-status.ts');
  const script = `
    import { computeSyncStatus } from ${JSON.stringify(modulePath)};
    const r = await computeSyncStatus({
      cwd: ${JSON.stringify(projectDir)},
      agents: [${JSON.stringify(agent)}],
      kinds: ${kinds ? JSON.stringify(kinds) : 'undefined'},
    });
    console.log(JSON.stringify(r.agents[0] ?? null));
  `;
  const out = execFileSync('bun', ['-e', script], {
    cwd: process.cwd(),
    env: { ...process.env, HOME: testHome },
    stdio: ['ignore', 'pipe', 'inherit'],
  }).toString('utf-8');
  return JSON.parse(out);
}

function runVerify(agent: string, version: string): { agent: string; version: string; rows: Array<{ kind: string; name: string; status: string }> } | null {
  const modulePath = path.resolve(process.cwd(), 'src/lib/sync-status.ts');
  const script = `
    import { verifyVersionConverged } from ${JSON.stringify(modulePath)};
    const r = verifyVersionConverged(${JSON.stringify(agent)}, ${JSON.stringify(version)}, ${JSON.stringify(projectDir)});
    console.log(JSON.stringify(r));
  `;
  const out = execFileSync('bun', ['-e', script], {
    cwd: process.cwd(),
    env: { ...process.env, HOME: testHome },
    stdio: ['ignore', 'pipe', 'inherit'],
  }).toString('utf-8');
  return JSON.parse(out);
}

function resource(s: AgentStatus, kind: string, name: string) {
  return s.resources.find((r) => r.kind === kind && r.name === name);
}

describe('computeSyncStatus — directory docs are not commands (PHNX-3186)', () => {
  it('README/AGENTS in commands/ are never reported as missing or orphan commands', () => {
    const { configDir } = makeInstalledVersion('claude', '2.0.0', 'claude', '.claude');
    const cmdsHome = path.join(configDir, 'commands');
    fs.mkdirSync(cmdsHome, { recursive: true });
    const srcCmds = path.join(userDir, 'commands');
    fs.mkdirSync(srcCmds, { recursive: true });

    // A real command, plus two directory docs the sync writer never installs.
    fs.writeFileSync(path.join(srcCmds, 'plan.md'), 'PLAN\n');
    fs.writeFileSync(path.join(cmdsHome, 'plan.md'), 'PLAN\n');
    fs.writeFileSync(path.join(srcCmds, 'README.md'), '# Commands index\n');
    fs.writeFileSync(path.join(srcCmds, 'AGENTS.md'), '# maintenance contract\n');
    // A stale doc left in a home from an older sync must not become an `extra` either.
    fs.writeFileSync(path.join(cmdsHome, 'AGENTS.md'), '# old\n');

    const s = runStatus('claude', ['commands']);

    expect(resource(s, 'commands', 'plan')?.status).toBe('synced');
    expect(resource(s, 'commands', 'README')).toBeUndefined();
    expect(resource(s, 'commands', 'AGENTS')).toBeUndefined();
    expect(s.counts.missing).toBe(0);
    expect(s.needsSync).toBe(false);
  });
});

describe('computeSyncStatus — command shadowed by a same-named skill (PHNX-3186)', () => {
  it('a command whose name collides with a real skill is not "missing" on a command-as-skill agent', () => {
    // codex >= 0.117 installs commands AS skills; a plugin that ships both a
    // /continue command and a `continue` skill makes the skill win the shared
    // skills/continue slot, and the command wrapper is deliberately never written.
    const { configDir } = makeInstalledVersion('codex', '0.146.0', 'codex', '.codex');
    const skillsHome = path.join(configDir, 'skills');
    fs.mkdirSync(skillsHome, { recursive: true });

    // Sources: a command `foo` AND a real skill `foo`.
    const srcCmds = path.join(userDir, 'commands');
    const srcSkills = path.join(userDir, 'skills');
    fs.mkdirSync(srcCmds, { recursive: true });
    fs.mkdirSync(path.join(srcSkills, 'foo'), { recursive: true });
    fs.writeFileSync(path.join(srcCmds, 'foo.md'), '---\ndescription: cmd foo\n---\nrun foo\n');
    const realSkill = '---\nname: foo\ndescription: the real foo skill\n---\n# foo skill\n';
    fs.writeFileSync(path.join(srcSkills, 'foo', 'SKILL.md'), realSkill);

    // Home: the real skill occupies skills/foo (no agents_command marker).
    fs.mkdirSync(path.join(skillsHome, 'foo'), { recursive: true });
    fs.writeFileSync(path.join(skillsHome, 'foo', 'SKILL.md'), realSkill);

    const s = runStatus('codex', ['commands']);

    const foo = resource(s, 'commands', 'foo');
    // Reported present (shadowed by the skill), NOT the phantom "missing".
    expect(foo?.status).toBe('synced');
    expect(foo?.detail).toBe('provided by same-named skill');
    expect(s.counts.missing).toBe(0);
    expect(s.needsSync).toBe(false);
  });

  it('a command with NO same-named skill is still reported missing when absent', () => {
    const { configDir } = makeInstalledVersion('codex', '0.146.0', 'codex', '.codex');
    fs.mkdirSync(path.join(configDir, 'skills'), { recursive: true });
    const srcCmds = path.join(userDir, 'commands');
    fs.mkdirSync(srcCmds, { recursive: true });
    fs.writeFileSync(path.join(srcCmds, 'bar.md'), '---\ndescription: cmd bar\n---\nrun bar\n');

    const s = runStatus('codex', ['commands']);
    expect(resource(s, 'commands', 'bar')?.status).toBe('missing');
  });
});

describe('computeSyncStatus — presence-only kinds are capability-gated (PHNX-3186)', () => {
  it('a source subagent is not "missing" on a version below the subagents floor', () => {
    // kimi subagents land only at >= 0.29.0; 0.28.0 structurally cannot hold one,
    // so the sync writer never installs it — counting it missing is phantom drift.
    makeInstalledVersion('kimi', '0.28.0', 'kimi', '.kimi-code');
    const srcSub = path.join(userDir, 'subagents');
    fs.mkdirSync(srcSub, { recursive: true });
    fs.writeFileSync(path.join(srcSub, 'code-reviewer.md'), '---\nname: code-reviewer\n---\nreview\n');

    const s = runStatus('kimi', ['subagents']);
    expect(resource(s, 'subagents', 'code-reviewer')).toBeUndefined();
    expect(s.counts.missing).toBe(0);
  });
});

describe('describePluginDrift — a stale marketplace copy is reportable drift (PHNX-2955)', () => {
  // A skill/command that exists in both central and the per-version marketplace
  // mirror but whose BYTES went stale (a skill edit pulled into central, the
  // mirror never refreshed) must be reported as drift — presence alone missed it,
  // so `plugins list`/`doctor`/`sync status` called it `everywhere`/`ok` while
  // agents ran the OLD skill text.
  function makePlugin(dir: string, skillBody: string, cmdBody: string) {
    fs.mkdirSync(path.join(dir, '.claude-plugin'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'code', version: '0.2.0' }));
    fs.mkdirSync(path.join(dir, 'skills', 'review'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'skills', 'review', 'SKILL.md'), skillBody);
    fs.mkdirSync(path.join(dir, 'commands'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'commands', 'ship.md'), cmdBody);
  }

  function describe1(centralBody: string, mirrorBody: string, centralCmd: string, mirrorCmd: string): string | null {
    const modulePath = path.resolve(process.cwd(), 'src/lib/doctor-diff.ts');
    const central = path.join(testHome, 'central');
    const mirror = path.join(testHome, 'mirror');
    fs.rmSync(central, { recursive: true, force: true });
    fs.rmSync(mirror, { recursive: true, force: true });
    makePlugin(central, centralBody, centralCmd);
    makePlugin(mirror, mirrorBody, mirrorCmd);
    const script = `
      import { describePluginDrift } from ${JSON.stringify(modulePath)};
      const central = { name: 'code', root: ${JSON.stringify(central)}, marketplace: 'agents-system', manifest: { name: 'code', version: '0.2.0' } };
      console.log(JSON.stringify(describePluginDrift(central, ${JSON.stringify(mirror)})));
    `;
    const out = execFileSync('bun', ['-e', script], { cwd: process.cwd(), env: { ...process.env, HOME: testHome }, stdio: ['ignore', 'pipe', 'inherit'] }).toString('utf-8');
    return JSON.parse(out);
  }

  it('returns null when the mirror content matches central', () => {
    expect(describe1('SKILL v1\n', 'SKILL v1\n', 'CMD v1\n', 'CMD v1\n')).toBeNull();
  });

  it('reports a stale skill when the mirror SKILL.md bytes differ (the PHNX-2955 repro)', () => {
    const d = describe1('SKILL v2 (edited)\n', 'SKILL v1 (old)\n', 'CMD v1\n', 'CMD v1\n');
    expect(d).not.toBeNull();
    expect(d).toContain('stale skill: review');
  });

  it('reports a stale command when the mirror command bytes differ', () => {
    const d = describe1('SKILL v1\n', 'SKILL v1\n', 'CMD v2\n', 'CMD v1\n');
    expect(d).not.toBeNull();
    expect(d).toContain('stale command: ship');
  });
});

describe('verifyVersionConverged — post-reconcile truth (PHNX-3186)', () => {
  it('returns null when the version home matches its sources', () => {
    const { configDir } = makeInstalledVersion('claude', '2.0.0', 'claude', '.claude');
    const cmdsHome = path.join(configDir, 'commands');
    fs.mkdirSync(cmdsHome, { recursive: true });
    const srcCmds = path.join(userDir, 'commands');
    fs.mkdirSync(srcCmds, { recursive: true });
    fs.writeFileSync(path.join(srcCmds, 'plan.md'), 'PLAN\n');
    fs.writeFileSync(path.join(cmdsHome, 'plan.md'), 'PLAN\n');

    expect(runVerify('claude', '2.0.0')).toBeNull();
  });

  it('returns the specific residual drift when a resource is missing/drifted', () => {
    const { configDir } = makeInstalledVersion('claude', '2.0.0', 'claude', '.claude');
    const cmdsHome = path.join(configDir, 'commands');
    fs.mkdirSync(cmdsHome, { recursive: true });
    const srcCmds = path.join(userDir, 'commands');
    fs.mkdirSync(srcCmds, { recursive: true });
    // missing: source exists, home does not.
    fs.writeFileSync(path.join(srcCmds, 'gap.md'), 'GAP\n');
    // drifted: home differs from source.
    fs.writeFileSync(path.join(srcCmds, 'skew.md'), 'NEW\n');
    fs.writeFileSync(path.join(cmdsHome, 'skew.md'), 'OLD\n');

    const r = runVerify('claude', '2.0.0');
    expect(r).not.toBeNull();
    const names = (r!.rows).map((x) => `${x.status}:${x.name}`).sort();
    expect(names).toContain('missing:gap');
    expect(names).toContain('drifted:skew');
  });
});
