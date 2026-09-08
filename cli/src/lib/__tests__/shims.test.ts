import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  addShimsToPath,
  generateShimScript,
  generateVersionedAliasScript,
  hasAliasShadowingShim,
  readCodexConfiguredModel,
  removeLegacyUserShim,
  SHIM_SCHEMA_VERSION,
  VERSIONED_ALIAS_SCHEMA_VERSION,
} from '../installations/shims.js';

const originalHome = process.env.HOME;
const originalShell = process.env.SHELL;
const SHIMS_FIXTURES_DIR = path.join(import.meta.dirname, 'testdata', 'shims');

interface ShimFixtureCase {
  shell: string;
  alreadyPresent?: boolean;
}

// The shim PATH-block rewrite (addShimsToPath) is POSIX shell-rc logic and
// operates on LF-delimited lines. Git can check these text fixtures out with
// CRLF on Windows, so fold to LF on read — otherwise the comparison fails on a
// pure line-ending difference that never occurs in a real POSIX rc file.
const toLF = (s: string): string => s.replace(/\r\n/g, '\n');

function readShimFixture(name: string): { meta: ShimFixtureCase; before: string; after: string } {
  const meta = JSON.parse(fs.readFileSync(path.join(SHIMS_FIXTURES_DIR, `${name}.json`), 'utf8')) as ShimFixtureCase;
  const before = toLF(fs.readFileSync(path.join(SHIMS_FIXTURES_DIR, `${name}.before`), 'utf8'));
  const after = toLF(fs.readFileSync(path.join(SHIMS_FIXTURES_DIR, `${name}.after`), 'utf8'));
  return { meta, before, after };
}

describe('addShimsToPath', () => {
  let home: string;
  let shimsDir: string;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-shims-test-'));
    shimsDir = path.join(home, '.agents-system', 'shims');
    process.env.HOME = home;
  });

  afterEach(() => {
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
    if (originalShell === undefined) {
      delete process.env.SHELL;
    } else {
      process.env.SHELL = originalShell;
    }
    fs.rmSync(home, { recursive: true, force: true });
  });

  const cases = [
    'zsh-reorder-before-nvm',
    'zsh-idempotent',
    'bash-insert-before-node-path',
    'fish-replace-legacy-path',
    'zsh-ignore-lookalike-paths',
    'zsh-append-after-installer-blocks',
  ] as const;

  for (const fixtureName of cases) {
    it(`rewrites rc files correctly for ${fixtureName}`, () => {
      const fixture = readShimFixture(fixtureName);
      process.env.SHELL = fixture.meta.shell;
      const rcFile = path.basename(fixture.meta.shell) === 'fish' ? '.config/fish/config.fish' : path.basename(fixture.meta.shell) === 'zsh' ? '.zshrc' : '.bashrc';
      const rcPath = path.join(home, rcFile);

      fs.mkdirSync(path.dirname(rcPath), { recursive: true });
      fs.writeFileSync(rcPath, fixture.before.replaceAll('__SHIMS_DIR__', shimsDir), 'utf8');

      const result = addShimsToPath({ homeDir: home, shell: fixture.meta.shell, shimsDir });
      expect(result).toEqual({
        success: true,
        ...(fixture.meta.alreadyPresent ? { alreadyPresent: true } : {}),
        rcFile,
        location: `~/${rcFile}`,
        reloadHint: `Restart your shell or run: source ~/${rcFile}`,
      });

      const content = toLF(fs.readFileSync(rcPath, 'utf8'));
      const expected = fixture.after.replaceAll('__SHIMS_DIR__', shimsDir).trimEnd();
      expect(content.trimEnd()).toBe(expected);
    });
  }
});

describe('SHIM_SCHEMA_VERSION', () => {
  it('is 31 (PHNX-3940: launch/update coordination)', () => {
    expect(SHIM_SCHEMA_VERSION).toBe(31);
  });
});

describe('generateShimScript — configDirName derivation', () => {
  it('produces the unchanged ".claude" subdir for claude (regression guard)', () => {
    const script = generateShimScript('claude');
    expect(script).toContain('home/.claude');
    expect(script).not.toContain('home/./.claude');
  });

  it('points the antigravity alias at that version home, not a shared one', () => {
    // The previous name claimed this checked a nested ".gemini/antigravity-cli"
    // config path, but the only assertion was on "versions/antigravity/1.0.1"
    // — the generated script contains no ".gemini" segment at all, so the
    // regression it advertised was never guarded. Assert what the script
    // actually has to get right: the binary resolves inside the requested
    // version home, so per-version sync cannot land in a shared install.
    const script = generateVersionedAliasScript('antigravity', '1.0.1');
    expect(script).toContain('versions/antigravity/1.0.1/');
  });
});

