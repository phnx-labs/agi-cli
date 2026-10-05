#!/usr/bin/env node
// Runs after npm install -g @phnx-labs/agents-cli.

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as readline from 'readline';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';

const HOME = os.homedir();
const USER_DIR = path.join(HOME, '.agents');
const SHIMS_DIR = path.join(USER_DIR, '.cache', 'shims');
const SYSTEM_DIR = path.join(USER_DIR, '.system');
const AGENTS_JS_ENTRYPOINT = fileURLToPath(new URL('../dist/index.js', import.meta.url));
const AGENTS_NATIVE_MACOS_BIN = fileURLToPath(new URL('../dist/bin/agents', import.meta.url));
const AGENTS_BIN = resolveAgentsBin();

function resolveAgentsBin() {
  if (process.platform !== 'darwin') return AGENTS_JS_ENTRYPOINT;
  try {
    fs.accessSync(AGENTS_NATIVE_MACOS_BIN, fs.constants.X_OK);
  } catch {
    return AGENTS_JS_ENTRYPOINT;
  }
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

const ALIASES = ['teams'];

// Aliases this script used to write and must now remove on every install: `secrets` (PHNX-3989),
// `sessions` (PHNX-4012), `pty` (PHNX-4091), `browser` (PHNX-4101), which belong to standalone
// CLIs now. Postinstall is the upgrade path that runs, so it prunes here.
const RETIRED_ALIASES = ['secrets', 'sessions', 'pty', 'browser'];

function removeRetiredAliasShims() {
  for (const name of RETIRED_ALIASES) {
    for (const file of [path.join(SHIMS_DIR, name), path.join(SHIMS_DIR, name + '.cmd')]) {
      let content;
      try {
        content = fs.readFileSync(file, 'utf8');
      } catch {
        continue;
      }
      // Remove only our own alias: the POSIX shim ends in `<name> "$@"`, the Windows companion in
      // `<name> %*`. Never an unrelated file under that name, nor a user's own `agents setup
      // alias` shim (marked `# Alias shim:`, as pruneOrphanedCommandShim also keeps).
      if (content.includes('# Alias shim:')) continue;
      if (!content.includes(`${name} "$@"`) && !content.includes(`${name} %*`)) continue;
      fs.rmSync(file, { force: true });
    }
  }
}

function writeAliasShims() {
  removeRetiredAliasShims();
  const written = [];
  for (const name of ALIASES) {
    const target = path.join(SHIMS_DIR, name);
    const script = `#!/bin/sh\nAGENTS_BIN=${shellQuote(AGENTS_BIN)}\nif [ -z "$AGENTS_BIN" ] || [ ! -x "$AGENTS_BIN" ]; then\n  echo "agents: agents-cli entrypoint missing or not executable: $AGENTS_BIN" >&2\n  exit 127\nfi\nexec "$AGENTS_BIN" ${name} "$@"\n`;
    fs.writeFileSync(target, script, { mode: 0o755 });
    if (process.platform === 'win32') {
      fs.writeFileSync(target + '.cmd', `@echo off\r\nnode "${AGENTS_BIN}" ${name} %*\r\n`);
    }
    written.push(name);
  }
  return written;
}

// Self-updater entry: the upgrade installs with --ignore-scripts, then re-invokes this script with
// this env var so alias shims refresh from the newly installed copy. Shims only: no prompts,
// rc-file edits or output.
if (process.env.AGENTS_POSTINSTALL_SHIMS_ONLY === '1') {
  fs.mkdirSync(SHIMS_DIR, { recursive: true });
  writeAliasShims();
  process.exit(0);
}

const isGlobalInstall = process.env.npm_config_global || process.argv.includes('-g');
if (!isGlobalInstall) {
  fs.mkdirSync(USER_DIR, { recursive: true, mode: 0o700 });
  console.log(`
agents-cli installed locally.
To complete setup, run: npx agents setup
`);
  process.exit(0);
}

// Create directories only; the full migration (legacy ~/.agents-system/ fold, state bucket moves)
// runs from src/lib/migrate.ts on first CLI invocation. SYSTEM_DIR is intentionally NOT created:
// the migrator's fast-path rename of a legacy ~/.agents-system/ (with .git) needs it absent.
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
  return content.includes('.agents/.cache/shims') || content.includes('.agents-system/shims');
}

