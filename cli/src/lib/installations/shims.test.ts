import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { generateShimScript, generateVersionedAliasScript, hasAliasShadowingShim, shimTargetsFor, onDiskShimFile, SHIM_SCHEMA_VERSION } from './shims.js';
import { getProjectVersion } from './versions.js';

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-shims-test-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('generateShimScript', () => {
  it('embeds the current schema version marker', () => {
    const script = generateShimScript('claude');
    expect(script).toContain(`agents-shim-version: ${SHIM_SCHEMA_VERSION}`);
  });

  it('sets CLAUDE_CONFIG_DIR for claude shim', () => {
    const script = generateShimScript('claude');
    expect(script).toContain('export CLAUDE_CONFIG_DIR=');
  });

  it('includes .oauth_token Linux fallback for claude shim', () => {
    const script = generateShimScript('claude');
    expect(script).toContain('.oauth_token');
    expect(script).toContain('uname -s');
    expect(script).toContain('CLAUDE_CODE_OAUTH_TOKEN');
  });

  it('does not include .oauth_token fallback for codex shim', () => {
    const script = generateShimScript('codex');
    expect(script).not.toContain('.oauth_token');
  });

  it('disables the Claude Code auto-updater in the claude shim, honoring an explicit value', () => {
    // Pinned per-version installs must not self-mutate. The `:-1` default lets a
    // user-set DISABLE_AUTOUPDATER win while defaulting to disabled otherwise.
    const script = generateShimScript('claude');
    expect(script).toContain('export DISABLE_AUTOUPDATER="${DISABLE_AUTOUPDATER:-1}"');
  });

  it('does not touch DISABLE_AUTOUPDATER for the codex shim (codex path unchanged)', () => {
    const script = generateShimScript('codex');
    expect(script).not.toContain('DISABLE_AUTOUPDATER');
    // codex keeps its own suppression flag, injected at exec.
    expect(script).toContain('check_for_update_on_startup=false');
    expect(script).toContain('default_permissions=\"agents-edit\"');
    expect(script).toContain('approval_policy=\"on-request\"');
  });

  it('resolves the repo .agents from $PWD at runtime and passes --add-dir (codex sandbox hardcodes .agents read-only)', () => {
    const script = generateShimScript('codex');
    // worktree-aware resolution mirroring repoAgentsDirForCwd, then --add-dir
    expect(script).toContain('*/.agents/worktrees/*)');
    expect(script).toContain('_repo_agents');
    expect(script).toContain('--add-dir "$_repo_agents"');
  });

  it('adds no --add-dir resolution to a non-codex shim', () => {
    const claude = generateShimScript('claude');
    expect(claude).not.toContain('--add-dir');
    expect(claude).not.toContain('_repo_agents');
  });
});

