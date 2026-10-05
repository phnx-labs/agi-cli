import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync, execFileSync } from 'child_process';
import { spawn as ptySpawn } from '@homebridge/node-pty-prebuilt-multiarch';
import { Command } from 'commander';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as crypto from 'crypto';
import { fileURLToPath } from 'url';
import { registerSyncCommand } from './sync.js';
import { addSelectorOptions } from './sync.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const INDEX = path.join(REPO_ROOT, 'src', 'index.ts');

let testHome: string | undefined;

afterEach(() => {
  if (testHome) {
    fs.rmSync(testHome, { recursive: true, force: true });
    testHome = undefined;
  }
});

function guardedHome(): string {
  testHome = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-sync-json-'));
  const systemDir = path.join(testHome, '.agents', '.system');
  fs.mkdirSync(path.join(systemDir, '.git'), { recursive: true });
  fs.writeFileSync(
    path.join(systemDir, '.update-check'),
    JSON.stringify({ lastCheck: 4102444800000, latestVersion: '0.0.0' }),
  );
  return testHome;
}

function run(args: string[], home: string): { stdout: string; stderr: string; status: number | null } {
  const r = spawnSync('bun', [INDEX, ...args], {
    encoding: 'utf-8',
    env: {
      ...process.env,
      HOME: home,
      AGENTS_NO_UPDATE_CHECK: '1',
      AGENTS_SECRETS_PASSPHRASE: '',
    },
  });
  return {
    stdout: r.stdout ?? '',
    stderr: r.stderr ?? '',
    status: r.status,
  };
}


function buildSyncProbe(): Command {
  const probe = new Command('sync').exitOverride();
  addSelectorOptions(probe);
  return probe;
}


describe('agents sync per-kind selector flags', () => {
  it('all per-kind flags are registered on the sync command', () => {
    const program = new Command();
    program.exitOverride();
    registerSyncCommand(program);
    const sync = program.commands.find((c) => c.name() === 'sync')!;
    const longs = (sync!.options ?? []).map((o) => o.long);
    for (const flag of [
      '--plugin', '--plugins',
      '--command', '--commands',
      '--skill', '--skills',
      '--hook', '--hooks',
      '--subagent', '--subagents',
      '--permission', '--permissions',
      '--mcp', '--mcps',
      '--workflow', '--workflows',
      '--rule', '--rules',
      '--memory',
    ]) {
      expect(longs, `missing flag ${flag}`).toContain(flag);
    }
  });

  it('singular and plural flags accumulate the same value (--plugin fleet == --plugins fleet)', () => {
    const a = buildSyncProbe();
    a.parse(['--plugin', 'fleet'], { from: 'user' });
    const b = buildSyncProbe();
    b.parse(['--plugins', 'fleet'], { from: 'user' });
    expect(a.opts().plugin).toEqual(['fleet']);
    expect(b.opts().plugins).toEqual(['fleet']);
  });

  it('bare flag (no value) yields true → "all of that kind"', () => {
    const probe = buildSyncProbe();
    probe.parse(['--plugins'], { from: 'user' });
    expect(probe.opts().plugins).toBe(true);
  });

  it('bare --skills sets skills only, leaves other kinds undefined', () => {
    const probe = buildSyncProbe();
    probe.parse(['--skills'], { from: 'user' });
    const opts = probe.opts();
    expect(opts.skills).toBe(true);
    expect(opts.plugins).toBeUndefined();
    expect(opts.hooks).toBeUndefined();
    expect(opts.commands).toBeUndefined();
  });

  it('kind flags are additive: --plugins --hooks sets both, leaves others undefined', () => {
    const probe = buildSyncProbe();
    probe.parse(['--plugins', '--hooks'], { from: 'user' });
    const opts = probe.opts();
    expect(opts.plugins).toBe(true);
    expect(opts.hooks).toBe(true);
    expect(opts.skills).toBeUndefined();
    expect(opts.commands).toBeUndefined();
    expect(opts.subagents).toBeUndefined();
  });

  it('repeated flags accumulate: --plugin fleet --plugin code → [fleet, code]', () => {
    const probe = buildSyncProbe();
    probe.parse(['--plugin', 'fleet', '--plugin', 'code'], { from: 'user' });
    expect(probe.opts().plugin).toEqual(['fleet', 'code']);
  });

  it('comma-separated value accumulates: --plugin fleet,code → [fleet, code]', () => {
    const probe = buildSyncProbe();
    probe.parse(['--plugin', 'fleet,code'], { from: 'user' });
    expect(probe.opts().plugin).toEqual(['fleet', 'code']);
  });

  it('--rule and --rules are registered as kind flags for the memory kind', () => {
    const probe = buildSyncProbe();
    probe.parse(['--rule'], { from: 'user' });
    expect(probe.opts().rule).toBeTruthy();
  });

  it('--memory is registered as a boolean flag aliasing the rule kind', () => {
    const probe = buildSyncProbe();
    probe.parse(['--memory'], { from: 'user' });
    expect(probe.opts().memory).toBe(true);
  });
});


