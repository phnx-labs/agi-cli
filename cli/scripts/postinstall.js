#!/usr/bin/env node
// Runs after npm install -g @phnx-labs/agents-cli
// Sets up shims directory and prints PATH instructions.
// Set AGENTS_INIT_SHELL=1 to opt in to automatic shell-rc mutation.

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as readline from 'readline';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';

const HOME = os.homedir();
const USER_DIR = path.join(HOME, '.agents');
const SHIMS_DIR = path.join(USER_DIR, '.cache', 'shims');
// System repo lives inside the user repo (folded in v1.21). Legacy installs at
// ~/.agents-system/ are migrated by src/lib/migrate.ts on first CLI invocation.
const SYSTEM_DIR = path.join(USER_DIR, '.system');
const AGENTS_JS_ENTRYPOINT = fileURLToPath(new URL('../dist/index.js', import.meta.url));
// Signed + notarized standalone Mach-O, macOS only (scripts/sign-cli-binary.sh).
// Preferred over the node-shebang JS entrypoint on darwin: the unsigned JS shim
// is what EDR (CrowdStrike Falcon) flags when an editor child spawns it (#315).
const AGENTS_NATIVE_MACOS_BIN = fileURLToPath(new URL('../dist/bin/agents', import.meta.url));
const AGENTS_BIN = resolveAgentsBin();

function resolveAgentsBin() {
  if (process.platform !== 'darwin') return AGENTS_JS_ENTRYPOINT;
  try {
    fs.accessSync(AGENTS_NATIVE_MACOS_BIN, fs.constants.X_OK);
  } catch {
    return AGENTS_JS_ENTRYPOINT; // no native binary in this install (dev build, arch without one)
  }
  // Real execution probe, not just a stat: catches a quarantined, EDR-blocked,
  // or wrong-arch (Intel) binary at install time, where we can still fall back
  // loudly, instead of breaking every later `agents` call.
  const probe = spawnSync(AGENTS_NATIVE_MACOS_BIN, ['--version'], {
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 15000,
    encoding: 'utf-8',
  });
  if (probe.status === 0) return AGENTS_NATIVE_MACOS_BIN;
  const why = probe.error ? probe.error.message : `exit status ${probe.status}`;
  console.warn(`  warning: the signed agents binary at ${AGENTS_NATIVE_MACOS_BIN} failed to run (${why}).`);
  console.warn(`  Falling back to the JS entrypoint; 'agents' still works but is not code-signed.`);
  return AGENTS_JS_ENTRYPOINT;
}