describe('generateVersionedAliasScript', () => {
  it('disables the Claude Code auto-updater in a claude@version alias, honoring an explicit value', () => {
    const script = generateVersionedAliasScript('claude', '2.1.196');
    expect(script).toContain('export DISABLE_AUTOUPDATER="${DISABLE_AUTOUPDATER:-1}"');
  });

  it('carries the Linux .oauth_token setup-token fallback in a claude@version alias (interactive auth on a keychain-less worker)', () => {
    // Regression: the alias env was a hand-copied subset of the main shim that had
    // dropped this fallback, so interactive Claude on a worker could not authenticate
    // from an attached setup-token. The alias now reuses claudeAdapter.shimConfigEnvBash.
    const script = generateVersionedAliasScript('claude', '2.1.196');
    expect(script).toContain('.oauth_token');
    expect(script).toContain('CLAUDE_CODE_OAUTH_TOKEN');
  });

  it('anchors every agents-owned path on the real home and takes the launch lease before any HOME swap', () => {
    // A slot launch (PHNX-3940 T5) hands the alias HOME=<slot dir> with the real
    // home in AGENTS_REAL_HOME. Anchoring on $HOME made `agents run cursor#gmail`
    // on a worker answer "cursor@main not installed", and — with cursor's own
    // HOME swap ahead of the lease call — `agents __launch-lease` fail with
    // "No installation directory for cursor@main" (yosemite-m0, 2026-09-07).
    const script = generateVersionedAliasScript('cursor', 'main');
    expect(script).toContain('export AGENTS_REAL_HOME="${AGENTS_REAL_HOME:-$HOME}"');
    expect(script).toContain('BINARY="$AGENTS_REAL_HOME/.agents/.history/versions/cursor/main/node_modules/.bin/cursor-agent"');
    expect(script).not.toMatch(/BINARY="\$HOME\//);
    // The lease runs under the real home, and before cursor's HOME swap.
    const lease = script.indexOf('HOME="$AGENTS_REAL_HOME" ');
    expect(lease).toBeGreaterThan(0);
    expect(script.slice(lease)).toMatch(/^HOME="\$AGENTS_REAL_HOME" '[^']+' __launch-lease "cursor" "main" "\$\$"/);
    const swap = script.indexOf('export HOME="$AGENTS_REAL_HOME/.agents/.history/versions/cursor/main/home"');
    expect(swap).toBeGreaterThan(lease);
    // The swap yields to a spawner that already chose HOME (the slot).
    expect(script).toContain('if [ "$HOME" = "$AGENTS_REAL_HOME" ]; then');
    expect(script).toContain('export AGENT_CLI_CREDENTIAL_STORE="file"');
  });

  it('yields the claude config-dir pin to an account-slot launch and consumes the marker', () => {
    // A slot launch (PHNX-3940 T5) pins CLAUDE_CONFIG_DIR to the slot in
    // buildExecEnv and stamps the slot in AGENTS_EXEC_HOME; the alias used to
    // re-export the version home unconditionally, so on yosemite-m1 (2026-09-10)
    // a run picked as one account onboarded from scratch and wrote its history
    // into the shared version home. The block below is the generated one, run for real.
    const script = generateVersionedAliasScript('claude', '2.1.196');
    const start = script.indexOf('# Claude stores OAuth credentials');
    const end = script.indexOf('# Managed installs are pinned', start);
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    const block = script.slice(start, end);
    const run = (env: Record<string, string>) => spawnSync('bash', ['-c', `VERSION_DIR=/v\n${block}\nprintf '%s|%s' "$CLAUDE_CONFIG_DIR" "\${AGENTS_EXEC_HOME:-unset}"`], {
      env: { PATH: process.env.PATH ?? '/usr/bin:/bin', ...env },
      encoding: 'utf-8',
    }).stdout;
    expect(run({ AGENTS_EXEC_HOME: '/slots/claude/acct-1' })).toBe('/slots/claude/acct-1/.claude|unset');
    expect(run({})).toBe('/v/home/.claude|unset');
  });

  it('yields every harness config-dir pin to an account-slot launch (bare shim and direct alias)', () => {
    // Same override existed for every harness whose shim pins a config-dir env.
    const cases: Array<[Parameters<typeof generateShimScript>[0], string, string[]]> = [
      ['grok', '0.2.91', ['GROK_HOME']],
      ['opencode', '1.18.4', ['OPENCODE_CONFIG_DIR']],
      ['kimi', '0.32.0', ['KIMI_CODE_HOME']],
      ['copilot', '0.0.1', ['COPILOT_HOME']],
      ['muse', '0.1.0', ['XDG_CONFIG_HOME', 'XDG_DATA_HOME']],
    ];
    for (const [agent, version, envs] of cases) {
      for (const script of [generateShimScript(agent), generateVersionedAliasScript(agent, version)]) {
        expect(script).toContain('if [ -n "${AGENTS_EXEC_HOME:-}" ]; then');
        for (const env of envs) expect(script).toContain(`export ${env}="$AGENTS_EXEC_HOME/`);
        expect(script).toContain('unset AGENTS_EXEC_HOME');
      }
    }
  });

  it('keeps the same real-home anchor and lease order for a claude@version alias', () => {
    const script = generateVersionedAliasScript('claude', '2.1.196');
    expect(script).toContain('BINARY="$AGENTS_REAL_HOME/.agents/.history/versions/claude/2.1.196/node_modules/.bin/claude"');
    expect(script).toContain('VERSION_DIR="$AGENTS_REAL_HOME/.agents/.history/versions/claude/2.1.196"');
    expect(script).toMatch(/HOME="\$AGENTS_REAL_HOME" '[^']+' __launch-lease "claude" "2.1.196"/);
  });

  it('does not touch DISABLE_AUTOUPDATER for a codex@version alias (codex path unchanged)', () => {
    const script = generateVersionedAliasScript('codex', '0.20.0');
    expect(script).not.toContain('DISABLE_AUTOUPDATER');
    expect(script).toContain('check_for_update_on_startup=false');
    expect(script).toContain('default_permissions=\"agents-edit\"');
  });

  it('execs normally for a valid project agents.yaml version', () => {
    const dir = makeTempDir();
    const home = path.join(dir, 'home');
    const project = path.join(dir, 'project');
    const fakeAgents = path.join(dir, 'agents');
    const versionDir = path.join(home, '.agents', '.history', 'versions', 'claude', '2.0.65');
    const binary = path.join(versionDir, 'node_modules', '.bin', 'claude');
    const logPath = path.join(dir, 'exec.log');

    fs.mkdirSync(project, { recursive: true });
    fs.mkdirSync(path.dirname(binary), { recursive: true });
    fs.writeFileSync(path.join(project, 'agents.yaml'), 'agents:\n  claude: "2.0.65"\n', 'utf-8');
    fs.writeFileSync(fakeAgents, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    fs.writeFileSync(binary, `#!/bin/sh\nprintf "ran:%s\\n" "$1" >> ${JSON.stringify(logPath)}\n`, { mode: 0o755 });

    const shimPath = path.join(dir, 'claude-shim');
    const shim = generateShimScript('claude').replace(/^AGENTS_BIN=.*$/m, `AGENTS_BIN=${JSON.stringify(fakeAgents)}`);
    fs.writeFileSync(shimPath, shim, { mode: 0o755 });

    const result = spawnSync('bash', [shimPath, 'ok'], {
      cwd: project,
      env: { ...process.env, HOME: home },
      encoding: 'utf-8',
    });

    expect(result.status, result.stderr).toBe(0);
    expect(fs.readFileSync(logPath, 'utf-8')).toContain('ran:ok');
  });

  it('rejects a project agents.yaml traversal version before exec', () => {
    const dir = makeTempDir();
    const home = path.join(dir, 'home');
    const project = path.join(dir, 'project');
    const fakeAgents = path.join(dir, 'agents');
    const logPath = path.join(dir, 'exec.log');

    fs.mkdirSync(project, { recursive: true });
    fs.writeFileSync(path.join(project, 'agents.yaml'), 'agents:\n  claude: "../../../tmp/pwn"\n', 'utf-8');
    fs.writeFileSync(fakeAgents, '#!/bin/sh\nexit 0\n', { mode: 0o755 });

    const shimPath = path.join(dir, 'claude-shim');
    const shim = generateShimScript('claude').replace(/^AGENTS_BIN=.*$/m, `AGENTS_BIN=${JSON.stringify(fakeAgents)}`);
    fs.writeFileSync(shimPath, shim, { mode: 0o755 });

    const result = spawnSync('bash', [shimPath], {
      cwd: project,
      env: { ...process.env, HOME: home },
      encoding: 'utf-8',
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('invalid version in agents.yaml for claude: ../../../tmp/pwn');
    expect(fs.existsSync(logPath)).toBe(false);
  });

  it('rejects traversal versions in getProjectVersion', () => {
    const dir = makeTempDir();
    fs.writeFileSync(path.join(dir, 'agents.yaml'), 'agents:\n  claude: "../../../tmp/pwn"\n', 'utf-8');

    expect(() => getProjectVersion('claude', dir)).toThrow(
      'Invalid version in agents.yaml for claude: ../../../tmp/pwn. Allowed: latest or [A-Za-z0-9._+-]{1,64}'
    );
  });
});

describe('grok binary resolution order', () => {
  // Grok ships a native binary (not an npm package). It lands in the versioned
  // home's .grok/downloads when the installer runs with GROK_HOME set (via the
  // shim, a correct `agents add grok`, or a grok self-update under the shim).
  // Both generated shims must check the versioned home FIRST, then fall back to
  // the global ~/.grok/downloads for pre-fix installs. The pre-fix bug checked
  // only the global dir, so a pinned grok that installed into the versioned home
  // failed with "grok@<version> not installed".

  it('checks the versioned home before the global ~/.grok/downloads in the dispatcher shim', () => {
    const script = generateShimScript('grok');
    const versionedIdx = script.indexOf('$VERSION_DIR/home/.grok/downloads');
    const globalIdx = script.indexOf('$HOME/.grok/downloads');
    expect(versionedIdx, 'versioned home path must be present').toBeGreaterThanOrEqual(0);
    expect(globalIdx, 'global fallback path must be present').toBeGreaterThanOrEqual(0);
    expect(versionedIdx, 'versioned home must be checked before the global dir').toBeLessThan(globalIdx);
  });

  it('checks the versioned home before the global ~/.grok/downloads in the versioned alias', () => {
    const script = generateVersionedAliasScript('grok', '0.2.91');
    const versionedIdx = script.indexOf('/home/.grok/downloads');
    // The global dir is under the REAL home (a slot launch swaps HOME).
    const globalIdx = script.indexOf('$AGENTS_REAL_HOME/.grok/downloads');
    expect(versionedIdx, 'versioned home path must be present').toBeGreaterThanOrEqual(0);
    expect(globalIdx, 'global fallback path must be present').toBeGreaterThanOrEqual(0);
    expect(versionedIdx, 'versioned home must be checked before the global dir').toBeLessThan(globalIdx);
    // The concrete version is interpolated into the versioned-home path.
    expect(script).toContain('/versions/grok/0.2.91/home/.grok/downloads');
  });

  it('routes both the versioned home and the global fallback through the validated resolver (RUSH-2459)', () => {
    // Same fix as the dispatcher shim: no more "ls | head -1" — both branches
    // must call the shared, size-and-mtime-validated `_resolve_grok_binary`
    // so a stray non-binary artifact can never win by sorting first.
    const script = generateVersionedAliasScript('grok', '0.2.91');
    // The function is defined exactly once (not duplicated per call site) and
    // called from both the versioned-home and global-fallback branches.
    expect(script.match(/_resolve_grok_binary\(\) \{/g) ?? []).toHaveLength(1);
    const calls = script.match(/_resolve_grok_binary "\$GROK[A-Z_]*DOWNLOADS"/g) ?? [];
    expect(calls).toHaveLength(2);
    // Old bug: an un-validated "ls grok-* | grep -i <version> | head -1" (plus
    // a blind "| head -1" fallback) duplicated per call site. Neither survives
    // — the shared resolver matches filenames via a `case` glob, never `head`.
    expect(script).not.toContain('| head -1');
  });

  it('dispatcher execs the grok binary from the versioned home when the global dir is empty', () => {
    // This is the exact bug from #830: binary in the versioned home, global
    // ~/.grok/downloads empty. Pre-fix the dispatcher checked only the global
    // dir and died "not installed"; post-fix it resolves the versioned home.
    const dir = makeTempDir();
    const home = path.join(dir, 'home');
    const project = path.join(dir, 'project');
    const fakeAgents = path.join(dir, 'agents');
    const logPath = path.join(dir, 'exec.log');
    const version = '0.2.91';

    // Versioned home downloads dir holds the real binary; global stays empty.
    const versionedDownloads = path.join(
      home, '.agents', '.history', 'versions', 'grok', version, 'home', '.grok', 'downloads',
    );
    fs.mkdirSync(versionedDownloads, { recursive: true });
    fs.mkdirSync(path.join(home, '.grok', 'downloads'), { recursive: true }); // empty global
    const binary = path.join(versionedDownloads, `grok-${version}-macos-aarch64`);
    fs.writeFileSync(binary, `#!/bin/sh\nprintf "ran:%s\\n" "$1" >> ${JSON.stringify(logPath)}\n`, { mode: 0o755 });

    fs.mkdirSync(project, { recursive: true });
    fs.writeFileSync(path.join(project, 'agents.yaml'), `agents:\n  grok: "${version}"\n`, 'utf-8');
    // Fake agents-cli entrypoint: swallows the `sync --launch` hot-path call.
    fs.writeFileSync(fakeAgents, '#!/bin/sh\nexit 0\n', { mode: 0o755 });

    const shimPath = path.join(dir, 'grok-shim');
    const shim = generateShimScript('grok').replace(/^AGENTS_BIN=.*$/m, `AGENTS_BIN=${JSON.stringify(fakeAgents)}`);
    fs.writeFileSync(shimPath, shim, { mode: 0o755 });

    const result = spawnSync('bash', [shimPath, 'ok'], {
      cwd: project,
      env: { ...process.env, HOME: home },
      encoding: 'utf-8',
    });

    expect(result.status, result.stderr).toBe(0);
    expect(fs.readFileSync(logPath, 'utf-8')).toContain('ran:ok');
  });

  it('dispatcher falls back to the global ~/.grok/downloads when the versioned home is empty', () => {
    // Pre-fix installs left the binary in the global dir. The fallback must
    // still find it so existing grok users are not broken by this change.
    const dir = makeTempDir();
    const home = path.join(dir, 'home');
    const project = path.join(dir, 'project');
    const fakeAgents = path.join(dir, 'agents');
    const logPath = path.join(dir, 'exec.log');
    const version = '0.2.91';

    // Empty versioned-home downloads dir; binary lives only in the global dir.
    fs.mkdirSync(
      path.join(home, '.agents', '.history', 'versions', 'grok', version, 'home', '.grok', 'downloads'),
      { recursive: true },
    );
    const globalDownloads = path.join(home, '.grok', 'downloads');
    fs.mkdirSync(globalDownloads, { recursive: true });
    const binary = path.join(globalDownloads, `grok-${version}-macos-aarch64`);
    fs.writeFileSync(binary, `#!/bin/sh\nprintf "global:%s\\n" "$1" >> ${JSON.stringify(logPath)}\n`, { mode: 0o755 });

    fs.mkdirSync(project, { recursive: true });
    fs.writeFileSync(path.join(project, 'agents.yaml'), `agents:\n  grok: "${version}"\n`, 'utf-8');
    fs.writeFileSync(fakeAgents, '#!/bin/sh\nexit 0\n', { mode: 0o755 });

    const shimPath = path.join(dir, 'grok-shim');
    const shim = generateShimScript('grok').replace(/^AGENTS_BIN=.*$/m, `AGENTS_BIN=${JSON.stringify(fakeAgents)}`);
    fs.writeFileSync(shimPath, shim, { mode: 0o755 });

    const result = spawnSync('bash', [shimPath, 'ok'], {
      cwd: project,
      env: { ...process.env, HOME: home },
      encoding: 'utf-8',
    });

    expect(result.status, result.stderr).toBe(0);
    expect(fs.readFileSync(logPath, 'utf-8')).toContain('global:ok');
  });

  it('never execs a stray non-binary artifact that sorts before the real self-updated binary (RUSH-2459)', () => {
    // Reproduces the exact bug on yosemite-s0: version-home "0.2.82" held a
    // real self-updated grok-1.0.0-linux-aarch64 PLUS a stale, unrelated
    // 99-byte grok-0.2.118-linux-aarch64 wrapper script that exec'd
    // cursor-agent — no filename carries the pinned version "0.2.82", so the
    // dispatcher's fallback used to pick whichever `ls` sorted first, which
    // was the tiny wrapper. It must now reject anything under the size floor
    // and pick the real (padded-to-realistic-size) binary instead.
    const dir = makeTempDir();
    const home = path.join(dir, 'home');
    const project = path.join(dir, 'project');
    const fakeAgents = path.join(dir, 'agents');
    const logPath = path.join(dir, 'exec.log');
    const version = '0.2.82';

    const versionedDownloads = path.join(
      home, '.agents', '.history', 'versions', 'grok', version, 'home', '.grok', 'downloads',
    );
    fs.mkdirSync(versionedDownloads, { recursive: true });

    // Sorts alphabetically FIRST ("0" < "1") — must never be exec'd.
    fs.writeFileSync(
      path.join(versionedDownloads, 'grok-0.2.118-linux-aarch64'),
      `#!/bin/sh\nprintf "WRONG:%s\\n" "$1" >> ${JSON.stringify(logPath)}\n`,
      { mode: 0o755 },
    );

    // The real, self-updated binary — no filename match for "0.2.82", padded
    // well past the 1MB floor so it clears the size-based fallback filter.
    const padding = '# '.repeat(600_000);
    fs.writeFileSync(
      path.join(versionedDownloads, 'grok-1.0.0-linux-aarch64'),
      `#!/bin/sh\n${padding}\nprintf "RIGHT:%s\\n" "$1" >> ${JSON.stringify(logPath)}\n`,
      { mode: 0o755 },
    );

    fs.mkdirSync(project, { recursive: true });
    fs.writeFileSync(path.join(project, 'agents.yaml'), `agents:\n  grok: "${version}"\n`, 'utf-8');
    fs.writeFileSync(fakeAgents, '#!/bin/sh\nexit 0\n', { mode: 0o755 });

    const shimPath = path.join(dir, 'grok-shim');
    const shim = generateShimScript('grok').replace(/^AGENTS_BIN=.*$/m, `AGENTS_BIN=${JSON.stringify(fakeAgents)}`);
    fs.writeFileSync(shimPath, shim, { mode: 0o755 });

    const result = spawnSync('bash', [shimPath, 'ok'], {
      cwd: project,
      env: { ...process.env, HOME: home },
      encoding: 'utf-8',
    });

    expect(result.status, result.stderr).toBe(0);
    const log = fs.readFileSync(logPath, 'utf-8');
    expect(log).toContain('RIGHT:ok');
    expect(log).not.toContain('WRONG');
  });
});

describe('claude shim .oauth_token fallback', () => {
  function buildTestShim(dir: string, opts: {
    tokenFileContent?: string;
    envToken?: string;
    shimPlatform?: 'linux' | 'darwin';
  } = {}): { shimPath: string; configDir: string; fakeBin: string; logPath: string } {
    // Fake binary that logs the CLAUDE_CODE_OAUTH_TOKEN env var and exits.
    const fakeBin = path.join(dir, 'claude');
    const logPath = path.join(dir, 'env.log');
    fs.writeFileSync(fakeBin, [
      '#!/bin/sh',
      `printf "TOKEN:%s\\n" "\${CLAUDE_CODE_OAUTH_TOKEN:-<unset>}" >> ${JSON.stringify(logPath)}`,
    ].join('\n'), 'utf-8');
    fs.chmodSync(fakeBin, 0o755);

    // Version directory structure matching what the real shim uses.
    const versionDir = path.join(dir, 'versions', 'claude', '2.1.0');
    const configDir = path.join(versionDir, 'home', '.claude');
    fs.mkdirSync(configDir, { recursive: true });
    fs.mkdirSync(path.join(versionDir, 'node_modules', '.bin'), { recursive: true });
    // Symlink "claude" binary into node_modules/.bin/claude
    const binTarget = path.join(versionDir, 'node_modules', '.bin', 'claude');
    fs.symlinkSync(fakeBin, binTarget);

    if (opts.tokenFileContent !== undefined) {
      fs.writeFileSync(path.join(configDir, '.oauth_token'), opts.tokenFileContent, { mode: 0o600 });
    }

    // Build a minimal shim from the real template but with the dirs patched
    // to point at our temp tree, and uname -s overridden to simulate platform.
    const unameSim = opts.shimPlatform === 'darwin' ? 'Darwin' : 'Linux';
    const shim = [
      '#!/bin/bash',
      `VERSION_DIR=${JSON.stringify(versionDir)}`,
      `BINARY=${JSON.stringify(binTarget)}`,
      `export CLAUDE_CONFIG_DIR="$VERSION_DIR/home/.claude"`,
      // The actual new logic from the shim, with uname -s replaced for test isolation
      `if [ "${unameSim}" = "Linux" ] && [ -z "\${CLAUDE_CODE_OAUTH_TOKEN:-}" ] && [ -f "$CLAUDE_CONFIG_DIR/.oauth_token" ]; then`,
      `  CLAUDE_CODE_OAUTH_TOKEN=$(cat "$CLAUDE_CONFIG_DIR/.oauth_token")`,
      `  export CLAUDE_CODE_OAUTH_TOKEN`,
      `fi`,
      `exec "$BINARY" "$@"`,
    ].join('\n');

    const shimPath = path.join(dir, 'shim.sh');
    fs.writeFileSync(shimPath, shim, { mode: 0o755 });

    return { shimPath, configDir, fakeBin, logPath };
  }

  it('exports token from .oauth_token file on Linux when env var is unset', () => {
    const dir = makeTempDir();
    const { shimPath, logPath } = buildTestShim(dir, {
      tokenFileContent: 'sk-ant-test-linux-token',
      shimPlatform: 'linux',
    });

    const result = spawnSync('bash', [shimPath], {
      env: { ...process.env, CLAUDE_CODE_OAUTH_TOKEN: '' },
      encoding: 'utf-8',
    });
    expect(result.status, result.stderr).toBe(0);
    const log = fs.readFileSync(logPath, 'utf-8');
    expect(log).toContain('TOKEN:sk-ant-test-linux-token');
  });

  it('env var wins over .oauth_token file when already set', () => {
    const dir = makeTempDir();
    const { shimPath, logPath } = buildTestShim(dir, {
      tokenFileContent: 'sk-ant-from-file',
      shimPlatform: 'linux',
    });

    const result = spawnSync('bash', [shimPath], {
      env: { ...process.env, CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-from-env' },
      encoding: 'utf-8',
    });
    expect(result.status, result.stderr).toBe(0);
    const log = fs.readFileSync(logPath, 'utf-8');
    expect(log).toContain('TOKEN:sk-ant-from-env');
    expect(log).not.toContain('sk-ant-from-file');
  });

  it('is a no-op on macOS even when .oauth_token file exists', () => {
    const dir = makeTempDir();
    const { shimPath, logPath } = buildTestShim(dir, {
      tokenFileContent: 'sk-ant-should-not-be-used',
      shimPlatform: 'darwin',
    });

    const result = spawnSync('bash', [shimPath], {
      env: { ...process.env, CLAUDE_CODE_OAUTH_TOKEN: '' },
      encoding: 'utf-8',
    });
    expect(result.status, result.stderr).toBe(0);
    const log = fs.readFileSync(logPath, 'utf-8');
    expect(log).toContain('TOKEN:<unset>');
  });

  it('is a no-op on Linux when .oauth_token file is absent', () => {
    const dir = makeTempDir();
    const { shimPath, logPath } = buildTestShim(dir, {
      shimPlatform: 'linux',
      // no tokenFileContent
    });

    const result = spawnSync('bash', [shimPath], {
      env: { ...process.env, CLAUDE_CODE_OAUTH_TOKEN: '' },
      encoding: 'utf-8',
    });
    expect(result.status, result.stderr).toBe(0);
    const log = fs.readFileSync(logPath, 'utf-8');
    expect(log).toContain('TOKEN:<unset>');
  });
});

describe('hasAliasShadowingShim', () => {
  function makeFakeHome(rc: string): string {
    const home = makeTempDir();
    fs.writeFileSync(path.join(home, '.zshrc'), rc);
    return home;
  }

  it('returns true for a plain `alias codex=...`', () => {
    const home = makeFakeHome(`alias codex='codex --foo'\n`);
    expect(hasAliasShadowingShim('codex', { homeDir: home })).toBe(true);
  });

  it('returns false when a later `unalias codex` cancels an earlier alias', () => {
    // Real-world: rc declares an alias near the top, then a cleanup block
    // unalias's a list of names later. Static regex on whole-file content
    // (the previous implementation) reported true here.
    const home = makeFakeHome(
      `alias codex="codex --sandbox workspace-write"\n# ... more rc ...\nunalias claude codex gemini 2>/dev/null || true\n`,
    );
    expect(hasAliasShadowingShim('codex', { homeDir: home })).toBe(false);
  });

  it('returns true when alias appears AFTER a prior unalias for the same name', () => {
    const home = makeFakeHome(`unalias codex 2>/dev/null || true\nalias codex='codex --foo'\n`);
    expect(hasAliasShadowingShim('codex', { homeDir: home })).toBe(true);
  });

  it('returns false when only an unalias is present', () => {
    const home = makeFakeHome(`unalias codex 2>/dev/null || true\n`);
    expect(hasAliasShadowingShim('codex', { homeDir: home })).toBe(false);
  });

  it('returns false when the rc file mentions a different command', () => {
    const home = makeFakeHome(`alias claude='claude --foo'\n`);
    expect(hasAliasShadowingShim('codex', { homeDir: home })).toBe(false);
  });
});

describe('shimTargetsFor (drop the vestigial bash shim on Windows)', () => {
  it('POSIX writes only the extensionless bash shim', () => {
    expect(shimTargetsFor('linux')).toEqual({ bash: true, cmd: false });
    expect(shimTargetsFor('darwin')).toEqual({ bash: true, cmd: false });
  });

  it('win32 writes only the .cmd companion — the bash file is never executed there', () => {
    expect(shimTargetsFor('win32')).toEqual({ bash: false, cmd: true });
  });
});

describe('onDiskShimFile (exists/remove must match what createShim writes)', () => {
  // Regression guard: createShim writes only `<cmd>.cmd` on Windows, so
  // shimExists/removeShim/readShimSchemaVersion must stat the SAME file. Deriving
  // this from shimTargetsFor makes the two sides impossible to drift apart — the
  // bug where the write side skipped the bare file but the check side still
  // looked for it (orphaned .cmd on remove, regenerate-every-launch).
  it('returns the .cmd companion on Windows', () => {
    expect(onDiskShimFile('claude', 'win32')).toBe('claude.cmd');
  });

  it('returns the bare script on POSIX', () => {
    expect(onDiskShimFile('claude', 'linux')).toBe('claude');
    expect(onDiskShimFile('codex', 'darwin')).toBe('codex');
  });

  it('agrees with shimTargetsFor for every platform', () => {
    for (const platform of ['win32', 'linux', 'darwin'] as const) {
      const expectsCmd = shimTargetsFor(platform).cmd;
      expect(onDiskShimFile('claude', platform).endsWith('.cmd')).toBe(expectsCmd);
    }
  });
});