function seedFakeClaudeVersions(home: string, versions: string[]): void {
  for (const ver of versions) {
    const pkgDir = path.join(
      home, '.agents', '.history', 'versions', 'claude', ver,
      'node_modules', '@anthropic-ai', 'claude-code',
    );
    const binDir = path.join(pkgDir, 'bin');
    fs.mkdirSync(binDir, { recursive: true });
    fs.writeFileSync(
      path.join(pkgDir, 'package.json'),
      JSON.stringify({ name: '@anthropic-ai/claude-code', version: ver, bin: { claude: 'bin/claude' } }),
    );
    fs.writeFileSync(path.join(binDir, 'claude'), '#!/bin/sh\n');
    fs.chmodSync(path.join(binDir, 'claude'), 0o755);
  }
}

describe('agents sync auto-promotion to @all', () => {
  it('targets all versions when multiple are installed and no default is pinned', () => {
    const home = guardedHome();
    seedFakeClaudeVersions(home, ['1.0.0', '1.1.0']);
    const { stdout, status } = run(['sync', '--agent', 'claude', '--dry-run', '--json'], home);
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(stdout.trim());
    } catch {
      throw new Error(`stdout was not valid JSON:\n${stdout}\nstderr:\n${(run(['sync', '--agent', 'claude', '--dry-run', '--json'], home)).stderr}`);
    }
    expect(parsed.mode).toBe('dry-run');
    expect(parsed.agent).toBe('claude');
    expect(Array.isArray(parsed.versions)).toBe(true);
    expect((parsed.versions as string[]).sort()).toEqual(['1.0.0', '1.1.0']);
  });
});


describe('agents sync retired per-resource verbs', () => {
  it('agents hooks sync returns commander unknown-command error', () => {
    const home = guardedHome();
    const { stderr, status } = run(['hooks', 'sync'], home);
    expect(status).not.toBe(0);
    expect(stderr).toMatch(/unknown command|error.*unknown/i);
  });

  it('agents skills sync returns commander unknown-command error', () => {
    const home = guardedHome();
    const { stderr, status } = run(['skills', 'sync'], home);
    expect(status).not.toBe(0);
    expect(stderr).toMatch(/unknown command|error.*unknown/i);
  });

  it('agents commands sync returns commander unknown-command error', () => {
    const home = guardedHome();
    const { stderr, status } = run(['commands', 'sync'], home);
    expect(status).not.toBe(0);
    expect(stderr).toMatch(/unknown command|error.*unknown/i);
  });
});