describe('generateShimScript — config-dir env vars', () => {
  it('exports CLAUDE_CONFIG_DIR for claude', () => {
    const script = generateShimScript('claude');
    expect(script).toContain('export CLAUDE_CONFIG_DIR=');
    expect(script).not.toContain('export CODEX_HOME=');
  });

  it('exports CODEX_HOME for codex so the versioned config/rules are read', () => {
    const script = generateShimScript('codex');
    expect(script).toContain('export CODEX_HOME');
    expect(script).toContain('CODEX_HOME="$VERSION_DIR/home/.codex"');
    expect(script).not.toContain('export CLAUDE_CONFIG_DIR=');
  });

  // RUSH-1866: the deep versioned CODEX_HOME overflows macOS's 104-byte
  // SUN_LEN cap for codex's app-server control socket, breaking every codex
  // spawn. The shim must guard on Darwin + overflow and relocate to a short
  // home, while still honoring a caller-set CODEX_HOME.
  it('guards CODEX_HOME against the macOS SUN_LEN limit', () => {
    const script = generateShimScript('codex');
    expect(script).toContain('if [ -z "${CODEX_HOME:-}" ]; then');
    expect(script).toContain('$(uname -s)" = "Darwin"');
    expect(script).toContain('${#CODEX_HOME} + 43 ))" -gt 104');
    expect(script).toContain('$AGENTS_USER_DIR/.codex-homes/$VERSION/.codex');
  });

  it('exports KIMI_CODE_HOME for kimi so config/sessions/skills are versioned', () => {
    const script = generateShimScript('kimi');
    expect(script).toContain('export KIMI_CODE_HOME=');
    expect(script).toContain('"$VERSION_DIR/home/.kimi-code"');
  });

  // Regression (re-exec loop): the dispatcher must resolve kimi through the
  // generic node_modules/.bin branch, never the old ~/.kimi-code/bin path whose
  // `command -v kimi` fallback resolves to this dispatcher itself (the shims dir
  // sits ahead of ~/.local/bin on PATH) and re-execs forever.
  it('resolves kimi from node_modules/.bin in the dispatcher, without a command -v loop', () => {
    const script = generateShimScript('kimi');
    expect(script).toContain('"$VERSION_DIR/node_modules/.bin/$CLI_COMMAND"');
    expect(script).not.toContain('BINARY=$(command -v kimi');
    expect(script).not.toContain('KIMI_BINARY="$HOME/.kimi-code/bin/kimi"');
  });

  it('does not export a managed config-dir var for other agents', () => {
    const script = generateShimScript('opencode');
    expect(script).not.toContain('export CLAUDE_CONFIG_DIR=');
    expect(script).not.toContain('export CODEX_HOME=');
  });
});