async function main() {
  // Windows has no rc files to edit: write the `.cmd` shorthands, then ensure npm's global-bin dir
  // is on the User PATH so `agents` resolves (winget/portable/nvm-windows setups often lack it, so
  // `npm i -g` succeeds yet `agents` is "not recognized").
  if (process.platform === 'win32') {
    console.log(`\nagents-cli installed.`);
    const written = writeAliasShims();
    console.log(`  Installed shorthands: ${written.join(', ')}`);

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

      const policy = getEffectiveExecutionPolicy();
      if (blocksLocalScripts(policy)) {
        console.log(`\n  PowerShell execution policy is '${policy}', which blocks the 'agents' launcher (a .ps1).`);
        console.log(`  Allow local scripts for your user:`);
        console.log(`    Set-ExecutionPolicy -Scope CurrentUser RemoteSigned`);
      }
    } catch {
    }

    console.log(`\nNext: open a new terminal, then run  agents setup`);
    console.log(`(adds the shims dir so bare ${ALIASES.join(', ')} and versioned aliases work).`);
  }
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

/** Make `agents` resolvable in a login shell on POSIX. It reaches PATH only through npm's
 * global-bin symlink, which under nvm is missing from a non-interactive login PATH, so `bash -lc
 * 'agents ...'` fails (breaking `agents secrets export --host` and the routines daemon). */
async function ensureAgentsResolvablePosix() {
  if (process.env.CI || process.env.AGENTS_NO_HEAL === '1') return;
  retargetManagedLinksToNativeBin();
  try {
    const { localBinDir, ensureLocalBinSymlink, loginShellResolves, dirOnLoginPath } =
      await import('../dist/lib/platform/posixpath.js');

    if (loginShellResolves('agents')) return;

    const binDir = localBinDir();
    const results = ['agents', 'ag'].map((name) => ensureLocalBinSymlink(name, AGENTS_BIN, binDir));
    if (!results.some((r) => r.created)) return;

    if (dirOnLoginPath(binDir)) {
      console.log(`\n  Linked 'agents' into ${binDir} (already on the login PATH) so 'bash -lc agents' resolves.`);
      return;
    }

    // ~/.local/bin is not on the bash login PATH yet. Consumers run `bash -lc`, so add it to the
    // file a bash login shell reads (~/.bash_profile if present, else ~/.profile), not the
    // interactive $SHELL rc (a zsh user's .zshrc, which bash never sources).
    const bashRc = fs.existsSync(path.join(HOME, '.bash_profile'))
      ? path.join(HOME, '.bash_profile')
      : path.join(HOME, '.profile');
    const marker = '# agents-cli: ensure ~/.local/bin on PATH (so the agents command resolves)';
    let already = false;
    try {
      already = fs.existsSync(bashRc) && fs.readFileSync(bashRc, 'utf-8').includes(marker);
    } catch {  }
    if (!already) {
      fs.appendFileSync(bashRc, `\n${marker}\nexport PATH="${binDir}:$PATH"\n`);
    }
    console.log(`\n  Linked 'agents' into ${binDir} and added it to PATH in ${path.basename(bashRc)}.`);
    console.log(`  Restart your shell (or run: source ~/${path.basename(bashRc)}) to pick it up.`);
  } catch {
  }
}

/** Upgrade path for #315: an earlier install symlinked ~/.local/bin/agents at the JS entrypoint,
 * ensureLocalBinSymlink never repoints an existing link, and the loginShellResolves() early-return
 * stops ensureAgentsResolvablePosix, so a machine healed earlier keeps the unsigned JS shim. */
function retargetManagedLinksToNativeBin() {
  if (AGENTS_BIN === AGENTS_JS_ENTRYPOINT) return;
  const binDir = path.join(HOME, '.local', 'bin');
  let want = AGENTS_JS_ENTRYPOINT;
  try { want = fs.realpathSync(AGENTS_JS_ENTRYPOINT); } catch {  }
  for (const name of ['agents', 'ag']) {
    const linkPath = path.join(binDir, name);
    try {
      const current = fs.readlinkSync(linkPath);
      let resolved = path.isAbsolute(current) ? current : path.resolve(binDir, current);
      try { resolved = fs.realpathSync(resolved); } catch {  }
      if (resolved !== want) continue;
      fs.unlinkSync(linkPath);
      fs.symlinkSync(AGENTS_BIN, linkPath);
      console.log(`  Repointed ${linkPath} at the signed agents binary.`);
    } catch {
    }
  }
}

/** Self-heal long-running processes onto the just-installed code (darwin + linux): `npm i -g` swaps
 * files but not a daemon running old code, so bounce it here (not the secrets broker, PHNX-3989).
 * Best-effort: it must never break the install; skipped in CI and when AGENTS_NO_HEAL=1. */
async function healLongRunningProcesses() {
  if (process.platform !== 'darwin' && process.platform !== 'linux') return;
  if (process.env.CI || process.env.AGENTS_NO_HEAL === '1') return;

  // Always (re)start so first install writes the LaunchAgent/systemd unit and upgrades bounce onto
  // the new binary, but honor daemon.enabled for cold starts (SING-4a): if it was running under a
  // disable, stop it so an upgrade does not resurrect a killed switch.
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
  } catch {  }
}

main().catch((err) => {
  console.error(err);
  process.exit(0);
});
