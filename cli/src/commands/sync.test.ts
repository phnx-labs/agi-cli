/**
 * RUSH-2216: `agents sync --device all` fans out with an injected `--json` flag
 * (see lib/hosts/passthrough.ts `buildFleetForwardedArgs`). Remotes that do not
 * accept `--json` fail every peer with `error: unknown option '--json'`.
 *
 * These tests drive the real command tree (no mocks): commander must accept
 * the flag, and the umbrella path must emit parseable JSON on stdout so the
 * fleet roster's `safeJsonParse` succeeds.
 */
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

/** Temp HOME with update-check probes silenced so the CLI stays offline. */
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
      // No interactive pickers, no secrets passphrase required for --local.
      AGENTS_SECRETS_PASSPHRASE: '',
    },
  });
  return {
    stdout: r.stdout ?? '',
    stderr: r.stderr ?? '',
    status: r.status,
  };
}

// ---------------------------------------------------------------------------
// Helpers shared across per-kind flag tests
// ---------------------------------------------------------------------------

/**
 * Build a disposable commander probe with the real kind-selector options
 * (including their kindCollector argParser). Parsing flags against this probe
 * never fires the sync action — it only exercises flag registration and
 * option collection.
 *
 * Uses addSelectorOptions directly so kindCollector is wired up identically
 * to the real sync command, ensuring array-accumulation and comma-split
 * assertions match production behaviour.
 */
function buildSyncProbe(): Command {
  const probe = new Command('sync').exitOverride();
  addSelectorOptions(probe);
  return probe;
}

// ---------------------------------------------------------------------------
// Per-kind selector flags — commander registration and option parsing
// ---------------------------------------------------------------------------

