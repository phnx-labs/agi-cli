/**
 * Full CLI bootstrap — loaded only after index.ts's argv fast paths miss.
 *
 * RUSH-2335: `src/index.ts` is a slim shell that statically imports only the
 * leaf `lib/secrets/sync-commands.js` so `__secrets-*` / `__vault-age-helper` /
 * `__shim` / `__daemon-run` can exit without evaluating the
 * commander + self-update + command-registry graph (~140ms saved per
 * synchronous broker read). Everything below that shell lands here via
 * `await import('./bootstrap.js')`.
 *
 * This module is the previous body of `index.ts` (command registration, update
 * checks, first-run setup, migrations, parse). Side-effecting top-level code
 * runs on import — that is intentional.
 */

import { Command } from 'commander';
import chalk from 'chalk';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { detectDevBuild } from './lib/startup/dev-build.js';
import { configureRootCommand } from './lib/startup/root-command.js';
import { bootMark } from './lib/boot-profile.js';
// `ora`, `@inquirer/prompts`, `./commands/utils.js`, and the agents/versions/shims
// modules are imported dynamically at their use sites: they are needed only on
// interactive / update / shim-repair paths, never for fast commands like
// `--version`, `--help`, or `view`. Keeping them off the module-eval path is
// what gets cold starts under the target.

// Get version from package.json
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const packageJsonPath = path.join(__dirname, '..', 'package.json');
const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8'));
const VERSION = packageJson.version;

import {
  NPM_PACKAGE_NAME,
  deriveGlobalPrefix,
  detectPackageManager,
  ensureGlobalBinLinks,
  installPackageIntoPrefix,
  installPackageWithBun,
  verifyInstalledVersion,
  refreshAliasShims,
  downloadVerifiedTarball,
  sweepStaleInstallStaging,
} from './lib/self-update.js';
import { registerUpgradeCommand, type UpgradeOptions } from './commands/upgrade.js';

interface NpmPackageMetadata {
  version: string;
  integrity: string;
  tarball: string;
}

// Detect dev/working-tree builds and default the noisy startup steps off.
// Three cases trip this:
//   1. Dev install (scripts/install.sh) — package.json version stamped 0.0.0-dev.<sha>
//   2. Running `node dist/index.js` from a working tree — repo root has .git/
//   3. Running tsx/ts-node from src/ — also has .git/ at the repo root
// For all three: skip auto-pull (no network noise + no surprise FF on the
// system repo while iterating), skip migration (a buggy in-progress migration
// must not scribble on the user's real ~/.agents/), and skip the update prompt
// (the "0.0.0-dev -> 1.x.y" message is misleading). Each individual env var
// can still be set explicitly to override (set to '0' to re-enable).
const IS_DEV_BUILD: boolean = detectDevBuild(process.argv[1] || '', VERSION);
if (IS_DEV_BUILD) {
  if (process.env.AGENTS_NO_AUTOPULL === undefined) process.env.AGENTS_NO_AUTOPULL = '1';
  if (process.env.AGENTS_SKIP_MIGRATION === undefined) process.env.AGENTS_SKIP_MIGRATION = '1';
  if (process.env.AGENTS_CLI_DISABLE_AUTO_UPDATE === undefined) process.env.AGENTS_CLI_DISABLE_AUTO_UPDATE = '1';
}

// Command registration is lazy: instead of statically importing every command
// module on each invocation (which loaded the whole ~50-module tree before the
// first byte of output), the registry maps a command name to a thunk that
// imports only what that command needs. See src/cli/command-registry.ts.
// Individual load* registrars are not imported here — registerEagerForRequest
// and the lazy path pull them via COMMAND_LOADERS. The full-tree
// registerAllEagerCommands path was removed (RUSH-2329): unknown/typo commands
// spellcheck against KNOWN_TOP_LEVEL_COMMANDS and register only the corrected
// name.
import {
  COMMAND_LOADERS,
  LAZY_COMMAND_NAMES,
  KNOWN_TOP_LEVEL_COMMANDS,
  RETIRED_TOP_LEVEL_COMMANDS,
  registerAllCommands,
  type ModuleLoader,
} from './cli/command-registry.js';
import { closestTopLevelCommand } from './lib/startup/spellcheck.js';
import {
  applyGlobalHelpConventions,
  FRONT_DOOR_COMMAND_GROUPS,
  registerCommandGroups,
  setCompactRootHelp,
} from './lib/help.js';
import { renderWhatsNew } from './lib/whats-new.js';
import { IS_WINDOWS } from './lib/platform/index.js';
import { getCliLaunch } from './lib/cli-entry.js';
import { emit, emitFriction, redactArgs } from './lib/feed/events.js';
import { stampProvenance } from './lib/event-provenance.js';
import { die } from './lib/format.js';
// Leaf (zero imports). Gates the dynamic passthrough import so the ~187ms
// hosts graph is never loaded when no routing flag is present (RUSH-2374).
import { hasHostRoutingFlag } from './lib/hosts/routing-flag.js';

// White-label: the shim for a brand (e.g. `jack`) exports AGENTS_BRAND, so the
// CLI presents its own name/help/errors as the brand. Unbranded (AGENTS_BRAND
// unset) resolves to 'agents' and everything below is byte-identical to before.
const BRAND = resolveBrandName();

const program = configureRootCommand(new Command(), BRAND, VERSION);
registerCommandGroups(program, FRONT_DOOR_COMMAND_GROUPS);
program.option('--help-all', 'Show help for all commands');

// ─── Audit backbone ────────────────────────────────────────────────────────────
// One choke point logs every `agents <module> <cmd>` invocation to the structured
// event log — so team create/disband, agent run, secrets access, and everything
// else is captured generically (with SSH/remote-user attribution added in emit()),
// no per-command wiring. `agents events` reads it back. Attached to the root
// program, so it's inherited by every subcommand regardless of lazy registration.

/** Command path from the acting command up to (but excluding) the `agents` root. */
function auditCommandPath(cmd: Command): string[] {
  const parts: string[] = [];
  let c: Command | null | undefined = cmd;
  while (c && c.name() && c.name() !== BRAND) {
    parts.unshift(c.name());
    c = c.parent;
  }
  return parts;
}

const auditStarts = new WeakMap<Command, number>();

/**
 * Commands that WRITE the event stream, so recording their own invocation would
 * add records to the log they are writing into. `events emit` is batched — one
 * flush every few seconds per open editor window — so auditing it would bury the
 * real events under two `command.*` records per flush. `_internal friction`
 * exists for the same reason (shell guards fire before any `agents` process
 * exists, so they cannot emit in-process) and had the same self-logging bug.
 */
const AUDIT_EXEMPT_COMMANDS: ReadonlySet<string> = new Set([
  'events emit',
  '_internal friction',
]);

program.hook('preAction', (_thisCommand, actionCommand) => {
  try {
    const parts = auditCommandPath(actionCommand);
    if (parts.length === 0) return;
    if (AUDIT_EXEMPT_COMMANDS.has(parts.join(' '))) return;
    auditStarts.set(actionCommand, Date.now());
    emit('command.start', {
      module: parts[0],
      command: parts.join(' '),
      // Commander exposes positional operands in actionCommand.args but omits
      // parsed option values. Audit the real argv so sensitive flags are seen
      // and redacted instead of silently bypassing the policy.
      args: redactArgs(process.argv.slice(2, 22)),
      cwd: process.cwd(),
    });
  } catch {
    // Audit logging must never break command dispatch.
  }
});