function shellQuote(value) {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

// Shorthands that delegate to the installed agents-cli entrypoint.
const ALIASES = ['sessions', 'secrets', 'browser', 'pty', 'teams'];

function writeAliasShims() {
  const written = [];
  for (const name of ALIASES) {
    const target = path.join(SHIMS_DIR, name);
    const script = `#!/bin/sh\nAGENTS_BIN=${shellQuote(AGENTS_BIN)}\nif [ -z "$AGENTS_BIN" ] || [ ! -x "$AGENTS_BIN" ]; then\n  echo "agents: agents-cli entrypoint missing or not executable: $AGENTS_BIN" >&2\n  exit 127\nfi\nexec "$AGENTS_BIN" ${name} "$@"\n`;
    fs.writeFileSync(target, script, { mode: 0o755 });
    // Windows can't run the POSIX shim; drop a `.cmd` companion that invokes the
    // entrypoint via node so the bare shorthand works in a Windows shell.
    if (process.platform === 'win32') {
      fs.writeFileSync(target + '.cmd', `@echo off\r\nnode "${AGENTS_BIN}" ${name} %*\r\n`);
    }
    written.push(name);
  }
  return written;
}

// Self-updater entry: the upgrade installs with --ignore-scripts (skipping
// this script as an npm lifecycle hook), then re-invokes it with this env var
// so the alias shims are refreshed from the newly installed copy. Shims only —
// no prompts, no rc-file edits, no output.
if (process.env.AGENTS_POSTINSTALL_SHIMS_ONLY === '1') {
  fs.mkdirSync(SHIMS_DIR, { recursive: true });
  writeAliasShims();
  process.exit(0);
}

// For local installs, create directories and show a message
const isGlobalInstall = process.env.npm_config_global || process.argv.includes('-g');
if (!isGlobalInstall) {
  // Still create user directories for local installs
  fs.mkdirSync(USER_DIR, { recursive: true, mode: 0o700 });
  console.log(`
agents-cli installed locally.
To complete setup, run: npx agents setup
`);
  process.exit(0);
}

// Create directories. The full migration (legacy ~/.agents-system/ fold,
// runtime-state bucket moves, etc.) runs from src/lib/migrate.ts on the first
// CLI invocation — we don't duplicate it here.
//
// SYSTEM_DIR is intentionally NOT pre-created: if a legacy ~/.agents-system/
// exists, the migrator's fast-path rename needs SYSTEM_DIR to be absent so it
// can move the legacy tree in one shot (including .git). Pre-creating an empty
// skeleton forces the slower merge path AND can leave the new dir without
// `.git`, which makes ensureInitialized() exit "not set up" before the
// migrator runs. The migrator + first `agents setup` create SYSTEM_DIR as
// needed.
fs.mkdirSync(USER_DIR, { recursive: true, mode: 0o700 });
fs.mkdirSync(SHIMS_DIR, { recursive: true });

const shellName = path.basename(process.env.SHELL || '/bin/bash');

function getShellRc() {
  switch (shellName) {
    case 'zsh':
      return path.join(HOME, '.zshrc');
    case 'fish':
      return path.join(HOME, '.config', 'fish', 'config.fish');
    case 'bash':
      const bashProfile = path.join(HOME, '.bash_profile');
      if (fs.existsSync(bashProfile)) {
        return bashProfile;
      }
      return path.join(HOME, '.bashrc');
    default:
      return path.join(HOME, '.profile');
  }
}

const exportLine = shellName === 'fish'
  ? `fish_add_path ${SHIMS_DIR}`
  : `export PATH="${SHIMS_DIR}:$PATH"`;

function getVersion() {
  const pkgPath = new URL('../package.json', import.meta.url).pathname;
  try {
    return JSON.parse(fs.readFileSync(pkgPath, 'utf-8')).version;
  } catch { return null; }
}

function getChangelogSection(version) {
  const changelogPath = new URL('../CHANGELOG.md', import.meta.url).pathname;
  if (!fs.existsSync(changelogPath)) return null;
  const lines = fs.readFileSync(changelogPath, 'utf-8').split('\n');
  let inSection = false;
  const section = [];
  for (const line of lines) {
    if (line.startsWith(`## ${version}`)) { inSection = true; continue; }
    if (inSection && line.startsWith('## ')) break;
    if (inSection) section.push(line);
  }
  return section.length ? section.join('\n').trim() : null;
}

function ask(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

function isAlreadyConfigured(rcFile) {
  if (!fs.existsSync(rcFile)) return false;
  const content = fs.readFileSync(rcFile, 'utf-8');
  // Accept either the new path or the legacy ~/.agents-system/shims path
  return content.includes('.agents/.cache/shims') || content.includes('.agents-system/shims');
}

async function main() {
  // Windows has no shell rc files to edit. Write the `.cmd` shorthands here, then
  // make sure npm's global-bin dir is on the User PATH so the `agents` command
  // itself resolves: Node's installer normally adds it, but winget / portable /
  // nvm-windows setups often don't — and then `npm i -g` succeeds yet `agents`
  // is "not recognized". The shims dir (claude/codex/...) is still left to
  // `agents setup`, which the user can now run because `agents` is discoverable.
  if (process.platform === 'win32') {
    console.log(`\nagents-cli installed.`);
    const written = writeAliasShims();
    console.log(`  Installed shorthands: ${written.join(', ')}`);

    // Best-effort: import the platform leaf module from the just-installed dist.
    // If it's missing or PowerShell is unavailable we degrade to plain guidance.
    try {
      const { prependToWindowsUserPath, getEffectiveExecutionPolicy, blocksLocalScripts, npmGlobalBinFromEntry } =
        await import('../dist/lib/platform/winpath.js');

      const npmBinDir = npmGlobalBinFromEntry(AGENTS_BIN);
      const pathResult = prependToWindowsUserPath(npmBinDir);
      if (pathResult.success && !pathResult.alreadyPresent) {
        console.log(`  Added npm's global bin to your user PATH so 'agents' resolves:\n    ${npmBinDir}`);
      } else if (!pathResult.success) {
        console.log(`  Could not update PATH automatically. Add this to your user PATH manually:\n    ${npmBinDir}`);
      }

      // .ps1 launchers (npm.ps1, agents.ps1) are blocked under Restricted/AllSigned;
      // we can't safely weaken a security setting from an installer, so guide instead.
      const policy = getEffectiveExecutionPolicy();
      if (blocksLocalScripts(policy)) {
        console.log(`\n  PowerShell execution policy is '${policy}', which blocks the 'agents' launcher (a .ps1).`);
        console.log(`  Allow local scripts for your user:`);
        console.log(`    Set-ExecutionPolicy -Scope CurrentUser RemoteSigned`);
      }
    } catch {
      /* dist or PowerShell unavailable — skip; `agents setup` still wires shims */
    }

    console.log(`\nNext: open a new terminal, then run  agents setup`);
    console.log(`(adds the shims dir so bare ${ALIASES.join(', ')} and versioned aliases work).`);
  }
  // Opt-in: AGENTS_INIT_SHELL=1 npm install -g @phnx-labs/agents-cli
  else if (process.env.AGENTS_INIT_SHELL === '1') {
    const rcFile = getShellRc();
    if (!isAlreadyConfigured(rcFile)) {
      const addition = `\n# agents-cli: version switching for AI coding agents\n${exportLine}\n`;
      fs.mkdirSync(path.dirname(rcFile), { recursive: true });
      fs.appendFileSync(rcFile, addition);
      console.log(`\n  Added ${SHIMS_DIR} to PATH in ${path.basename(rcFile)}`);
      console.log(`  Restart your shell to enable version switching\n`);
    }
    writeAliasShims();
    console.log(`  Installed bare-command aliases: ${ALIASES.join(', ')}\n`);
  } else {
    // Default: offer to auto-add shims to PATH (like homebrew does)
    const rcFile = getShellRc();

    console.log(`\nagents-cli installed.`);

    if (!isAlreadyConfigured(rcFile) && process.stdin.isTTY && process.stdout.isTTY) {
      const answer = await ask(`\nAdd shims to PATH in ~/${path.basename(rcFile)}? [Y/n] `);
      if (answer === '' || answer.toLowerCase() === 'y' || answer.toLowerCase() === 'yes') {
        const addition = `\n# agents-cli: version switching for AI coding agents\n${exportLine}\n`;
        fs.mkdirSync(path.dirname(rcFile), { recursive: true });
        fs.appendFileSync(rcFile, addition);
        console.log(`\n  Added ${SHIMS_DIR} to PATH in ${path.basename(rcFile)}`);
        console.log(`  Restart your shell or run: source ~/${path.basename(rcFile)}\n`);
      } else {
        console.log(`
To enable version-aware shims, add this to your shell config:

  ${exportLine}
`);
      }
    } else if (!isAlreadyConfigured(rcFile)) {
      console.log(`
To enable version-aware shims, add this to your shell config:

  ${exportLine}
`);
    }

    const written = writeAliasShims();
    console.log(`  Installed shorthands: ${written.join(', ')}`);
  }

  if (process.platform !== 'win32') {
    await ensureAgentsResolvablePosix();
  }

  await healLongRunningProcesses();

  const version = getVersion();
  if (version) {
    const section = getChangelogSection(version);
    if (section) {
      console.log(`\nWhat's new in ${version}:\n`);
      console.log(section);
      console.log('');
    }
  }
}

/**
 * Make the `agents` command resolvable in a *login* shell on POSIX.
 *
 * `agents`/`ag` reach PATH only through npm's bin symlink in the npm global-bin
 * dir. Under nvm (and other per-user node prefixes) that dir is missing from a
 * non-interactive login shell's PATH, so `bash -lc 'agents …'` fails with
 * command-not-found — which breaks `agents secrets export --host` (it runs
 * `bash -lc 'agents secrets import …'` on the remote) and the routines daemon
 * (src/lib/daemon/daemon.ts falls back to bare `agents`). This is the POSIX symmetric
 * counterpart of the Windows branch in main() that registers npm's global-bin
 * dir on the user PATH.
 *
 * Self-heal, not a prompt: it fires ONLY when `agents` is otherwise
 * unresolvable — the genuinely-broken state — so it acts decisively, exactly
 * like the Windows PATH registration. The symlink never clobbers a dev build
 * (scripts/install.sh) or any real file. Skipped in CI (ephemeral homes) and
 * when AGENTS_NO_HEAL=1.
 */
async function ensureAgentsResolvablePosix() {
  if (process.env.CI || process.env.AGENTS_NO_HEAL === '1') return;
  retargetManagedLinksToNativeBin();
  try {
    const { localBinDir, ensureLocalBinSymlink, loginShellResolves, dirOnLoginPath } =
      await import('../dist/lib/platform/posixpath.js');

    // macOS/homebrew, system-node Linux, and dev-build users already resolve it.
    if (loginShellResolves('agents')) return;

    const binDir = localBinDir();
    const results = ['agents', 'ag'].map((name) => ensureLocalBinSymlink(name, AGENTS_BIN, binDir));
    if (!results.some((r) => r.created)) return; // nothing we could safely link

    if (dirOnLoginPath(binDir)) {
      console.log(`\n  Linked 'agents' into ${binDir} (already on the login PATH) so 'bash -lc agents' resolves.`);
      return;
    }

    // ~/.local/bin isn't on the *bash* login PATH yet. The consumers run
    // `bash -lc`, so add it to the file a bash login shell reads (~/.bash_profile
    // when present, else ~/.profile) — not the interactive $SHELL rc, which for a
    // zsh user (.zshrc) bash would never source.
    const bashRc = fs.existsSync(path.join(HOME, '.bash_profile'))
      ? path.join(HOME, '.bash_profile')
      : path.join(HOME, '.profile');
    const marker = '# agents-cli: ensure ~/.local/bin on PATH (so the agents command resolves)';
    let already = false;
    try {
      already = fs.existsSync(bashRc) && fs.readFileSync(bashRc, 'utf-8').includes(marker);
    } catch { /* unreadable rc — fall through and append */ }
    if (!already) {
      fs.appendFileSync(bashRc, `\n${marker}\nexport PATH="${binDir}:$PATH"\n`);
    }
    console.log(`\n  Linked 'agents' into ${binDir} and added it to PATH in ${path.basename(bashRc)}.`);
    console.log(`  Restart your shell (or run: source ~/${path.basename(bashRc)}) to pick it up.`);
  } catch {
    /* best-effort: a failure here must never break the install */
  }
}

/**
 * Upgrade path for #315: an earlier install symlinked ~/.local/bin/agents at
 * the JS entrypoint. ensureLocalBinSymlink never repoints an existing link,
 * and the loginShellResolves() early-return means ensureAgentsResolvablePosix
 * would not even try - so without this, a machine healed before the signed
 * binary existed keeps the unsigned JS shim forever. Repoint ONLY symlinks
 * that resolve exactly to OUR dist/index.js; a dev build or foreign link is
 * never touched.
 */
function retargetManagedLinksToNativeBin() {
  if (AGENTS_BIN === AGENTS_JS_ENTRYPOINT) return;
  const binDir = path.join(HOME, '.local', 'bin');
  // Compare realpaths: dist/index.js can be reached through path aliases
  // (/var vs /private/var on macOS) depending on who created the link.
  let want = AGENTS_JS_ENTRYPOINT;
  try { want = fs.realpathSync(AGENTS_JS_ENTRYPOINT); } catch { /* keep the literal path */ }
  for (const name of ['agents', 'ag']) {
    const linkPath = path.join(binDir, name);
    try {
      const current = fs.readlinkSync(linkPath); // throws unless a symlink
      let resolved = path.isAbsolute(current) ? current : path.resolve(binDir, current);
      try { resolved = fs.realpathSync(resolved); } catch { /* dangling - compare as-is */ }
      if (resolved !== want) continue;
      fs.unlinkSync(linkPath);
      fs.symlinkSync(AGENTS_BIN, linkPath);
      console.log(`  Repointed ${linkPath} at the signed agents binary.`);
    } catch {
      /* absent, unreadable, or not a symlink - nothing to retarget */
    }
  }
}

/**
 * Self-heal long-running processes onto the just-installed code (darwin + linux).
 *
 * The root cause behind stale-behavior bugs is a daemon/broker that keeps
 * running pre-upgrade code for days. An in-place `npm i -g` swaps the files but
 * not the running processes — so we bounce them here, the one moment we know the
 * code just changed. Always start (or restart) the supervised daemon so a fresh
 * install gets launchd/systemd KeepAlive without waiting for routines add.
 * Best-effort and non-fatal: a failure must never break the install. Skipped in
 * CI and when AGENTS_NO_HEAL=1. Windows is out of scope (detached-only, no KeepAlive).
 */
async function healLongRunningProcesses() {
  if (process.platform !== 'darwin' && process.platform !== 'linux') return;
  if (process.env.CI || process.env.AGENTS_NO_HEAL === '1') return;

  // Retire the legacy standalone secrets-agent service FIRST (#416 step 2) so
  // that when the daemon (re)starts below its coexistence guard sees no
  // standalone broker and hosts the broker socket itself. No-op if no legacy
  // plist is present; never blocks. Darwin-only in practice (launchd service).
  try {
    const a = await import('../dist/lib/secrets/agent.js');
    if (a.secretsAgentServiceInstalled?.()) {
      a.retireLegacySecretsAgentService?.();
      console.log('  Retired the standalone secrets-agent service — the daemon now hosts the broker.');
    }
  } catch { /* best effort */ }

  // Always (re)start so first install writes the LaunchAgent/systemd unit and
  // upgrades bounce onto the new binary — but honor daemon.enabled for cold
  // starts (SING-4a). If it was already running under a disable, stop and leave
  // it down so upgrade does not resurrect a killed switch.
  try {
    const d = await import('../dist/lib/daemon/daemon.js');
    const { isDaemonEnabled } = await import('../dist/lib/device-config.js');
    const wasRunning = Boolean(d.isDaemonRunning?.());
    const enabled = typeof isDaemonEnabled === 'function' ? isDaemonEnabled() : true;
    if (wasRunning) {
      d.stopDaemon?.();
      if (enabled) {
        d.startDaemon?.(AGENTS_BIN);
        console.log('  Restarted the routines daemon onto this version.');
      } else {
        console.log('  Stopped the routines daemon (daemon.enabled=false — not restarted).');
      }
    } else if (enabled) {
      d.startDaemon?.(AGENTS_BIN);
      console.log('  Started the always-on agents daemon.');
    }
  } catch { /* best effort */ }
}

main().catch((err) => {
  console.error(err);
  process.exit(0);
});