describe('generateVersionedAliasScript', () => {
  it('uses ~/.agents/.history for direct alias binary and config paths', () => {
    const script = generateVersionedAliasScript('codex', '0.125.0');
    expect(VERSIONED_ALIAS_SCHEMA_VERSION).toBe(20);
    expect(script).toContain('$AGENTS_REAL_HOME/.agents/.history/versions/codex/0.125.0');
    expect(script).not.toContain('$HOME/.agents-system/versions/codex/0.125.0');
  });

  // Regression: node_modules/.bin is correct for npm-packaged agents, but Grok,
  // Kimi, and Droid ship their binaries elsewhere. Hardcoding node_modules made
  // every versioned alias for these three (the path `agents teams` takes once it
  // pins a teammate) fail with "<agent>@<version> not installed".
  it('resolves npm-packaged agents from node_modules/.bin', () => {
    const script = generateVersionedAliasScript('codex', '0.125.0');
    expect(script).toContain('node_modules/.bin/codex');
  });

  it('points OpenCode at its versioned plugin/config directory', () => {
    const alias = generateVersionedAliasScript('opencode', '1.18.4');
    const shim = generateShimScript('opencode');
    expect(alias).toContain(
      'export OPENCODE_CONFIG_DIR="$AGENTS_REAL_HOME/.agents/.history/versions/opencode/1.18.4/home/.config/opencode"'
    );
    expect(shim).toContain(
      'export OPENCODE_CONFIG_DIR="$VERSION_DIR/home/.config/opencode"'
    );
  });

  it('resolves droid from ~/.local/bin/droid, not node_modules', () => {
    const script = generateVersionedAliasScript('droid', '0.159.1');
    expect(script).toContain('DROID_BINARY="$AGENTS_REAL_HOME/.local/bin/droid"');
    expect(script).not.toContain('node_modules/.bin/droid');
  });

  it('resolves grok from the versioned home first, global ~/.grok/downloads as fallback, and exports GROK_HOME', () => {
    const script = generateVersionedAliasScript('grok', '0.2.33');
    // Versioned home is the primary location — where the binary lands when the
    // installer runs with GROK_HOME set or grok self-updates under the shim.
    expect(script).toContain('GROK_DOWNLOADS="$AGENTS_REAL_HOME/.agents/.history/versions/grok/0.2.33/home/.grok/downloads"');
    // Global dir stays as the fallback for pre-fix installs.
    expect(script).toContain('GROK_GLOBAL_DOWNLOADS="$AGENTS_REAL_HOME/.grok/downloads"');
    expect(script).not.toContain('node_modules/.bin/grok');
    expect(script).toContain('export GROK_HOME=');
  });

  // Regression (re-exec loop): when ~/.grok/downloads is empty, the grok
  // fallback runs `command -v grok`, which resolves to this alias's sibling
  // dispatcher shim (shims dir ahead of ~/.local/bin on PATH). Without a guard
  // it exec-loops forever. The guard must null out any shims-dir match.
  it('guards grok command -v fallback against the shims dir (alias)', () => {
    const script = generateVersionedAliasScript('grok', '0.2.33');
    expect(script).toContain('command -v grok');
    expect(script).toContain('"$AGENTS_REAL_HOME/.agents/.cache/shims/"*) BINARY="" ;;');
  });

  it('guards grok command -v fallback against the shims dir (dispatcher)', () => {
    const script = generateShimScript('grok');
    expect(script).toContain('command -v grok');
    expect(script).toContain('"$AGENTS_USER_DIR/.cache/shims/"*) BINARY="" ;;');
  });

  it('resolves grok for the pinned version', () => {
    const script = generateVersionedAliasScript('grok', '0.1.218');
    expect(script).toContain('$AGENTS_REAL_HOME/.grok/downloads');
    // RUSH-2459: no more raw "grep -i <version>" against ls's full path output
    // (which always matched, since the versioned home's own path contains the
    // version string) — resolution now runs through the shared, filename-scoped
    // _resolve_grok_binary helper, called with the pinned version.
    expect(script).toContain('_resolve_grok_binary() {');
    expect(script).toContain('_resolve_grok_binary "$GROK_DOWNLOADS" "0.1.218"');
    expect(script).not.toContain('node_modules/.bin');
  });

  // Regression (re-exec loop): kimi npm-installs @moonshot-ai/kimi-code, so its
  // binary is at node_modules/.bin/kimi — NOT ~/.kimi-code/bin (that path only
  // exists for a curl install, and even then installVersion symlinks it into
  // node_modules/.bin). The old ~/.kimi-code/bin special-case fell back to
  // `command -v kimi`, which resolves to the sibling dispatcher shim and
  // re-execs forever. Resolve via node_modules; keep KIMI_CODE_HOME isolation.
  it('resolves kimi from node_modules/.bin, not ~/.kimi-code/bin', () => {
    const script = generateVersionedAliasScript('kimi', '0.12.1');
    expect(script).toContain('node_modules/.bin/kimi');
    expect(script).not.toContain('KIMI_BINARY="$HOME/.kimi-code/bin/kimi"');
    expect(script).not.toContain('BINARY=$(command -v kimi');
    expect(script).toContain('export KIMI_CODE_HOME=');
  });

  it('keeps npm-packaged claude on node_modules/.bin', () => {
    const script = generateVersionedAliasScript('claude', '2.1.0');
    expect(script).toContain('/node_modules/.bin/claude');
  });
});