program.hook('postAction', (_thisCommand, actionCommand) => {
  try {
    const parts = auditCommandPath(actionCommand);
    if (parts.length === 0) return;
    if (AUDIT_EXEMPT_COMMANDS.has(parts.join(' '))) return;
    const started = auditStarts.get(actionCommand);
    const durationMs = started !== undefined ? Date.now() - started : undefined;
    const command = parts.join(' ');
    emit('command.end', {
      module: parts[0],
      command,
      ...(durationMs !== undefined ? { durationMs } : {}),
    });
    if (parts[0] === 'run') {
      const agentName = actionCommand.args?.[0] ? String(actionCommand.args[0]).split('@')[0] : 'run';
      void import('./lib/analytics/usage-db.js').then(({ recordUsage }) => {
        recordUsage({
          kind: 'agent',
          name: agentName || 'run',
          event: 'invoke',
          source: 'cli',
          meta: durationMs !== undefined ? { durationMs } : undefined,
        });
      }).catch(() => { /* fail soft */ });
    }
    // Disposable perf warehouse — fail-soft spool append (no SQLite on this path).
    // Skip the perf reader itself (now `agents insights perf`, PHNX-3391) so it
    // never records its own latency into the board it prints.
    if (durationMs !== undefined && !(parts[0] === 'insights' && parts[1] === 'perf')) {
      // sessionId/agent are resolvable here the same way emit() resolves them
      // for command.start/command.end above (the shared provenance floor,
      // event-provenance.ts) — without this, every command.end perf sample
      // was anonymous, unlike the audit log record right next to it.
      const { sessionId, agent } = stampProvenance();
      void import('./lib/perf/spool.js').then(({ recordSample }) => {
        recordSample({
          kind: 'command.end',
          label: command,
          durationMs,
          cwd: process.cwd(),
          sessionId,
          agent,
        });
      }).catch(() => { /* fail soft */ });
    }
  } catch {
    // Best-effort completion record; the start line is the durable audit fact.
  }
});

/** Compare two semver version strings. Returns 1 if a > b, -1 if a < b, 0 if equal. */
function compareVersions(a: string, b: string): number {
  const partsA = a.split('.').map(Number);
  const partsB = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if (partsA[i] > partsB[i]) return 1;
    if (partsA[i] < partsB[i]) return -1;
  }
  return 0;
}

/** Fetch and display changelog entries between two versions from unpkg. */
async function showWhatsNew(fromVersion: string, toVersion: string): Promise<void> {
  try {
    const response = await fetch(`https://unpkg.com/@phnx-labs/agents-cli@${toVersion}/CHANGELOG.md`);
    if (!response.ok) return;

    const relevantChanges = renderWhatsNew(await response.text(), fromVersion, toVersion);

    if (relevantChanges.length > 0) {
      console.log(chalk.bold("\nWhat's new:\n"));
      for (const line of relevantChanges) {
        console.log(line);
      }
      console.log(chalk.gray('\nFull notes: https://github.com/phnx-labs/agi-cli/blob/main/CHANGELOG.md'));
      console.log();
    }
  } catch {
    // Silently ignore changelog fetch errors
  }
}

const UPDATE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours
import { getUpdateCheckPath, getMigratedSentinelPath, getUserAgentsDir, getRuntimeStateDir } from './lib/state.js';
import { resolveBrandName, disabledCommandsForActiveBrand } from './lib/brand.js';
import {
  readUpdateCache,
  saveUpdateCheck,
  dismissUpdateVersion,
  shouldPromptUpgrade,
  resolveMultiInstallInventory,
  remediateStaleAgentsCliInstalls,
  resolveRunningPackageRoot,
  manualUninstallCommand,
  type UpdateCheckCache,
} from './lib/self-update.js';
const UPDATE_CHECK_FILE = getUpdateCheckPath();
// Beside the existing update-check cache (RUSH-2324): short-TTL memo of the
// multi-install PATH scan so every ordinary CLI invocation does not re-walk
// PATH + known install roots (~1ms warm).
const MULTI_INSTALL_SCAN_FILE = path.join(path.dirname(UPDATE_CHECK_FILE), '.multi-install-scan');

/**
 * Warn once when this machine contains a different agents-cli install than the
 * copy that is currently running (or several). Divergent installs
 * are how self-updates "succeed" without changing the command the user types.
 * The warning re-fires only when the set of install roots or their helper-copy
 * safety changes. Dev builds are included because old dev copies can still
 * overwrite the shared macOS helper bundle non-atomically.
 */
function maybeWarnMultiInstall(): void {
  const sentinel = path.join(getRuntimeStateDir(), 'multi-install-warned');
  let runningRoot: string;
  try {
    runningRoot = resolveRunningPackageRoot(__dirname);
  } catch {
    // Without a real root for the running copy there is nothing to compare
    // against, and a guess here is exactly what produced the phantom
    // "/$bunfs" install. This warning is advisory — stay silent instead.
    return;
  }
  // RUSH-2324: resolve via the short-TTL scan cache beside `.update-check`.
  // Fresh cache → skip findAgentsCliInstalls (~1ms PATH walk).
  const inventory = resolveMultiInstallInventory(
    runningRoot,
    VERSION,
    process.env.PATH || '',
    MULTI_INSTALL_SCAN_FILE,
  );

  if (inventory.length < 2) {
    try { fs.unlinkSync(sentinel); } catch { /* nothing recorded */ }
    return;
  }

  const key = inventory
    .map((info) => `${info.packageRoot}\t${info.version}\t${info.note}`)
    .sort()
    .join('\n');
  try {
    if (fs.readFileSync(sentinel, 'utf-8') === key) return;
  } catch { /* not warned for this set yet */ }

  console.error(chalk.yellow('Multiple agents-cli installs detected:'));
  for (const info of inventory) {
    console.error(chalk.gray(`  ${info.packageRoot}  ${info.version}  (${info.note})`));
  }
  // RUSH-2705/2713: only advertise `agents doctor --fix` for copies it will
  // really delete. A duplicate --fix won't auto-purge (a healthy >=1.22.30 peer,
  // OR a pre-1.22.30 copy left alone only because no fixed peer exists — the
  // latter is genuinely vulnerable, not healthy) makes --fix a remedy that
  // no-ops forever — name the manual removal command instead.
  const peers = inventory.filter((info) => !info.running);
  console.error(chalk.gray('Upgrades apply to the running copy.'));
  if (peers.some((info) => info.autoPurgeable)) {
    console.error(chalk.gray(
      'Purge npx-cache / legacy / pre-1.22.30 copies with: agents doctor --fix',
    ));
  }
  for (const peer of peers.filter((info) => !info.autoPurgeable)) {
    console.error(chalk.gray(
      `Remove the ${peer.version} copy at ${peer.packageRoot} with: ${manualUninstallCommand(peer.packageRoot)}`,
    ));
  }

  try {
    fs.mkdirSync(path.dirname(sentinel), { recursive: true });
    fs.writeFileSync(sentinel, key);
  } catch { /* best-effort; worst case the warning repeats */ }
}