describe('agents sync --json (RUSH-2216 fleet fan-out)', () => {
  it('commander registers --json (no unknown option on parse)', () => {
    const program = new Command();
    program.exitOverride();
    registerSyncCommand(program);
    const sync = program.commands.find((c) => c.name() === 'sync');
    expect(sync).toBeDefined();
    const longs = (sync!.options ?? []).map((o) => o.long);
    expect(longs).toContain('--json');
    const probe = new Command('sync').exitOverride();
    for (const o of sync!.options) {
      if (o.flags) probe.option(o.flags, o.description ?? '');
    }
    expect(() => probe.parse(['--json', '--local', '--yes'], { from: 'user' })).not.toThrow();
    expect(probe.opts().json).toBe(true);
  });

  it('registers --prune-clis (off by default; opt-in for the destructive purge)', () => {
    const program = new Command();
    program.exitOverride();
    registerSyncCommand(program);
    const sync = program.commands.find((c) => c.name() === 'sync');
    const pruneOpt = (sync!.options ?? []).find((o) => o.long === '--prune-clis');
    expect(pruneOpt).toBeDefined();
    expect(pruneOpt!.defaultValue).toBe(false);
    const probe = new Command('sync').exitOverride();
    for (const o of sync!.options) if (o.flags) probe.option(o.flags, o.description ?? '');
    probe.parse(['--prune-clis'], { from: 'user' });
    expect(probe.opts().pruneClis).toBe(true);
  });

  it('umbrella --json --local emits parseable JSON (not "unknown option")', () => {
    const home = guardedHome();
    const { stdout, stderr, status } = run(['sync', '--json', '--local', '--yes'], home);

    expect(stderr).not.toMatch(/unknown option ['"]--json['"]/);
    expect(stdout.trim().length).toBeGreaterThan(0);
    // Fleet parses all stdout as one JSON object, so any human chatter is a protocol failure.
    expect(stdout).not.toMatch(/Synced:/);
    expect(stdout).not.toMatch(/Registered \d+ hook/);
    expect(stdout).not.toMatch(/Declared CLIs missing/);

    const parsed = JSON.parse(stdout.trim());
    expect(parsed.ok).toBe(true);
    expect(parsed.mode).toBe('umbrella');
    expect(parsed.plan).toEqual({
      fetchRepos: false,
      fetchSecrets: false,
      reconcile: true,
    });
    expect(parsed.reconciled).toBe(true);
    expect(parsed.repair).toBeTruthy();
    expect(parsed.repair.staleInstallPurge).toBeNull();
    expect(status === 0 || status === 1).toBe(true);
  });

  it('bare --json (the exact fleet-forwarded argv shape) is accepted', () => {
    const home = guardedHome();
    const { stdout, stderr } = run(['sync', '--json'], home);
    expect(stderr).not.toMatch(/unknown option ['"]--json['"]/);
    expect(stdout).not.toMatch(/Synced:/);
    expect(stdout).not.toMatch(/Registered \d+ hook/);
    const parsed = JSON.parse(stdout.trim());
    expect(parsed.mode).toBe('umbrella');
    expect(typeof parsed.ok).toBe('boolean');
  });
});

describe('sync --json reports a refused write (RUSH-2700)', () => {
  function homeWithRefusableMcp(): string {
    const home = guardedHome();
    const mcpDir = path.join(home, '.agents', 'mcp');
    fs.mkdirSync(mcpDir, { recursive: true });
    fs.writeFileSync(
      path.join(mcpDir, 'github.yaml'),
      ['name: github', 'transport: stdio', 'command: npx', 'args: ["-y", "srv"]', ''].join('\n'),
      'utf-8',
    );
    const versionDir = path.join(home, '.agents', '.history', 'versions', 'copilot', '1.0.0');
    fs.mkdirSync(path.join(versionDir, 'home'), { recursive: true });
    const binDir = path.join(versionDir, 'node_modules', '.bin');
    fs.mkdirSync(binDir, { recursive: true });
    fs.writeFileSync(path.join(binDir, 'copilot'), '#!/bin/sh\necho copilot\n', 'utf-8');
    fs.chmodSync(path.join(binDir, 'copilot'), 0o755);
    return home;
  }

  it('agent-all: ok is false and every version carries its decline', () => {
    const home = homeWithRefusableMcp();
    const { stdout } = run(['sync', 'copilot@all', '--json', '--yes'], home);
    const payload = JSON.parse(stdout.trim());

    expect(payload.mode).toBe('agent-all');
    expect(payload.ok, 'a refused write is not a clean sync').toBe(false);
    const declined = payload.versions.flatMap((v: { declined?: string[] }) => v.declined ?? []);
    expect(declined.join('\n')).toContain('cannot write MCP config');
    expect(declined.join('\n')).toContain('copilot');
  });

  it('umbrella: declined propagates through refresh and stdout stays one JSON object', () => {
    // Refresh skips agents without a global default; pin Copilot first so this reaches the refusal.
    const home = homeWithRefusableMcp();
    const use = spawnSync('bun', [INDEX, 'use', 'copilot@1.0.0'], {
      encoding: 'utf-8',
      env: { ...process.env, HOME: home, AGENTS_NO_UPDATE_CHECK: '1' },
    });
    expect(use.status, use.stderr).toBe(0);

    const { stdout } = run(['sync', '--local', '--json', '--yes'], home);

    const payload = JSON.parse(stdout.trim());
    expect(payload.mode).toBe('umbrella');
    expect(payload.ok, 'a refused write is not a clean umbrella sync').toBe(false);
    expect((payload.declined ?? []).join('\n')).toContain('cannot write MCP config');
  });

  it('agent-all: ok stays true when nothing was refused', () => {
    // Kimi is the negative control because Droid uses a global binary, not a per-version layout.
    const home = homeWithRefusableMcp();
    const versionDir = path.join(home, '.agents', '.history', 'versions', 'kimi', '1.0.0');
    fs.mkdirSync(path.join(versionDir, 'home'), { recursive: true });
    const binDir = path.join(versionDir, 'node_modules', '.bin');
    fs.mkdirSync(binDir, { recursive: true });
    fs.writeFileSync(path.join(binDir, 'kimi'), '#!/bin/sh\necho kimi\n', 'utf-8');
    fs.chmodSync(path.join(binDir, 'kimi'), 0o755);

    const { stdout } = run(['sync', 'kimi@all', '--json', '--yes'], home);
    const payload = JSON.parse(stdout.trim());
    expect(payload.mode).toBe('agent-all');
    expect(payload.ok).toBe(true);
    expect(payload.versions.flatMap((v: { declined?: string[] }) => v.declined ?? [])).toEqual([]);
  });
});


describe('agents sync user — adopt-in-place self-heal (PHNX-3301)', () => {
  const FULL_YAML = [
    '# agents-cli metadata',
    'hooks:',
    '  SessionStart:',
    '    - startup',
    'config:',
    '  interactiveHost: zion',
    'fleet:',
    '  devices: {}',
    '',
  ].join('\n');

  function git(cwd: string, ...args: string[]): void {
    execFileSync('git', args, {
      cwd,
      encoding: 'utf-8',
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@e.c',
        GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@e.c',
        GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null',
      },
    });
  }

  it('git-backs a non-git ~/.agents against its origin, materializing resources and preserving runtime state', () => {
    const home = guardedHome();
    const userDir = path.join(home, '.agents');
    const remote = path.join(home, 'origin.git');
    const author = path.join(home, 'author');

    execFileSync('git', ['init', '--bare', '-b', 'main', remote]);
    execFileSync('git', ['clone', remote, author]);
    fs.writeFileSync(path.join(author, '.gitattributes'), '* -text\n');
    fs.writeFileSync(path.join(author, '.gitignore'), '.cache/\nscratch/\n');
    fs.writeFileSync(path.join(author, 'agents.yaml'), FULL_YAML);
    fs.mkdirSync(path.join(author, 'skills'), { recursive: true });
    fs.writeFileSync(path.join(author, 'skills', 'x.md'), 'skill\n');
    git(author, 'add', '-A');
    git(author, 'commit', '-m', 'seed');
    git(author, 'push', 'origin', 'main');

    fs.mkdirSync(path.join(userDir, '.cache'), { recursive: true });
    fs.writeFileSync(path.join(userDir, '.cache', 'x'), 'runtime\n');
    fs.writeFileSync(path.join(userDir, 'agents.yaml'), 'hooks:\nfleet: {}\n');
    expect(fs.existsSync(path.join(userDir, '.git'))).toBe(false);

    const r = spawnSync('bun', [INDEX, 'sync', 'user', '--json'], {
      encoding: 'utf-8',
      env: {
        ...process.env,
        HOME: home,
        AGENTS_NO_UPDATE_CHECK: '1',
        AGENTS_SECRETS_PASSPHRASE: '',
        AGENTS_USER_REPO_URL: remote,
      },
    });
    const payload = JSON.parse((r.stdout ?? '').trim());

    expect(payload.ok).toBe(true);
    expect(payload.mode).toBe('repo-git');
    expect(payload.repo).toBe('user');

    expect(fs.existsSync(path.join(userDir, '.git'))).toBe(true);
    expect(fs.readFileSync(path.join(userDir, 'skills', 'x.md'), 'utf8')).toBe('skill\n');
    expect(fs.readFileSync(path.join(userDir, '.cache', 'x'), 'utf8')).toBe('runtime\n');
    expect(fs.readFileSync(path.join(userDir, 'agents.yaml'), 'utf8')).toBe(FULL_YAML);

    const rec = JSON.parse(fs.readFileSync(path.join(userDir, '.history', 'user-repo-remote.json'), 'utf8'));
    expect(rec.url).toBe(remote);

    const count = execFileSync('git', ['--git-dir', remote, 'rev-list', '--count', 'main'], { encoding: 'utf-8' }).trim();
    expect(count).toBe('1');
  });
});



function hookEnv(home: string): Record<string, string> {
  return {
    HOME: home,
    AGENTS_NO_UPDATE_CHECK: '1',
    AGENTS_NO_AUTOPULL: '1',
    AGENTS_SECRETS_PASSPHRASE: '',
    AGENTS_HOOK_SHIMS_DIR: path.join(home, 'hook-shims'),
    AGENTS_HOOK_CACHE_DIR: path.join(home, 'hook-cache'),
    AGENTS_LOGS_DIR: path.join(home, 'logs'),
    AGENTS_PERF_DIR: path.join(home, 'perf'),
  };
}

function runHooked(args: string[], home: string): { stdout: string; stderr: string; status: number | null } {
  const r = spawnSync('bun', [INDEX, ...args], {
    encoding: 'utf-8',
    env: { ...process.env, ...hookEnv(home) },
  });
  return { stdout: r.stdout ?? '', stderr: r.stderr ?? '', status: r.status };
}

function seedHookVersion(): { home: string; shim: string } {
  const home = guardedHome();
  seedFakeClaudeVersions(home, ['2.0.0']);
  const userDir = path.join(home, '.agents');
  const systemDir = path.join(userDir, '.system');
  fs.writeFileSync(path.join(userDir, 'agents.yaml'), 'agents:\n  claude: "2.0.0"\n');
  fs.writeFileSync(
    path.join(systemDir, 'agents.yaml'),
    'hooks:\n  runtime-guard:\n    script: runtime-guard.sh\n    events: [PreToolUse]\n    matcher: Bash\n',
  );
  fs.mkdirSync(path.join(userDir, 'commands'), { recursive: true });
  fs.writeFileSync(path.join(userDir, 'commands', 'foo.md'), 'FOO\n');
  const hooksHome = path.join(userDir, '.history', 'versions', 'claude', '2.0.0', 'home', '.claude', 'hooks');
  fs.mkdirSync(hooksHome, { recursive: true });
  fs.writeFileSync(path.join(hooksHome, 'runtime-guard.sh'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  return { home, shim: path.join(home, 'hook-shims', 'runtime-guard.sh') };
}

describe('agents sync repairs a broken hook shim through the real command (TEST GAP + BLOCKER 3)', () => {
  it('--json <agent>@<version>: repairs the missing shim and folds a repair payload into JSON', () => {
    const { home, shim } = seedHookVersion();
    expect(fs.existsSync(shim)).toBe(false);

    const r = runHooked(['sync', 'claude@2.0.0', '--json'], home);
    expect(r.status, r.stderr).toBe(0);
    const payload = JSON.parse(r.stdout.trim().split('\n').filter(Boolean).pop() as string);

    expect(payload.repair).toBeTruthy();
    expect(payload.repair.hadFailures).toBe(false);
    expect(payload.ok).toBe(true);
    expect(fs.existsSync(shim)).toBe(true);
  });
});

describe('bare interactive `agents sync <agent>@<version>` repairs a broken shim on an in-sync version (BLOCKER 2)', () => {
  it('the interactive "already in sync" path still runs the repair pass', async () => {
    const { home, shim } = seedHookVersion();

    const first = runHooked(['sync', 'claude@2.0.0', '--yes'], home);
    expect(first.status, first.stderr).toBe(0);
    expect(fs.existsSync(shim)).toBe(true);

    fs.rmSync(shim);

    await new Promise<void>((resolve, reject) => {
      const child = ptySpawn('bun', [INDEX, 'sync', 'claude@2.0.0'], {
        cols: 100, rows: 30, cwd: process.cwd(),
        env: { ...process.env, ...hookEnv(home), TERM: 'xterm-256color' } as Record<string, string>,
      });
      const timer = setTimeout(() => { child.kill(); reject(new Error('interactive sync did not exit')); }, 30_000);
      child.onExit(() => { clearTimeout(timer); resolve(); });
    });

    expect(fs.existsSync(shim)).toBe(true);
  });
});


function fingerprint(dir: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, e.name);
      const rel = path.relative(dir, full);
      if (e.isSymbolicLink()) {
        out.set(rel, 'link:' + fs.readlinkSync(full));
      } else if (e.isDirectory()) {
        out.set(rel + '/', 'dir');
        walk(full);
      } else {
        out.set(rel, crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex'));
      }
    }
  };
  if (fs.existsSync(dir)) walk(dir);
  return out;
}

function fpDiff(before: Map<string, string>, after: Map<string, string>): string[] {
  const changes: string[] = [];
  for (const [k, v] of after) {
    if (!before.has(k)) changes.push(`+ ${k}`);
    else if (before.get(k) !== v) changes.push(`~ ${k}`);
  }
  for (const k of before.keys()) if (!after.has(k)) changes.push(`- ${k}`);
  return changes.sort();
}

describe('agents sync --dry-run on the umbrella verb (PHNX-3923)', () => {
  function seedDefaultedVersion(): { home: string; shim: string; versionsDir: string } {
    const { home, shim } = seedHookVersion();
    const use = spawnSync('bun', [INDEX, 'use', 'claude@2.0.0'], {
      encoding: 'utf-8',
      env: { ...process.env, ...hookEnv(home) },
    });
    expect(use.status, use.stderr).toBe(0);
    const versionsDir = path.join(home, '.agents', '.history', 'versions');
    return { home, shim, versionsDir };
  }

  it('CONTROL: a real umbrella sync (no --dry-run) DOES mutate the version home', () => {
    const { home, shim, versionsDir } = seedDefaultedVersion();
    const before = fingerprint(versionsDir);

    const r = runHooked(['sync', '--local', '--json', '--yes'], home);
    const payload = JSON.parse(r.stdout.trim());
    expect(payload.mode).toBe('umbrella');
    expect(payload.reconciled).toBe(true);

    const after = fingerprint(versionsDir);
    expect(fpDiff(before, after).length, 'a real sync must change the version home').toBeGreaterThan(0);
    expect(fs.existsSync(shim), 'a real sync generates the hook runtime shim').toBe(true);
  });

  it('--local: refuses, exits non-zero, and mutates NOTHING (the PHNX-3923 bug)', () => {
    const { home, shim } = seedDefaultedVersion();
    const agentsTree = path.join(home, '.agents');
    const before = fingerprint(agentsTree);

    const r = runHooked(['sync', '--local', '--json', '--dry-run', '--yes'], home);

    const payload = JSON.parse(r.stdout.trim());
    expect(payload).toMatchObject({ ok: false, mode: 'umbrella', dryRun: true });
    expect(payload.error).toContain('umbrella');
    expect(payload.hint).toContain('agents sync');
    expect(payload.hint).toContain('--dry-run');
    expect(payload.installedAgents, 'the installed agent is named for the pointer').toContain('claude');
    expect(r.status, 'a refusal is a non-zero exit').not.toBe(0);

    const after = fingerprint(agentsTree);
    expect(fpDiff(before, after), 'dry-run must not write to any native home').toEqual([]);
    expect(fs.existsSync(shim), 'dry-run must not generate the hook shim').toBe(false);
  });

  it('default (non-local) path: also refuses before any repo pull, mutating NOTHING', () => {
    const { home, shim } = seedDefaultedVersion();
    const agentsTree = path.join(home, '.agents');
    const before = fingerprint(agentsTree);

    const r = runHooked(['sync', '--json', '--dry-run', '--yes'], home);
    const payload = JSON.parse(r.stdout.trim());
    expect(payload).toMatchObject({ ok: false, mode: 'umbrella', dryRun: true });
    expect(r.status).not.toBe(0);

    const after = fingerprint(agentsTree);
    expect(fpDiff(before, after)).toEqual([]);
    expect(fs.existsSync(shim)).toBe(false);
  });

  it('human (non-JSON) path: prints the error + scoped hint to stderr, no mutation', () => {
    const { home, shim } = seedDefaultedVersion();
    const agentsTree = path.join(home, '.agents');
    const before = fingerprint(agentsTree);

    const r = runHooked(['sync', '--local', '--dry-run', '--yes'], home);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('agents sync claude --dry-run');
    expect(fpDiff(before, fingerprint(agentsTree))).toEqual([]);
    expect(fs.existsSync(shim)).toBe(false);
  });

  it('the scoped preview it points at is real and non-destructive (agents sync claude --dry-run)', () => {
    const { home, versionsDir } = seedDefaultedVersion();
    const before = fingerprint(versionsDir);

    const r = runHooked(['sync', 'claude', '--dry-run', '--json', '--yes'], home);
    const payload = JSON.parse(r.stdout.trim());
    expect(payload.mode).toBe('dry-run');
    expect(payload.ok).toBe(true);
    expect(fpDiff(before, fingerprint(versionsDir)), 'scoped dry-run writes nothing').toEqual([]);
  });
});