describe('removeLegacyUserShim', () => {
  let home: string;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-legacy-shim-'));
    process.env.HOME = home;
  });

  afterEach(() => {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('removes ~/.agents/shims/<cli> when it exists and returns true', () => {
    const legacyShimsDir = path.join(home, '.agents', 'shims');
    const legacyShim = path.join(legacyShimsDir, 'claude');
    fs.mkdirSync(legacyShimsDir, { recursive: true });
    fs.writeFileSync(legacyShim, '#!/bin/sh\necho legacy\n');

    expect(removeLegacyUserShim('claude', { homeDir: home })).toBe(true);
    expect(fs.existsSync(legacyShim)).toBe(false);
    // Empty dir cleanup is best-effort — verify it was removed too.
    expect(fs.existsSync(legacyShimsDir)).toBe(false);
  });

  it('returns false when no legacy shim exists', () => {
    expect(removeLegacyUserShim('claude', { homeDir: home })).toBe(false);
  });

  it('does not touch sibling files in ~/.agents/shims/', () => {
    const legacyShimsDir = path.join(home, '.agents', 'shims');
    fs.mkdirSync(legacyShimsDir, { recursive: true });
    fs.writeFileSync(path.join(legacyShimsDir, 'claude'), '#!/bin/sh\n');
    fs.writeFileSync(path.join(legacyShimsDir, 'something-else'), 'do not touch');

    expect(removeLegacyUserShim('claude', { homeDir: home })).toBe(true);
    expect(fs.existsSync(path.join(legacyShimsDir, 'something-else'))).toBe(true);
  });
});

describe('generateShimScript', () => {
  it('contains no reference to .agents-version', () => {
    const script = generateShimScript('claude');
    expect(script).not.toContain('.agents-version');
  });

  it('embeds the shim schema version marker matching SHIM_SCHEMA_VERSION', () => {
    const script = generateShimScript('claude');
    expect(script).toContain(`agents-shim-version: ${SHIM_SCHEMA_VERSION}`);
  });

  it('walks up looking for agents.yaml (not .agents-version)', () => {
    const script = generateShimScript('claude');
    expect(script).toContain('agents.yaml');
  });

  it('skips $HOME/.agents/agents.yaml when walking up', () => {
    const script = generateShimScript('claude');
    expect(script).toContain('user_agents_yaml');
    expect(script).toContain('$HOME/.agents/agents.yaml');
    expect(script).toContain('"$candidate" != "$user_agents_yaml"');
  });

  it('error message references agents.yaml not .agents-version', () => {
    const script = generateShimScript('claude');
    expect(script).toContain('required by agents.yaml but not installed');
    expect(script).not.toContain('required by .agents-version');
  });

  it('does not run foreground project resource sync on the launch hot path', () => {
    const script = generateShimScript('claude');
    expect(script).not.toContain('find_project_agents_dir');
    // sync IS allowed on the hot path, but only with --launch (filesystem-only,
    // sub-50ms, non-blocking). A foreground sync without --launch is forbidden.
    expect(script).not.toMatch(/\bsync --agent "\$AGENT"(?![^\n]*--launch)/);
    expect(script).not.toContain('refresh-rules --agent "$AGENT"');
  });

  it('includes find_latest_installed that handles semver and date-based versions', () => {
    const script = generateShimScript('claude');
    expect(script).toContain('find_latest_installed()');
    expect(script).toContain('split(cur, a, /[^0-9]+/)');
  });

  it('proposes latest installed when no default is configured', () => {
    const script = generateShimScript('claude');
    expect(script).toContain('no default set for $AGENT');
    expect(script).toContain('Set as default and continue?');
    expect(script).toContain('"$AGENTS_BIN" use "$AGENT" "$LATEST"');
  });

  it('proposes switching to latest installed when configured version is missing', () => {
    const script = generateShimScript('claude');
    expect(script).toContain('not installed — found $AGENT@$LATEST installed');
    expect(script).toContain('Switch default to $AGENT@$LATEST and continue?');
  });

  it('falls back gracefully when no versions are installed at all', () => {
    const script = generateShimScript('claude');
    expect(script).toContain('no version of $AGENT configured');
    expect(script).toContain('Run: agents add $AGENT@<version>');
  });

  it('reads answer from /dev/tty not stdin so piped input does not trigger prompt', () => {
    const script = generateShimScript('claude');
    expect(script).toContain('read -r _ans </dev/tty');
  });

  it('uses an absolute agents-cli entrypoint for cold-path helper calls only', () => {
    const script = generateShimScript('codex');
    const match = script.match(/^AGENTS_BIN='([^']+)'$/m);

    expect(match).not.toBeNull();
    expect(path.isAbsolute(match![1])).toBe(true);
    expect(script).toContain('"$AGENTS_BIN" use "$AGENT" "$LATEST"');
    expect(script).toContain('"$AGENTS_BIN" add "$AGENT@$VERSION" --yes');
    expect(script).not.toMatch(/^\s*agents (refresh-rules|use|add|sync)\b/m);
    expect(script).not.toContain('"$AGENTS_BIN" refresh-rules');
    // sync IS called on the hot path, but only with --launch (filesystem-only,
    // sub-50ms, non-blocking). A foreground sync without --launch is forbidden.
    expect(script).not.toMatch(/"\$AGENTS_BIN" sync\b(?![^\n]*--launch)/);
  });

  it('fails clearly when the embedded agents-cli entrypoint is not executable', () => {
    const script = generateShimScript('claude');
    expect(script).toContain('if [ -z "$AGENTS_BIN" ] || [ ! -x "$AGENTS_BIN" ]; then');
    expect(script).toContain('agents: agents-cli entrypoint missing or not executable: $AGENTS_BIN');
    expect(script).toContain('exit 127');
  });

  it('self-recovers a vanished dispatcher via `agents` on PATH before erroring', () => {
    const script = generateShimScript('claude');
    // When the baked AGENTS_BIN is gone (removed/moved dev build), resolve the
    // real `agents` on PATH and use it, rather than bricking the launch.
    expect(script).toContain('RECOVERED_BIN="$(command -v agents 2>/dev/null || true)"');
    expect(script).toContain('AGENTS_BIN="$RECOVERED_BIN"');
    // The recovery must sit INSIDE the not-executable guard, before exit 127.
    const guard = script.indexOf('[ ! -x "$AGENTS_BIN" ]; then');
    const recover = script.indexOf('command -v agents');
    const bail = script.indexOf('exit 127');
    expect(guard).toBeGreaterThanOrEqual(0);
    expect(recover).toBeGreaterThan(guard);
    expect(bail).toBeGreaterThan(recover);
  });
});