/** Determine whether enough time has elapsed since the last registry fetch. */
function shouldFetchLatest(cache: UpdateCheckCache | null): boolean {
  if (!cache) return true;
  return Date.now() - cache.lastCheck > UPDATE_CHECK_INTERVAL_MS;
}

/** Fetch the exact latest npm version plus its registry integrity hash. */
async function fetchNpmPackageMetadata(versionOrTag = 'latest', timeoutMs = 5000): Promise<NpmPackageMetadata> {
  const response = await fetch(`https://registry.npmjs.org/${NPM_PACKAGE_NAME}/${versionOrTag}`, {
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) {
    if (response.status === 404) {
      throw new Error(`${NPM_PACKAGE_NAME}@${versionOrTag} not found on npm`);
    }
    throw new Error('Could not reach npm registry');
  }

  const data = await response.json() as {
    version?: unknown;
    dist?: { integrity?: unknown; tarball?: unknown };
  };
  if (
    typeof data.version !== 'string' ||
    typeof data.dist?.integrity !== 'string' ||
    typeof data.dist?.tarball !== 'string'
  ) {
    throw new Error('npm registry response did not include version, integrity, and tarball');
  }

  return { version: data.version, integrity: data.dist.integrity, tarball: data.dist.tarball };
}

function printResolvedPackage(metadata: NpmPackageMetadata): void {
  console.log(chalk.gray(`Resolved: ${NPM_PACKAGE_NAME}@${metadata.version}`));
  console.log(chalk.gray(`Integrity: ${metadata.integrity}`));
}

async function installResolvedPackage(metadata: NpmPackageMetadata): Promise<void> {
  const packageRoot = resolveRunningPackageRoot(__dirname);
  // Download the published tarball and prove its bytes match the registry
  // integrity BEFORE installing anything. A `name@version` spec would let the
  // package manager fetch and install whatever the registry serves with no
  // hash check on our side; instead we verify here and install the LOCAL, now
  // trusted .tgz. A mismatch throws and nothing below runs — fail closed.
  const tarball = await downloadVerifiedTarball(metadata.tarball, metadata.integrity);
  try {
    // Clear any orphaned npm reify staging dir from a prior crashed upgrade
    // BEFORE the package manager stages the new one (PHNX-3393) — otherwise
    // npm's rename onto that exact, deterministic path fails ENOTEMPTY and
    // every subsequent upgrade dead-ends there forever. bun does not use
    // npm's retire-path staging scheme, so this only needs to run once, ahead
    // of both package-manager branches below.
    await sweepStaleInstallStaging(packageRoot);
    // Upgrade with the package manager that owns this install. A bun global
    // install lives at <bunGlobalDir>/node_modules/... (no `lib` segment), so an
    // `npm install --prefix` would write to <bunGlobalDir>/lib/node_modules and
    // never touch the running copy — npm exits 0, the verify below fails.
    if (detectPackageManager(packageRoot) === 'bun') {
      await installPackageWithBun(tarball);
    } else {
      await installPackageIntoPrefix(tarball, deriveGlobalPrefix(packageRoot));
    }
  } finally {
    // Best-effort cleanup of the verified tarball and its temp dir.
    try {
      fs.rmSync(path.dirname(tarball), { recursive: true, force: true });
    } catch {
      /* leave it for the OS temp sweep */
    }
  }
  await verifyInstalledVersion(packageRoot, metadata.version);
  await refreshAliasShims(packageRoot);
  // PHNX-2768: the npm install above can leave the package at the new version
  // but the global bin links GONE — the state that stranded zion (package at
  // 1.22.40, `/opt/homebrew/bin/{agents,ag,browser,computer}` missing, every
  // `agents` invocation "command not found"). The upgrade OWNS those links, so
  // it restores any that npm dropped and fails LOUD when one cannot be made to
  // resolve — never returning a box the package upgraded but cannot run. Only
  // the npm-prefix POSIX layout has these symlinks; bun and Windows use their
  // own bin shims and are out of scope.
  if (detectPackageManager(packageRoot) !== 'bun' && process.platform !== 'win32') {
    const prefix = deriveGlobalPrefix(packageRoot);
    const repairs = await ensureGlobalBinLinks(packageRoot, prefix);
    const repaired = repairs.filter((r) => r.action === 'repaired');
    const failed = repairs.filter((r) => r.action === 'failed');
    if (repaired.length > 0) {
      console.error(
        chalk.yellow(
          `Relinked ${repaired.map((r) => r.name).join(', ')} in ${path.join(prefix, 'bin')} — the install left them missing.`,
        ),
      );
    }
    if (failed.length > 0) {
      const relink = failed
        .map((r) => `ln -sf ${path.relative(path.dirname(r.linkPath), r.target)} ${r.linkPath}`)
        .join(' && ');
      throw new Error(
        `upgraded to ${metadata.version} but could not restore the ` +
          `${failed.map((r) => r.name).join(', ')} command link${failed.length === 1 ? '' : 's'} in ` +
          `${path.join(prefix, 'bin')} (${failed.map((r) => r.error).join('; ')}). ` +
          `The box has the new package but no working \`agents\` — relink manually: ${relink}`,
      );
    }
  }
  // The npm install above runs with --ignore-scripts, so the postinstall that
  // installs the macOS Keychain helper never fires on upgrade. Force-refresh the
  // helper here so a user upgrading FROM a broken build (e.g. the entitlement-less
  // 1.20.4 helper that fails SecItemAdd with -34018) gets the fixed, signed bundle
  // immediately — instead of waiting for the lazy staleness check in
  // getKeychainHelperPath() to repair it on their next secret operation. The new
  // package is already on disk, so the dynamic import resolves the freshly-installed
  // helper module + bundle. Best-effort: an upgrade must never fail because the
  // helper could not be reinstalled (the lazy staleness check in
  // getKeychainHelperPath() still repairs it on the next secret operation).
  if (process.platform === 'darwin') {
    try {
      const { ensureKeychainHelperInstalledAsync } = await import('./lib/secrets/install-helper.js');
      // Async + download-capable: an upgrade to a tarball that dropped the
      // bundle fetches the verified release asset instead of no-op'ing.
      await ensureKeychainHelperInstalledAsync({ forceReinstall: true });
    } catch {
      // Non-fatal.
    }
  }
}

/** Present an interactive upgrade prompt (TTY) or a one-line hint (non-TTY). */
async function promptUpgrade(latestVersion: string): Promise<void> {
  const { default: ora } = await import('ora');
  const { confirm, select } = await import('@inquirer/prompts');
  const { isInteractiveTerminal, isPromptCancelled } = await import('./commands/utils.js');
  if (!isInteractiveTerminal()) {
    console.error(chalk.yellow(`Update available: ${VERSION} -> ${latestVersion}. Run: agents upgrade --yes`));
    return;
  }

  const answer = await select({
    message: `Update available: ${VERSION} -> ${latestVersion}`,
    choices: [
      { value: 'now', name: 'Upgrade now' },
      { value: 'later', name: 'Later' },
      { value: 'dismiss', name: `Skip ${latestVersion}` },
    ],
  });

  if (answer === 'dismiss') {
    dismissUpdateVersion(UPDATE_CHECK_FILE, latestVersion);
    return;
  }

  if (answer === 'now') {
    const { spawnSync } = await import('child_process');
    let spinner = ora('Resolving package metadata...').start();
    try {
      const metadata = await fetchNpmPackageMetadata();
      // The prompt showed the cached latest, which can lag the registry (the
      // 24h window) — sync the cache to what was actually resolved so later
      // prompts and the install agree on the same version.
      saveUpdateCheck(UPDATE_CHECK_FILE, metadata.version);
      spinner.succeed(`Resolved ${NPM_PACKAGE_NAME}@${metadata.version}`);
      printResolvedPackage(metadata);

      const approved = await confirm({
        message: `Install ${NPM_PACKAGE_NAME}@${metadata.version}?`,
        default: false,
      });
      if (!approved) {
        console.log(chalk.gray('Upgrade cancelled'));
        return;
      }

      spinner = ora('Upgrading...').start();
      await installResolvedPackage(metadata);
      spinner.succeed(`Upgraded to ${metadata.version}`);
      await showWhatsNew(VERSION, metadata.version);
      console.log();
      // Re-exec the verified install's entrypoint and exit. PATH lookup of
      // `agents` could resolve a different copy (dev build, another prefix)
      // than the one that was just upgraded. getCliLaunch resolves the JS-vs-
      // standalone shape — never hand-roll `[process.execPath, entrypoint]`,
      // which hands the bun virtual entry to a compiled binary as a bogus arg.
      const { command, args } = getCliLaunch(process.argv.slice(2));
      const result = spawnSync(command, args, {
        stdio: 'inherit',
        shell: false,
      });
      process.exit(result.status ?? 0);
    } catch (err) {
      if (isPromptCancelled(err)) return;
      spinner.fail(`Upgrade failed: ${err instanceof Error ? err.message : String(err)}`);
      console.log(chalk.gray('Run manually: agents upgrade --yes'));
    }
    console.log();
  }
}

/**
 * Background update check — fires once per 24h cache window.
 * Network: GET registry.npmjs.org/@phnx-labs/agents-cli/latest.
 * Disable: set AGENTS_CLI_DISABLE_AUTO_UPDATE=1 in shell rc.
 *
 * Fire-and-forget; never blocks the CLI's foreground operation.
 */
function refreshUpdateCacheInBackground(): void {
  fetch('https://registry.npmjs.org/@phnx-labs/agents-cli/latest', {
    signal: AbortSignal.timeout(2000),
  })
    .then((response) => (response.ok ? response.json() : null))
    .then((data) => {
      if (data && typeof (data as any).version === 'string') {
        saveUpdateCheck(UPDATE_CHECK_FILE, (data as any).version);
      }
    })
    .catch(() => {
      /* network error, try again next invocation */
    });
}

/** Check for available updates using the local cache. Triggers a background refresh if stale. */
async function checkForUpdates(): Promise<void> {
  if (process.env.AGENTS_CLI_DISABLE_AUTO_UPDATE) return;

  maybeWarnMultiInstall();

  const cache = readUpdateCache(UPDATE_CHECK_FILE);

  // Kick off network refresh in background if stale. Does not block.
  if (shouldFetchLatest(cache)) {
    refreshUpdateCacheInBackground();
  }

  // Prompt based on current cache (may be from a previous run's background refresh).
  // Skip if the user dismissed this exact version — they'll be prompted again when
  // a newer version appears.
  if (shouldPromptUpgrade(cache, VERSION)) {
    try {
      await promptUpgrade(cache!.latestVersion);
    } catch (err) {
      const { isPromptCancelled } = await import('./commands/utils.js');
      if (isPromptCancelled(err)) return;
      /* prompt error, ignore */
    }
  }
}

async function maybeBootstrapShimIntegration(
  requestedCommand: string | undefined,
  isDocumentationRequest: boolean,
  verboseStartup: boolean,
): Promise<void> {
  if (!verboseStartup && (!process.stdin.isTTY || !process.stdout.isTTY)) {
    return;
  }
  // Pure documentation paths must never trigger interactive repair — mirrors
  // the isDocumentationRequest gate around ensureInitialized below. Covers
  // both bare `agents --version` (requestedCommand === undefined) and
  // `agents <subcommand> --help` (requestedCommand === subcommand name).
  if (isDocumentationRequest) {
    return;
  }
  if (requestedCommand === 'sync' || requestedCommand === 'refresh-rules') {
    return;
  }

  // Past the documentation/non-TTY guards: heal the shim/shadow/PATH conditions
  // through the unified self-heal registry — the SAME checks the daemon runs, but
  // driven silently on this interactive invocation so a user who never starts the
  // daemon still gets healed. Regenerating stale shims, adopting symlink launchers,
  // and adding the shims dir to PATH now happen without any output. The only thing
  // that ever prints is a ONE-TIME notice for what a machine can't silently fix
  // (a real native binary shadowing the shim) or is worth saying once (a PATH entry
  // just added). Suppression is persistent and keyed to the condition — a new
  // terminal no longer re-nags (the old per-PPID sentinel did, every shell).
  const { runInteractiveShimHeal } = await import('./lib/shim-heal.js');
  const { summarizeSelfHeal } = await import('./lib/self-heal/registry.js');
  const { noticeLines, report } = await runInteractiveShimHeal();
  if (verboseStartup) {
    process.stderr.write(`[agents] startup self-heal: ${summarizeSelfHeal(report)}\n`);
  }
  if (noticeLines) {
    for (const line of noticeLines) console.log(chalk.gray(line));
  }
}

// --- Inline command registrars ----------------------------------------------
// These commands are defined here rather than in a command module because they
// close over entry-point-local state (program re-parsing, VERSION, the npm
// upgrade helpers). The lazy registrar and the all-commands fallback below both
// call them, so the behavior is identical to the old eager registration.

// memory is a first-class resource command (see commands/memory.ts via
// COMMAND_LOADERS). The old memory→rules tombstone was removed in RUSH-1330.

/** Deprecated `perms` alias — re-parses as `permissions`. */
function registerPermsAliasCommand(p: Command): void {
  p.command('perms', { hidden: true })
    .allowUnknownOption()
    .allowExcessArguments()
    .action(async () => {
      console.log(chalk.yellow('Deprecated: Use "agents permissions" instead of "agents perms"\n'));
      // Re-parse with 'permissions' command
      const args = process.argv.slice(2);
      args[0] = 'permissions';
      await program.parseAsync(['node', 'agents', ...args]);
    });
}

/** Deprecated `exec` alias — re-parses as `run`. */
function registerExecAliasCommand(p: Command): void {
  p.command('exec', { hidden: true })
    .allowUnknownOption()
    .allowExcessArguments()
    .action(async () => {
      console.log(chalk.yellow('Deprecated: Use "agents run" instead of "agents exec"\n'));
      const args = process.argv.slice(2);
      args[0] = 'run';
      await program.parseAsync(['node', 'agents', ...args]);
    });
}

/** Deprecated `jobs` / `cron` aliases — re-parse as `routines`. */
function registerJobsCronAliasCommand(p: Command, alias: string): void {
  p.command(alias, { hidden: true })
    .allowUnknownOption()
    .allowExcessArguments()
    .action(async () => {
      console.log(chalk.yellow(`Deprecated: Use "agents routines" instead of "agents ${alias}"\n`));
      const args = process.argv.slice(2);
      args[0] = 'routines';
      await program.parseAsync(['node', 'agents', ...args]);
    });
}

/**
 * Removed `check` command (RUSH-1234) — re-parses as `doctor --check`, forwarding
 * any remaining flags so `check --quiet` / `check --json` / `check --devices` keep
 * working and the drift-gate exit code survives the rename. The notice goes to
 * stderr so `--json` stdout stays clean for CI parsers.
 */
function registerCheckTombstoneCommand(p: Command): void {
  p.command('check', { hidden: true })
    .allowUnknownOption()
    .allowExcessArguments()
    .action(async () => {
      console.error(chalk.yellow('Deprecated: "agents check" is now "agents doctor --check". Running that for you.\n'));
      const args = process.argv.slice(2);
      args[0] = 'doctor';
      args.splice(1, 0, '--check');
      await program.parseAsync(['node', 'agents', ...args]);
    });
}

/**
 * Removed `resources` command (RUSH-1234) — re-parses as `view --merged` (the
 * cross-layer, first-wins resource table now lives there; `agents inspect <target>`
 * covers per-agent / per-repo detail). Forwards remaining flags like `--json`.
 */
function registerResourcesTombstoneCommand(p: Command): void {
  p.command('resources', { hidden: true })
    .allowUnknownOption()
    .allowExcessArguments()
    .action(async () => {
      console.error(chalk.yellow('Deprecated: "agents resources" is now "agents view --merged" (use "agents inspect <target>" for per-agent/per-repo detail). Running that for you.\n'));
      const args = process.argv.slice(2);
      args[0] = 'view';
      args.splice(1, 0, '--merged');
      await program.parseAsync(['node', 'agents', ...args]);
    });
}

/**
 * Removed `hq` command — the JSON bridge for the interactive Agents HQ floor
 * (`agents hq floor --json`). No UI ever consumed it (apps/ext has zero
 * references) and it had no external users, so it is gone with no replacement.
 * Kept as a hidden tombstone so a stale invocation gets a clear message and a
 * non-zero exit instead of commander's raw "unknown command".
 */
function registerHqTombstoneCommand(p: Command): void {
  p.command('hq', { hidden: true })
    .allowUnknownOption()
    .allowExcessArguments()
    .action(() => {
      die('"agents hq" was removed (internal Agents HQ floor bridge, no longer used).');
    });
}

/**
 * Hidden `agents _internal <sub>` namespace for machine-to-machine calls that
 * are not user-facing. Subcommands:
 *   - `friction` — shell guard hooks (git-guard, rm-guard, …) self-report a
 *     block into the event log before they exit 2; they run before any
 *     `agents` process exists, so they cannot emit in-process.
 *   - `mergeable-prs` — the `pr-merge-on-green` built-in poll. Prints
 *     `owner/repo#n` for this user's CI-green, non-author-approved open PRs
 *     (cwd-independent `--repo`). Empty stdout is a silent observation.
 */
function registerInternalCommand(p: Command): void {
  const internal = p.command('_internal', { hidden: true });
  internal
    .command('friction')
    .option('--surface <surface>', 'Subsystem that hit the failure (e.g. guard, teams)')
    .option('--id <failureId>', 'Stable failure slug (e.g. git.reset-hard)')
    .option('--error <message>', 'Human-readable failure reason')
    .option('--command <command>', 'The command that was blocked')
    .action((opts: { surface?: string; id?: string; error?: string; command?: string }) => {
      if (!opts.surface || !opts.id) {
        process.exit(0); // fail-open: never break the caller
      }
      emitFriction(opts.surface, opts.id, {
        ...(opts.error ? { error: opts.error } : {}),
        ...(opts.command ? { command: opts.command } : {}),
      });
      process.exit(0);
    });
  internal
    .command('mergeable-prs')
    .description('Print owner/repo#n for CI-green, non-author-approved open PRs (pr-merge-on-green poll)')
    .action(async () => {
      try {
        const { listMergeableRefs } = await import('./lib/github/pr-mergeable.js');
        const refs = await listMergeableRefs();
        if (refs) process.stdout.write(`${refs}\n`);
      } catch {
        // Empty observation — never write stderr (command.ts would treat it
        // as the poll result and fire `mode: every` on the error text).
      }
    });
}

/** Runtime action for the shared `agents upgrade [version]` command definition. */
async function runUpgrade(version: string | undefined, options: UpgradeOptions): Promise<void> {
      const { default: ora } = await import('ora');
      const { confirm } = await import('@inquirer/prompts');
      const { isInteractiveTerminal, isPromptCancelled } = await import('./commands/utils.js');
      const target = version ?? 'latest';
      let spinner = ora(version ? `Resolving ${NPM_PACKAGE_NAME}@${target}...` : 'Checking for updates...').start();
      try {
        const metadata = await fetchNpmPackageMetadata(target);
        const resolvedVersion = metadata.version;

        if (resolvedVersion === VERSION) {
          spinner.succeed(`Already on ${VERSION}`);
          return;
        }

        // For `latest` (no explicit version) skip when already ahead. When a
        // version is named explicitly, honor it even if it's a downgrade.
        if (!version && compareVersions(resolvedVersion, VERSION) <= 0) {
          spinner.succeed(`Already ahead of latest (${VERSION} >= ${resolvedVersion})`);
          return;
        }

        const direction = compareVersions(resolvedVersion, VERSION) < 0 ? 'Downgrade' : 'Upgrade';
        spinner.succeed(`Resolved ${NPM_PACKAGE_NAME}@${resolvedVersion}`);
        printResolvedPackage(metadata);
        if (isInteractiveTerminal() && !options.yes) {
          const approved = await confirm({
            message: `Install ${NPM_PACKAGE_NAME}@${resolvedVersion}?`,
            default: false,
          });
          if (!approved) {
            console.log(chalk.gray('Upgrade cancelled'));
            return;
          }
        }

        spinner = ora(`${direction === 'Downgrade' ? 'Downgrading' : 'Upgrading'} ${VERSION} -> ${resolvedVersion}...`).start();
        await installResolvedPackage(metadata);
        spinner.succeed(`${direction}d to ${resolvedVersion}`);
        // After a successful upgrade, drop latent pre-fix / npx-cache /
        // unsafe-legacy copies so the new binary is not shadowed (RUSH-2415).
        try {
          const runningRoot = resolveRunningPackageRoot(__dirname);
          const purge = remediateStaleAgentsCliInstalls({
            runningRoot,
            runningVersion: resolvedVersion,
          });
          if (purge.removed.length > 0) {
            console.log(chalk.gray(
              `Purged ${purge.removed.length} stale agents-cli install${purge.removed.length === 1 ? '' : 's'} (npx-cache / legacy / pre-1.22.30).`,
            ));
          }
          if (purge.failed.length > 0) {
            console.log(chalk.yellow(
              `Could not purge ${purge.failed.length} stale install${purge.failed.length === 1 ? '' : 's'}; re-run agents doctor --fix.`,
            ));
          }
          // RUSH-2705/2713: duplicates --fix won't auto-purge (a healthy
          // >=1.22.30 peer, or a pre-1.22.30 copy with no fixed peer to fall back
          // to — not healthy) — name the command that removes them instead of
          // leaving a silent nag behind.
          for (const u of purge.unresolved) {
            console.log(chalk.gray(
              `Duplicate ${u.version} at ${u.packageRoot} left in place; remove it with: ${u.manualRemoveCommand}`,
            ));
          }
        } catch {
          /* best-effort; upgrade already succeeded */
        }
        // Only show the changelog for a genuine upgrade range.
        if (compareVersions(resolvedVersion, VERSION) > 0) {
          await showWhatsNew(VERSION, resolvedVersion);
        }
      } catch (err) {
        if (isPromptCancelled(err)) return;
        spinner.fail(`Upgrade failed: ${err instanceof Error ? err.message : String(err)}`);
        console.log(chalk.gray(`Run manually: agents upgrade ${version ? version + ' ' : ''}--yes`));
        // A failed upgrade MUST exit non-zero (PHNX-2768). The fleet rollout
        // keys a box `ok` on `agents upgrade` exiting 0 alone; exiting 0 on
        // failure is what let a stranded box (package upgraded, bin links gone)
        // be reported merely `unverified` instead of `failed`.
        process.exitCode = 1;
      }
}

function registerUpgradeRuntimeCommand(p: Command): void {
  registerUpgradeCommand(p, runUpgrade);
}

// --- Lazy registration orchestration -----------------------------------------

/** Import a command module via its loader and register it on the program. */
async function reg(loader: ModuleLoader): Promise<void> {
  (await loader())(program);
}

/**
 * Register exactly the command(s) the requested top-level name needs.
 * Returns false when the name maps to no known command (typo / unknown).
 *
 * Lazy commands (sessions/teams/cloud) are intentionally NOT handled here — they
 * must register after applyGlobalHelpConventions to match main's ordering.
 * Inline aliases/tombstones load their target module via COMMAND_LOADERS.
 */
async function registerEagerForRequest(name: string): Promise<boolean> {
  switch (name) {
    case 'perms':
      // The action re-parses as `permissions`, so that target must exist too.
      registerPermsAliasCommand(program);
      for (const loader of COMMAND_LOADERS['permissions'] ?? []) await reg(loader);
      return true;
    case 'exec':
      registerExecAliasCommand(program);
      for (const loader of COMMAND_LOADERS['run'] ?? []) await reg(loader);
      return true;
    case 'jobs':
    case 'cron':
      registerJobsCronAliasCommand(program, name);
      for (const loader of COMMAND_LOADERS['routines'] ?? []) await reg(loader);
      return true;
    case 'check':
      // The action re-parses as `doctor --check`, so doctor must exist too.
      registerCheckTombstoneCommand(program);
      for (const loader of COMMAND_LOADERS['doctor'] ?? []) await reg(loader);
      return true;
    case 'resources':
      // The action re-parses as `view --merged`, so view must exist too.
      registerResourcesTombstoneCommand(program);
      for (const loader of COMMAND_LOADERS['view'] ?? []) await reg(loader);
      return true;
    case 'hq':
      registerHqTombstoneCommand(program);
      return true;
    case '_internal':
      registerInternalCommand(program);
      return true;
    case 'upgrade':
      registerUpgradeRuntimeCommand(program);
      return true;
  }

  const loaders = COMMAND_LOADERS[name];
  if (!loaders) return false;
  for (const loader of loaders) await reg(loader);
  return true;
}

// Safety-net for unknown commands that still reach commander (should be rare
// after the pre-parse spellcheck below). Candidates come from the plain-string
// KNOWN_TOP_LEVEL_COMMANDS set so this path never depends on every module
// having been registered (RUSH-2329).
program.on('command:*', (operands) => {
  const unknown = operands[0];
  const { closest, minDist } = closestTopLevelCommand(unknown, KNOWN_TOP_LEVEL_COMMANDS);

  if (minDist === 1 && closest && !RETIRED_TOP_LEVEL_COMMANDS.has(unknown)) {
    const args = process.argv.slice(2);
    args[0] = closest;
    // The typo'd name was unknown, so the top-level --device router (which ran
    // before commander parsing, against the ORIGINAL name) could not have
    // routed it - it correctly fell through to reach this handler at all
    // (that fallthrough is this ticket's own fix). But falling through to a
    // plain local re-parse means a routing flag on a corrected REAL
    // host-routable command (e.g. `docto --device box`, corrected to `doctor`)
    // silently ran LOCALLY instead of remotely, with no error - worse than
    // the loud "does not support --device" this ticket replaced. Re-run the
    // router with the CORRECTED name before falling through to local parse;
    // it already no-ops when no routing flag is present. RUSH-2022 review r2.
    void (async () => {
      // Register only the corrected command — never the full tree (RUSH-2329).
      if (LAZY_COMMAND_NAMES.has(closest)) {
        for (const loader of COMMAND_LOADERS[closest] ?? []) await reg(loader);
      } else {
        await registerEagerForRequest(closest);
      }
      // Same RUSH-2374 gate as the main router: typo corrections with no routing
      // flag must not load the hosts graph just to no-op.
      if (hasHostRoutingFlag(args)) {
        const { maybeRunOnHost } = await import('./lib/hosts/passthrough.js');
        if (await maybeRunOnHost(closest, args)) {
          process.exit(process.exitCode ?? 0);
        }
      }
      program.parse(['node', 'agents', ...args]);
    })();
    return;
  }

  console.error(`error: unknown command '${unknown}'`);
  if (closest && minDist <= 3) {
    console.error(`(Did you mean ${closest}?)`);
  }
  process.exit(1);
});

// Parse the invocation shape up front: the first non-flag token is the command,
// and the doc flags (--version/--help/-h) drive both the registration strategy
// and whether the update check + background sync run at all.
const passedArgs = process.argv.slice(2);
// Commander owns `--version` on the root command and otherwise intercepts it
// even after `sessions`, before the subcommand can parse its version filter.
// Rewrite only that value-taking nested form; bare `agents --version` and every
// other command retain the root documentation flag unchanged.
if (passedArgs[0] === 'sessions') {
  const nestedVersionIndex = passedArgs.indexOf('--version', 1);
  if (nestedVersionIndex >= 0) {
    const nestedVersion = passedArgs[nestedVersionIndex + 1];
    if (!nestedVersion || nestedVersion.startsWith('-')) {
      console.error("error: option '--version <version>' argument missing");
      process.exit(1);
    }
    passedArgs[nestedVersionIndex] = '--session-version';
    process.argv[nestedVersionIndex + 2] = '--session-version';
  }
}
const requestedCommand = passedArgs.find((arg) => !arg.startsWith('-'));
const verboseStartup = passedArgs.includes('--verbose');
const helpAllRequested = passedArgs.includes('--help-all');
// Help and version output are pure documentation — they must never gate on
// setup, otherwise `agents <cmd> --help` becomes useless on a fresh box.
const helpOrVersionRequested = passedArgs.some(
  (arg) => arg === '--help' || arg === '-h' || arg === '--version' || arg === '-V',
);
const isDocumentationRequest = helpOrVersionRequested || helpAllRequested;

// White-label: a brand can hide built-in top-level commands. A hidden command
// must behave as if it doesn't exist under this brand (unknown-command +
// spellcheck), while `agents` itself is unaffected. `brandDisabled` is empty for
// the unbranded CLI, so all of this is a no-op there.
const brandDisabled = disabledCommandsForActiveBrand();
const requestedIsDisabled = requestedCommand !== undefined && brandDisabled.has(requestedCommand);

// `--device` passthrough: run this invocation on a remote machine over SSH instead
// of locally. Handled before any local command registration / update check /
// background sync — a remote run needs none of that. Only the allowlisted
// read-only + config + teams commands route here; `run`/`sessions` are absent
// from the table and fall through to their own richer `--device` handling below.
// `--help`/`--version` stay local (docs must work without a reachable host).
//
// RUSH-2374: gate the dynamic import on a routing flag actually being present.
// Without this, every named invocation paid ~187ms to load passthrough.js only
// for maybeRunOnHost to return false after four flagValue scans. The presence
// scan itself is the same work those four scans do, at ~0.001ms on an 11-token
// argv — free next to the module graph it avoids on the majority path.
if (
  requestedCommand !== undefined &&
  !isDocumentationRequest &&
  !requestedIsDisabled &&
  hasHostRoutingFlag(passedArgs)
) {
  const { maybeRunOnHost } = await import('./lib/hosts/passthrough.js');
  if (await maybeRunOnHost(requestedCommand, passedArgs)) {
    process.exit(process.exitCode ?? 0);
  }
}

// Register only the command(s) this invocation actually uses. Lazy commands
// (sessions/teams/cloud) are handled after applyGlobalHelpConventions below.
const isLazyRequest = requestedCommand !== undefined && LAZY_COMMAND_NAMES.has(requestedCommand);
// Root help (--help, --help-all, or bare invocation) needs the full command tree
// so the formatter can render real descriptions and the compact front-door
// pointer can point at the real remaining surface.
const rootHelpRequested =
  requestedCommand === undefined &&
  (helpAllRequested || passedArgs.includes('--help') || passedArgs.includes('-h') || passedArgs.length === 0);
// Set when the requested name maps to no command. Spellcheck uses the plain
// KNOWN_TOP_LEVEL_COMMANDS string set — never registerAllEagerCommands just to
// build the candidate list (RUSH-2329; was 250-330ms of module evaluation).
let requestedIsUnknown = false;
if (requestedIsDisabled) {
  // Brand hid this command: resolve as unknown without loading the full tree.
  requestedIsUnknown = true;
} else if (rootHelpRequested) {
  await registerAllCommands(program);
} else if (requestedCommand !== undefined && !isLazyRequest) {
  const known = await registerEagerForRequest(requestedCommand);
  if (!known) {
    requestedIsUnknown = true;
  }
}

// Mirror main: help conventions are applied after the eager command tree and
// before the lazy commands, so the latter inherit the root's custom help
// formatter instead of getting the per-command recursive pass.
applyGlobalHelpConventions(program);

// Compact root help shows only the measured front-door groups plus a pointer to
// the full surface. --help-all disables compact mode so every command is listed.
if (!helpAllRequested) {
  setCompactRootHelp(program);
}

// Lazy commands pull in the SQLite-backed session/cloud stack; register them
// only when explicitly requested, keeping lightweight commands off that path.
if (isLazyRequest && !requestedIsDisabled) {
  for (const loader of COMMAND_LOADERS[requestedCommand!]) await reg(loader);
} else if (requestedIsUnknown && requestedCommand) {
  // Spellcheck from the plain-string name set. KNOWN_TOP_LEVEL_COMMANDS already
  // includes lazy names (sessions/teams/cloud/…) and inline aliases/tombstones,
  // so `agents session` still suggests `sessions` without loading either module.
  // Insertion order matches COMMAND_LOADERS key order + INLINE_COMMAND_NAMES,
  // preserving the historical first-seen tie-break of registerAllEagerCommands.
  const candidates = [...KNOWN_TOP_LEVEL_COMMANDS].filter((name) => !brandDisabled.has(name));
  const { closest, minDist } = closestTopLevelCommand(requestedCommand, candidates);

  if (
    minDist === 1 &&
    closest &&
    !requestedIsDisabled &&
    !RETIRED_TOP_LEVEL_COMMANDS.has(requestedCommand)
  ) {
    // Auto-correct: register ONLY the corrected command, then re-route --device
    // and reparse under the real name (RUSH-2329 + RUSH-2022 review r2).
    passedArgs[0] = closest;
    // Keep process.argv in sync for the command:* safety-net and any code that
    // re-reads argv after this point.
    const argvCmdIndex = process.argv.findIndex((a, i) => i >= 2 && !a.startsWith('-'));
    if (argvCmdIndex >= 0) process.argv[argvCmdIndex] = closest;

    if (LAZY_COMMAND_NAMES.has(closest)) {
      for (const loader of COMMAND_LOADERS[closest] ?? []) await reg(loader);
    } else {
      await registerEagerForRequest(closest);
    }

    if (!isDocumentationRequest && hasHostRoutingFlag(passedArgs)) {
      const { maybeRunOnHost } = await import('./lib/hosts/passthrough.js');
      if (await maybeRunOnHost(closest, passedArgs)) {
        process.exit(process.exitCode ?? 0);
      }
    }
  } else {
    // No auto-correct: print the suggestion and exit without loading modules.
    console.error(`error: unknown command '${requestedCommand}'`);
    if (closest && minDist <= 3) {
      console.error(`(Did you mean ${closest}?)`);
    }
    process.exit(1);
  }
}

// White-label: remove any commands this brand disabled so they resolve as
// unknown. Unbranded or nothing-disabled → no-op. After auto-correct we may
// have registered a non-disabled command; strip only if it is still listed.
if (brandDisabled.size > 0) {
  const kept = program.commands.filter((c) => !brandDisabled.has(c.name()));
  if (kept.length !== program.commands.length) {
    (program as unknown as { commands: typeof program.commands }).commands = kept;
  }
}

// --help-all is a custom root option: render the full (non-compact) tree and
// exit before migrations/update checks. It is not the built-in --help, so
// commander would otherwise treat a bare program-with-subcommands as missing a
// command and exit with an error after displaying help.
if (helpAllRequested) {
  program.outputHelp();
  process.exit(0);
}

// Pure documentation paths (--version / --help / -h / --help-all) return
// immediately: skip the update check (PATH scan + cache read) and the detached
// background sync (spawns a child process) that every other invocation runs.
if (!isDocumentationRequest) {
  bootMark('bootstrap:evaluated');
  // Run update check before parsing so the upgrade notice/prompt precedes output.
  await checkForUpdates();

  // Fire-and-forget the background sync. System repo gets a real fast-forward
  // pull (read-only locally, safe). User repo and extras get fetch-only + a
  // status marker that `agents doctor` surfaces as a repo-behind warning.
  const { spawnDetachedSync } = await import('./lib/auto-pull.js');
  spawnDetachedSync();
}

// First-run experience: no args + no config yet + TTY -> launch interactive setup.
// Skipped when stdin/stdout isn't a terminal (CI, pipes) or when user passes any args.
const metaFilePath = path.join(getUserAgentsDir(), 'agents.yaml');
const firstRun =
  passedArgs.length === 0 &&
  !fs.existsSync(metaFilePath) &&
  process.stdin.isTTY &&
  process.stdout.isTTY;

if (firstRun) {
  try {
    const { runSetup } = await import('./commands/setup.js');
    await runSetup(program);
  } catch (err) {
    if (!(err instanceof Error && err.name === 'ExitPromptError')) {
      throw err;
    }
  }
  process.exit(0);
}

// Every command requires the system repo to be cloned first. `setup` is the
// command that does the cloning; `uninstall` is its reverse and must run even
// from a broken/half-setup state (that is exactly when you want to tear down).
const SETUP_EXEMPT_COMMANDS = new Set(['setup', 'help', 'uninstall']);

// Fold legacy ~/.agents-system/ into ~/.agents/.system/ BEFORE ensureInitialized
// runs. ensureInitialized checks for .git inside the new path; if the user is
// upgrading from a layout where .git lives under the legacy path, the check
// would fail and exit before the migrator ever runs. Also runs outside the
// sentinel guard below because the sentinel was set by pre-fold releases and
// would otherwise skip this step on every existing install. Idempotent —
// no-ops when legacy is missing or already a symlink.
//
// Skipped for --help/--version/--help-all (RUSH-2454): pure documentation paths
// must not load any migration graph. Loaded from migrate-fold.js (leaf: fs +
// createLink), not migrate.js, so a real command pays only the fold hop unless
// the v20 sentinel is missing and runMigration() is required below.
if (process.env.AGENTS_SKIP_MIGRATION !== '1' && !isDocumentationRequest) {
  try {
    const { foldLegacySystemRepo } = await import('./lib/migrate-fold.js');
    foldLegacySystemRepo();
  } catch { /* must never block CLI startup */ }
}

if (
  !firstRun &&
  requestedCommand &&
  !SETUP_EXEMPT_COMMANDS.has(requestedCommand) &&
  !isDocumentationRequest
) {
  const { ensureInitialized } = await import('./commands/setup.js');
  await ensureInitialized(program);
}

// One-shot idempotent migrations (split-layout, legacy file moves).
// Each step is internally guarded by existence checks so it's safe to run
// every invocation. A sentinel file in the system dir short-circuits the
// scan once a migration version has run, so the hot path stays cheap.
// AGENTS_SKIP_MIGRATION=1 disables the bootstrap-time run for tests and
// scripted invocations that prepare their own legacy fixtures.
//
// Skipped for --help/--version/--help-all (RUSH-2454): same pure-docs gate as
// fold, the update check, background sync, ensureInitialized, and the menu-bar
// self-heal. The sentinel check itself is pure fs and does not load migrate.js
// — only a missing/stale sentinel pays for
// `await import('./lib/installations/migrate.js')` (which pulls the
// hosts/routine/teams/daemon/menubar graph).
if (process.env.AGENTS_SKIP_MIGRATION !== '1' && !isDocumentationRequest) {
  try {
    const sentinel = getMigratedSentinelPath();
    // Sentinel is keyed to the migration SCHEMA version, not the binary version.
    // Bumping the suffix re-runs migrations for every user; binary releases that
    // don't change the schema must NOT re-run (they would destroy user content
    // when migration steps overlap with user-authored paths). See issue #20.
    const sentinelValue = 'v21';
    let needRun = true;
    try {
      if (fs.existsSync(sentinel) && fs.readFileSync(sentinel, 'utf-8').trim() === sentinelValue) {
        needRun = false;
      }
    } catch { /* best-effort — fall through to run */ }
    if (needRun) {
      const { runMigration } = await import('./lib/installations/migrate.js');
      await runMigration();
      try {
        fs.mkdirSync(path.dirname(sentinel), { recursive: true });
        fs.writeFileSync(sentinel, sentinelValue);
      } catch { /* best-effort */ }
    }
  } catch { /* migration must never block CLI startup */ }
}

// Auto-enable the macOS menu-bar helper once, for every user. Best-effort and
// idempotent: installMenubarLaunchAgentOnUpgrade() no-ops when not on darwin,
// when the user ran `agents menubar disable` (sticky opt-out), when the service
// is already installed, or when no helper bundle ships with this build. This is
// a lightweight startup self-heal (two existsSync checks then return) rather
// than a migration-sentinel bump, so it covers fresh installs AND upgrades
// without re-running the full migration for the whole user base (issue #20).
// Skipped for --help/--version/--help-all: those are pure documentation paths,
// so they pay neither the dynamic import (child_process, the version/layout
// resolver, the bundle installer) nor the self-heal's filesystem checks — same
// gate the update check, background sync, and ensureInitialized above already use.
if (
  process.platform === 'darwin' &&
  process.env.AGENTS_SKIP_MIGRATION !== '1' &&
  !isDocumentationRequest
) {
  try {
    const { installMenubarLaunchAgentOnUpgrade } = await import('./lib/menubar/install-menubar.js');
    installMenubarLaunchAgentOnUpgrade();
  } catch { /* never block CLI startup on the menu bar */ }
}

// Bare invocation prints the root help. Commander only auto-displays help on
// an empty parse when subcommands are registered, and the lazy-startup path
// registers none for a bare call — without this branch, `agents` exits
// silently. Runs after first-run setup and migrations so those still fire;
// exits 0 to match `agents --help` (and the pre-fix exit code).
if (passedArgs.length === 0) {
  program.outputHelp();
  process.exit(0);
}

try {
  await maybeBootstrapShimIntegration(requestedCommand, isDocumentationRequest, verboseStartup);
  bootMark('bootstrap:pre-parse');
  await program.parseAsync();
} catch (err) {
  if (err instanceof Error && err.name === 'ExitPromptError') {
    process.exit(130);
  }
  // Browser-service-not-running and CDP-not-reachable surface as typed errors
  // from src/lib/browser/. Don't dump a Node stacktrace for these — they are
  // user-actionable, not engineering bugs. See issues #41 and #43.
  if (err instanceof Error) {
    const isBrowserServiceNotRunning = err.name === 'BrowserServiceNotRunningError';
    const isBrowserCdpUnreachable = err.name === 'BrowserCdpConnectionError';
    const isBrowserIpcDown =
      err.message.startsWith('IPC error:') &&
      (err.message.includes('ECONNREFUSED') || err.message.includes('ENOENT'));
    if (isBrowserServiceNotRunning || isBrowserCdpUnreachable || isBrowserIpcDown) {
      console.error(err.message);
      process.exit(1);
    }
    // A --device targeting a password-auth device throws this from resolveHost.
    // It carries an actionable message (switch to key auth / enroll as a host);
    // handling it here covers every resolveHost caller (run, hosts check/rm,
    // secrets --device) at the source instead of a catch at each call site.
    if (err.name === 'DeviceOffloadUnsupportedError') {
      console.error(err.message);
      process.exit(1);
    }
  }
  throw err;
}