describe('agents sync per-kind selector flags', () => {
  it('all per-kind flags are registered on the sync command', () => {
    const program = new Command();
    program.exitOverride();
    registerSyncCommand(program);
    const sync = program.commands.find((c) => c.name() === 'sync')!;
    const longs = (sync!.options ?? []).map((o) => o.long);
    // Every kind pair (singular + plural alias)
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
    // kindCollector normalises both into an array via the same argParser
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
    // --rule is a bare flag (no required value); truthy when present
    expect(probe.opts().rule).toBeTruthy();
  });

  it('--memory is registered as a boolean flag aliasing the rule kind', () => {
    const probe = buildSyncProbe();
    probe.parse(['--memory'], { from: 'user' });
    expect(probe.opts().memory).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Auto-promotion: bare `agents sync --agent claude` with multiple versions
// ---------------------------------------------------------------------------

/** Populate a test home with N fake claude version dirs that pass isVersionInstalled. */
function seedFakeClaudeVersions(home: string, versions: string[]): void {
  for (const ver of versions) {
    // getPackageBinaryPath reads package.json → bin field then checks the file
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
    // The binary only needs to exist as a file; we never launch it in tests.
    fs.writeFileSync(path.join(binDir, 'claude'), '#!/bin/sh\n');
    fs.chmodSync(path.join(binDir, 'claude'), 0o755);
  }
}

describe('agents sync auto-promotion to @all', () => {
  it('targets all versions when multiple are installed and no default is pinned', () => {
    const home = guardedHome();
    seedFakeClaudeVersions(home, ['1.0.0', '1.1.0']);
    // --dry-run avoids actually writing to the fake version homes;
    // --json guarantees machine-readable output we can parse.
    const { stdout, status } = run(['sync', '--agent', 'claude', '--dry-run', '--json'], home);
    // Old code: exits with { mode: 'agent', error: 'No default Claude version pinned.' }
    // New code: auto-promotes to @all → { mode: 'dry-run', versions: ['1.0.0', '1.1.0'] }
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

// ---------------------------------------------------------------------------
// Retired per-resource sync verbs (agents/retire branch)
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Original RUSH-2216 fleet fan-out tests
// ---------------------------------------------------------------------------

describe('agents sync --json (RUSH-2216 fleet fan-out)', () => {
  it('commander registers --json (no unknown option on parse)', () => {
    // Unit-level guard: the option must be registered on the sync command so a
    // peer that receives the fleet-injected flag does not exit with
    // "unknown option '--json'". Check the option table without firing the
    // action (which would start a real umbrella sync).
    const program = new Command();
    program.exitOverride();
    registerSyncCommand(program);
    const sync = program.commands.find((c) => c.name() === 'sync');
    expect(sync).toBeDefined();
    const longs = (sync!.options ?? []).map((o) => o.long);
    expect(longs).toContain('--json');
    // Commander throws CommanderError on unknown options under exitOverride.
    // Parse flags only via a disposable clone that has no action side effects.
    const probe = new Command('sync').exitOverride();
    for (const o of sync!.options) {
      // Re-declare the same flags so unknown-option checking matches production.
      if (o.flags) probe.option(o.flags, o.description ?? '');
    }
    expect(() => probe.parse(['--json', '--local', '--yes'], { from: 'user' })).not.toThrow();
    expect(probe.opts().json).toBe(true);
  });

  it('registers --prune-clis (off by default; opt-in for the destructive purge)', () => {
    // The purge never runs on a routine sync — it is gated entirely behind this
    // explicit flag. Guard that the flag exists, defaults false, and parses true.
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
    // Real path: the fleet fan-out runs exactly `agents sync --json` on each
    // peer. --local keeps the test offline (no git pull of config repos).
    const home = guardedHome();
    const { stdout, stderr, status } = run(['sync', '--json', '--local', '--yes'], home);

    // The regression this catches: before the fix, commander rejected the flag
    // with status 1 and "unknown option '--json'" on stderr, and empty/non-JSON
    // stdout — which is what every remote showed under `agents sync --device all`.
    expect(stderr).not.toMatch(/unknown option ['"]--json['"]/);
    expect(stdout.trim().length).toBeGreaterThan(0);
    // Must not leak human reconcile chatter — fleet parses the entire stdout
    // (safeJsonParse), not the last line.
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
    // The destructive stale-CLI purge must NOT run on a routine sync — the repair
    // pass ran (drift-fixers) but its purge slot is null without --prune-clis.
    expect(parsed.repair).toBeTruthy();
    expect(parsed.repair.staleInstallPurge).toBeNull();
    // Exit may be 0 even with no agents installed — reconcile is a soft pass.
    expect(status === 0 || status === 1).toBe(true);
  });

  it('bare --json (the exact fleet-forwarded argv shape) is accepted', () => {
    // buildFleetForwardedArgs strips routing flags and appends --json, so the
    // remote argv is exactly `agents sync --json`. Mirror that here.
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

/**
 * RUSH-2700: a resource agents-cli REFUSES to write must not read as a clean
 * sync on the machine surfaces. `agentSyncJson` (mode 'agent') carried
 * `declined` from RUSH-2677, but `agent-all` and the umbrella payload still
 * hardcoded `ok: true` and omitted the field — so `agents sync --yes` and the
 * `--device all` fan-out reported success for a write that never happened.
 *
 * Drives the real command against a temp HOME holding one user-scope MCP server
 * and an installed copilot, whose MCP config format is deliberately
 * unimplemented (see MCP_TARGETS `format: null`). No mocks.
 */
describe('sync --json reports a refused write (RUSH-2700)', () => {
  /** A HOME with one MCP server and a probeable copilot install. */
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
    // The bug: this was hardcoded true regardless of what was written.
    expect(payload.ok, 'a refused write is not a clean sync').toBe(false);
    const declined = payload.versions.flatMap((v: { declined?: string[] }) => v.declined ?? []);
    expect(declined.join('\n')).toContain('cannot write MCP config');
    expect(declined.join('\n')).toContain('copilot');
  });

  it('umbrella: declined propagates through refresh and stdout stays one JSON object', () => {
    // The other half of the fix, and the one with no run evidence until now:
    // refresh() returned void, so runUmbrellaSync could not report a decline
    // even in principle. refresh only reaches an agent that has a global
    // default set, which is why `use` runs first — without it refresh
    // `continue`s past copilot and nothing is ever declined.
    const home = homeWithRefusableMcp();
    const use = spawnSync('bun', [INDEX, 'use', 'copilot@1.0.0'], {
      encoding: 'utf-8',
      env: { ...process.env, HOME: home, AGENTS_NO_UPDATE_CHECK: '1' },
    });
    expect(use.status, use.stderr).toBe(0);

    const { stdout } = run(['sync', '--local', '--json', '--yes'], home);

    // Exactly one JSON object on stdout: the fleet roster's parser breaks on a
    // stray line, and this file exists because of a prior incident (see header).
    const payload = JSON.parse(stdout.trim());
    expect(payload.mode).toBe('umbrella');
    expect(payload.ok, 'a refused write is not a clean umbrella sync').toBe(false);
    expect((payload.declined ?? []).join('\n')).toContain('cannot write MCP config');
  });

  it('agent-all: ok stays true when nothing was refused', () => {
    // The negative control. kimi's MCP format IS implemented, so the very same
    // server writes cleanly — proving `ok: false` above tracks the decline and
    // not merely "this command ran". kimi (not droid) because droid resolves to
    // one global binary, so a per-version layout is not a valid install.
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

// ---------------------------------------------------------------------------
// PHNX-3301: `agents sync user` adopt-in-place self-heal — the real command
// against a real bare origin and a non-git ~/.agents (no mocks). Exercises the
// entry point (not just the library fn), so the runRepoGitSync wiring — remote
// recording, the --json path, the adopt→sync handoff — is covered end to end.
// ---------------------------------------------------------------------------

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

    // Bare origin seeded on main with a full agents.yaml + a skill.
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

    // Partial box: runtime state + a stub agents.yaml, and NO .git.
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

    // The command succeeded via the git-sync path.
    expect(payload.ok).toBe(true);
    expect(payload.mode).toBe('repo-git');
    expect(payload.repo).toBe('user');

    // Tracking restored + resources materialized, runtime preserved.
    expect(fs.existsSync(path.join(userDir, '.git'))).toBe(true);
    expect(fs.readFileSync(path.join(userDir, 'skills', 'x.md'), 'utf8')).toBe('skill\n');
    expect(fs.readFileSync(path.join(userDir, '.cache', 'x'), 'utf8')).toBe('runtime\n');
    // Stale-stub agents.yaml reconciled from origin.
    expect(fs.readFileSync(path.join(userDir, 'agents.yaml'), 'utf8')).toBe(FULL_YAML);

    // The remote is recorded for a future heal EVEN on the --json path (the
    // record block must run before the --json early return).
    const rec = JSON.parse(fs.readFileSync(path.join(userDir, '.history', 'user-repo-remote.json'), 'utf8'));
    expect(rec.url).toBe(remote);

    // No stray commit pushed to origin.
    const count = execFileSync('git', ['--git-dir', remote, 'rev-list', '--count', 'main'], { encoding: 'utf-8' }).trim();
    expect(count).toBe('1');
  });
});


// ---------------------------------------------------------------------------
// Post-reconcile repair runs THROUGH the real sync command (TEST GAP + BLOCKER 2/3)
// ---------------------------------------------------------------------------

/** Env that keeps generated hook shims + caches inside the fixture home. */
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

/** Install claude@2.0.0 with a managed hook whose generated runtime shim is
 *  absent, plus one source command so the version has real resources. */
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
  // A source command so a full sync has something to reconcile.
  fs.mkdirSync(path.join(userDir, 'commands'), { recursive: true });
  fs.writeFileSync(path.join(userDir, 'commands', 'foo.md'), 'FOO\n');
  // The hook script lives in the version home; the generated shim does NOT exist.
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

    // BLOCKER 3: the repair report is now in the JSON and folded into `ok`.
    expect(payload.repair).toBeTruthy();
    expect(payload.repair.hadFailures).toBe(false);
    expect(payload.ok).toBe(true);
    // TEST GAP: the shim the sync's own file-copy never generates is now present.
    expect(fs.existsSync(shim)).toBe(true);
  });
});

describe('bare interactive `agents sync <agent>@<version>` repairs a broken shim on an in-sync version (BLOCKER 2)', () => {
  it('the interactive "already in sync" path still runs the repair pass', async () => {
    const { home, shim } = seedHookVersion();

    // 1. Establish the in-sync state (a full non-interactive sync also creates the shim).
    const first = runHooked(['sync', 'claude@2.0.0', '--yes'], home);
    expect(first.status, first.stderr).toBe(0);
    expect(fs.existsSync(shim)).toBe(true);

    // 2. Break the shim. Resources stay in sync, so the interactive run takes the
    //    "already in sync" early-return branch — the one that used to skip repair.
    fs.rmSync(shim);

    // 3. Bare interactive sync over a REAL tty (node-pty). No prompt fires on the
    //    in-sync branch, so it runs to exit on its own.
    await new Promise<void>((resolve, reject) => {
      const child = ptySpawn('bun', [INDEX, 'sync', 'claude@2.0.0'], {
        cols: 100, rows: 30, cwd: process.cwd(),
        env: { ...process.env, ...hookEnv(home), TERM: 'xterm-256color' } as Record<string, string>,
      });
      const timer = setTimeout(() => { child.kill(); reject(new Error('interactive sync did not exit')); }, 30_000);
      child.onExit(() => { clearTimeout(timer); resolve(); });
    });

    // The interactive early-return branch repaired the shim it would previously skip.
    expect(fs.existsSync(shim)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// PHNX-3923: the umbrella verb (bare `agents sync`) must REFUSE `--dry-run`
// before touching anything. Before this fix `runUmbrella` ignored `opts.dryRun`
// entirely — it ran the full reconcile + browser-profile eviction + repair, so
// `agents sync --dry-run --yes --local --json` MUTATED every installed version
// home despite the preview flag. The umbrella composes only mutating stages
// (repo pull, refresh reconcile, device sync, repairAfterSync) and has no
// non-mutating preview, so it now fails LOUD and points at the scoped path
// (`agents sync <agent> --dry-run`), which honors it. Real command, temp home,
// no mocks; a byte fingerprint of the native homes proves zero mutation.
// ---------------------------------------------------------------------------

/** Recursive content fingerprint: relpath → sha256 (files) / target (links) /
 *  'dir' (dirs). Two equal maps mean the subtree is byte-for-byte unchanged. */
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

/** Human-readable added/removed/changed set between two fingerprints. */
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
  /** claude@2.0.0 installed, set as the global default (so the umbrella
   *  reconcile actually reaches it), with a source command + managed hook whose
   *  runtime shim is not yet generated — i.e. a real, non-empty reconcile. */
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

    // The reconcile wrote resources into the home and generated the hook shim.
    const after = fingerprint(versionsDir);
    expect(fpDiff(before, after).length, 'a real sync must change the version home').toBeGreaterThan(0);
    expect(fs.existsSync(shim), 'a real sync generates the hook runtime shim').toBe(true);
  });

  it('--local: refuses, exits non-zero, and mutates NOTHING (the PHNX-3923 bug)', () => {
    const { home, shim } = seedDefaultedVersion();
    const agentsTree = path.join(home, '.agents');
    const before = fingerprint(agentsTree);

    const r = runHooked(['sync', '--local', '--json', '--dry-run', '--yes'], home);

    // Structured refusal on stdout — one JSON object, ok:false, umbrella/dryRun.
    const payload = JSON.parse(r.stdout.trim());
    expect(payload).toMatchObject({ ok: false, mode: 'umbrella', dryRun: true });
    expect(payload.error).toContain('umbrella');
    expect(payload.hint).toContain('agents sync');
    expect(payload.hint).toContain('--dry-run');
    expect(payload.installedAgents, 'the installed agent is named for the pointer').toContain('claude');
    expect(r.status, 'a refusal is a non-zero exit').not.toBe(0);

    // Zero mutation: the whole native-home tree is byte-identical, and none of
    // the reconcile/repair side effects (shim, evicted profiles) happened.
    const after = fingerprint(agentsTree);
    expect(fpDiff(before, after), 'dry-run must not write to any native home').toEqual([]);
    expect(fs.existsSync(shim), 'dry-run must not generate the hook shim').toBe(false);
  });

  it('default (non-local) path: also refuses before any repo pull, mutating NOTHING', () => {
    // The bare umbrella plan additionally fetches repos. The guard must fire
    // BEFORE that stage too — proven here by the absence of any fetch (offline
    // temp home, no remote) AND an unchanged tree.
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
    // The refusal is only honest if the alternative it names actually works and
    // writes nothing. Prove the pointer: the scoped dry-run previews and leaves
    // the version home untouched.
    const { home, versionsDir } = seedDefaultedVersion();
    const before = fingerprint(versionsDir);

    const r = runHooked(['sync', 'claude', '--dry-run', '--json', '--yes'], home);
    const payload = JSON.parse(r.stdout.trim());
    expect(payload.mode).toBe('dry-run');
    expect(payload.ok).toBe(true);
    expect(fpDiff(before, fingerprint(versionsDir)), 'scoped dry-run writes nothing').toEqual([]);
  });
});