describe('hasAliasShadowingShim', () => {
  let home: string;
  let originalHome: string | undefined;

  beforeEach(() => {
    originalHome = process.env.HOME;
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-alias-test-'));
    process.env.HOME = home;
  });

  afterEach(() => {
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('returns true when an alias is defined without a later unalias', () => {
    fs.writeFileSync(
      path.join(home, '.zshrc'),
      'alias codex="codex --sandbox workspace-write"\n',
      'utf8',
    );
    expect(hasAliasShadowingShim('codex', { homeDir: home })).toBe(true);
  });

  it('returns false when a later unalias removes the alias', () => {
    fs.writeFileSync(
      path.join(home, '.zshrc'),
      [
        'alias codex="codex --sandbox workspace-write"',
        'unalias claude codex gemini 2>/dev/null || true',
      ].join('\n'),
      'utf8',
    );
    expect(hasAliasShadowingShim('codex', { homeDir: home })).toBe(false);
  });
});

// Regression: two agents-cli installs with different SHIM_SCHEMA_VERSION sharing
// ~/.agents/.cache/shims/ used to ping-pong — each regenerated every shim whose
// embedded marker !== its own constant, so they took turns rewriting all shims
// on every launch. ensureShimCurrent is now upgrade-only: it never downgrades a
// shim stamped by a newer install. (SHIMS_DIR is derived from HOME at module
// load, so re-import under a temp HOME to keep the real shims dir untouched.)
describe('ensureShimCurrent — upgrade-only / newest-wins', () => {
  let home: string;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-shim-current-'));
    process.env.HOME = home;
    vi.resetModules();
  });

  afterEach(() => {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    vi.resetModules();
    fs.rmSync(home, { recursive: true, force: true });
  });

  function writeShim(shimPath: string, marker: string): void {
    fs.mkdirSync(path.dirname(shimPath), { recursive: true });
    fs.writeFileSync(shimPath, `#!/bin/bash\n# ${marker}\nexec true\n`, { mode: 0o755 });
  }

  // The file createShim actually writes on this platform: `<cmd>.cmd` on Windows,
  // the bare script on POSIX. Fixtures must land here — since #543, shimExists /
  // readShimSchemaVersion key off the on-disk filename (onDiskShimFile), while
  // getShimPath returns the logical (extensionless) launch path that isn't a real
  // file on Windows. Writing the fixture to getShimPath left Windows looking for a
  // `.cmd` that never existed, so ensureShimCurrent always returned 'created'.
  function onDiskShimPath(mod: typeof import('../installations/shims.js'), agent: 'claude'): string {
    const logical = mod.getShimPath(agent);
    return path.join(path.dirname(logical), mod.onDiskShimFile(path.basename(logical), process.platform));
  }

  it('does NOT downgrade a shim stamped by a newer install', async () => {
    const mod = await import('../installations/shims.js');
    const shimPath = onDiskShimPath(mod, 'claude');
    const newer = mod.SHIM_SCHEMA_VERSION + 1;
    writeShim(shimPath, `agents-shim-version: ${newer}`);
    const before = fs.readFileSync(shimPath, 'utf8');

    expect(mod.ensureShimCurrent('claude')).toBe('current');
    expect(fs.readFileSync(shimPath, 'utf8')).toBe(before); // left untouched
  });

  it('regenerates a shim from an older install (upgrade)', async () => {
    const mod = await import('../installations/shims.js');
    const shimPath = onDiskShimPath(mod, 'claude');
    writeShim(shimPath, 'agents-shim-version: 1');

    expect(mod.ensureShimCurrent('claude')).toBe('updated');
    expect(fs.readFileSync(shimPath, 'utf8')).toContain(
      `agents-shim-version: ${mod.SHIM_SCHEMA_VERSION}`,
    );
  });

  it('regenerates an unversioned (pre-marker) shim', async () => {
    const mod = await import('../installations/shims.js');
    const shimPath = onDiskShimPath(mod, 'claude');
    writeShim(shimPath, 'no marker here');

    expect(mod.ensureShimCurrent('claude')).toBe('updated');
  });

  it('leaves a current shim untouched', async () => {
    const mod = await import('../installations/shims.js');
    mod.createShim('claude');
    expect(mod.ensureShimCurrent('claude')).toBe('current');
  });
});

// Regression (#windows-alias-shadow): a bash alias written next to the
// versioned `.cmd` hijacks Windows name resolution — the dotted version suffix
// makes cmd.exe/PowerShell read `claude@2.1.201` as a complete filename with
// extension `.201`, the exact match wins over PATHEXT probing, and the shell
// ShellExecutes the bash script to the `.sh` editor association. `agents
// sessions` resume then "succeeds" (rc=0) while the editor, not Claude, opens.
describe('versioned alias — platform on-disk artifacts', () => {
  let home: string;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-alias-artifacts-'));
    process.env.HOME = home;
    vi.resetModules();
  });

  afterEach(() => {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    vi.resetModules();
    fs.rmSync(home, { recursive: true, force: true });
  });

  const onWindows = process.platform === 'win32';

  it('materializes only the platform target', async () => {
    const mod = await import('../installations/shims.js');
    const aliasPath = mod.getVersionedAliasPath('claude', '2.1.201');

    mod.createVersionedAlias('claude', '2.1.201');

    if (onWindows) {
      expect(fs.existsSync(aliasPath)).toBe(false);
      const cmd = fs.readFileSync(aliasPath + '.cmd', 'utf8');
      expect(cmd).toContain(`agents-versioned-alias-version: ${mod.VERSIONED_ALIAS_SCHEMA_VERSION}`);
    } else {
      expect(fs.existsSync(aliasPath)).toBe(true);
      expect(fs.existsSync(aliasPath + '.cmd')).toBe(false);
      expect(fs.readFileSync(aliasPath, 'utf8')).toContain(
        `agents-versioned-alias-version: ${mod.VERSIONED_ALIAS_SCHEMA_VERSION}`,
      );
    }
    expect(mod.versionedAliasExists('claude', '2.1.201')).toBe(true);
  });

  it('deletes a legacy bash alias that would shadow the .cmd on Windows', async () => {
    const mod = await import('../installations/shims.js');
    const aliasPath = mod.getVersionedAliasPath('claude', '2.1.201');
    fs.mkdirSync(path.dirname(aliasPath), { recursive: true });
    fs.writeFileSync(aliasPath, '#!/bin/bash\n# agents-versioned-alias-version: 10\nexec true\n', { mode: 0o755 });

    mod.createVersionedAlias('claude', '2.1.201');

    if (onWindows) {
      expect(fs.existsSync(aliasPath)).toBe(false);
      expect(fs.existsSync(aliasPath + '.cmd')).toBe(true);
    } else {
      // POSIX overwrites the script in place — the bash alias IS the artifact.
      expect(fs.readFileSync(aliasPath, 'utf8')).toContain(
        `agents-versioned-alias-version: ${mod.VERSIONED_ALIAS_SCHEMA_VERSION}`,
      );
    }
  });

  it('ensureVersionedAliasCurrent round-trips created -> current', async () => {
    const mod = await import('../installations/shims.js');
    expect(mod.ensureVersionedAliasCurrent('claude', '2.1.201')).toBe('created');
    expect(mod.ensureVersionedAliasCurrent('claude', '2.1.201')).toBe('current');
  });

  it.runIf(onWindows)('ensureVersionedAliasCurrent clears a shadowing bash alias even when the .cmd is current', async () => {
    const mod = await import('../installations/shims.js');
    const aliasPath = mod.getVersionedAliasPath('claude', '2.1.201');
    mod.createVersionedAlias('claude', '2.1.201');
    expect(mod.ensureVersionedAliasCurrent('claude', '2.1.201')).toBe('current');

    // An older agents-cli sharing the shims dir re-created the bash alias.
    fs.writeFileSync(aliasPath, '#!/bin/bash\nexec true\n', { mode: 0o755 });

    expect(mod.ensureVersionedAliasCurrent('claude', '2.1.201')).toBe('updated');
    expect(fs.existsSync(aliasPath)).toBe(false);
    expect(fs.existsSync(aliasPath + '.cmd')).toBe(true);
  });

  it('removeVersionedAlias removes every companion on disk', async () => {
    const mod = await import('../installations/shims.js');
    const aliasPath = mod.getVersionedAliasPath('claude', '2.1.201');
    mod.createVersionedAlias('claude', '2.1.201');
    // Legacy leftover from a pre-v12 Windows install alongside the .cmd.
    if (onWindows) fs.writeFileSync(aliasPath, '#!/bin/bash\nexec true\n', { mode: 0o755 });

    expect(mod.removeVersionedAlias('claude', '2.1.201')).toBe(true);
    expect(fs.existsSync(aliasPath)).toBe(false);
    expect(fs.existsSync(aliasPath + '.cmd')).toBe(false);
    expect(mod.versionedAliasExists('claude', '2.1.201')).toBe(false);
    expect(mod.removeVersionedAlias('claude', '2.1.201')).toBe(false);
  });

  it('versionedAliasOnDiskFile picks the runnable filename per platform', async () => {
    const mod = await import('../installations/shims.js');
    expect(mod.versionedAliasOnDiskFile('claude', '2.1.201', 'win32')).toBe('claude@2.1.201.cmd');
    expect(mod.versionedAliasOnDiskFile('claude', '2.1.201', 'linux')).toBe('claude@2.1.201');
    expect(mod.versionedAliasOnDiskFile('codex', '0.125.0', 'darwin')).toBe('codex@0.125.0');
  });
});

describe('readCodexConfiguredModel', () => {
  let tmpHome: string;
  const originalRealHome = process.env.AGENTS_REAL_HOME;

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-cfg-'));
    process.env.AGENTS_REAL_HOME = tmpHome;
  });

  afterEach(() => {
    if (originalRealHome === undefined) delete process.env.AGENTS_REAL_HOME;
    else process.env.AGENTS_REAL_HOME = originalRealHome;
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  const writeConfig = (contents: string): void => {
    const dir = path.join(tmpHome, '.codex');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'config.toml'), contents);
  };

  it('returns the top-level model the user configured', () => {
    writeConfig('model = "gpt-5.5"\nmodel_reasoning_effort = "high"\n');
    expect(readCodexConfiguredModel()).toBe('gpt-5.5');
  });

  it('ignores a model set only inside a [profile.*] table', () => {
    // The CLI uses the top-level model as its default; a profile model must not
    // masquerade as the default, or we would forward a model the run never uses.
    writeConfig('model_reasoning_effort = "high"\n\n[profiles.fast]\nmodel = "gpt-5.3-codex"\n');
    expect(readCodexConfiguredModel()).toBeUndefined();
  });

  it('returns undefined when the config is missing (keeps prior behaviour)', () => {
    expect(readCodexConfiguredModel()).toBeUndefined();
  });
});
