/** Full CLI bootstrap, loaded only after index.ts's argv fast paths miss (RUSH-2335): index.ts
 * stays a slim shell so `__shim` and `__daemon-run` exit without evaluating the commander and
 * registry graph. */

import { Command } from 'commander';
import chalk from 'chalk';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { detectDevBuild } from './lib/startup/dev-build.js';
import { configureRootCommand, normalizeResumeDeviceArgs } from './lib/startup/root-command.js';
import { bootMark } from './lib/boot-profile.js';
// `ora`, `@inquirer/prompts`, `./commands/utils.js` and the agents/versions/shims modules are
// imported dynamically at their use sites, since fast commands like `--version` and `--help` never
// need them. This keeps cold starts under the target.

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

// Detect dev/working-tree builds and default the noisy startup steps off: auto-pull, migration
// (must not scribble on the real ~/.agents/) and the update prompt. Each env var can still be set
// explicitly to override.
const IS_DEV_BUILD: boolean = detectDevBuild(process.argv[1] || '', VERSION);
if (IS_DEV_BUILD) {
  if (process.env.AGENTS_NO_AUTOPULL === undefined) process.env.AGENTS_NO_AUTOPULL = '1';
  if (process.env.AGENTS_SKIP_MIGRATION === undefined) process.env.AGENTS_SKIP_MIGRATION = '1';
  if (process.env.AGENTS_CLI_DISABLE_AUTO_UPDATE === undefined) process.env.AGENTS_CLI_DISABLE_AUTO_UPDATE = '1';
}

// Command registration is lazy: the registry maps a command name to a thunk importing only what it
// needs, instead of loading the ~50-module tree up front. The full-tree registerAllEagerCommands
// path was removed (RUSH-2329); unknown commands spellcheck against KNOWN_TOP_LEVEL_COMMANDS.
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
import { hasHostRoutingFlag } from './lib/hosts/routing-flag.js';

const BRAND = resolveBrandName();

const program = configureRootCommand(new Command(), BRAND, VERSION);
registerCommandGroups(program, FRONT_DOOR_COMMAND_GROUPS);
program.option('--help-all', 'Show help for all commands');

// Audit backbone: one choke point logs every `agents <module> <cmd>` invocation to the structured
// event log (SSH/remote-user attribution added in emit()), with no per-command wiring. `agents
// events` reads it back. Attached to the root program so every subcommand inherits it.

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

/** Commands that write the event stream, so recording their own invocation would add records to the
 * log they write. `events emit` is batched, so auditing it would bury real events; `_internal
 * friction` is exempt for the same reason (shell guards fire before any `agents` process exists). */
const AUDIT_EXEMPT_COMMANDS: ReadonlySet<string> = new Set([
  'events emit',
  '_internal friction',
]);

program.hook('preAction', (_thisCommand, actionCommand) => {
  if (isReadOnlyUpdatePreview) return;
  try {
    const parts = auditCommandPath(actionCommand);
    if (parts.length === 0) return;
    if (AUDIT_EXEMPT_COMMANDS.has(parts.join(' '))) return;
    auditStarts.set(actionCommand, Date.now());
    emit('command.start', {
      module: parts[0],
      command: parts.join(' '),
      args: redactArgs(process.argv.slice(2, 22)),
      cwd: process.cwd(),
    });
  } catch {
  }
});

program.hook('postAction', (_thisCommand, actionCommand) => {
  if (isReadOnlyUpdatePreview) return;
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
      }).catch(() => {  });
    }
    if (durationMs !== undefined && !(parts[0] === 'insights' && parts[1] === 'perf')) {
      // sessionId/agent resolve here the same way emit() resolves them for
      // command.start/command.end (event-provenance.ts); without this every command.end perf
      // sample was anonymous.
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
      }).catch(() => {  });
    }
  } catch {
  }
});

function compareVersions(a: string, b: string): number {
  const partsA = a.split('.').map(Number);
  const partsB = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if (partsA[i] > partsB[i]) return 1;
    if (partsA[i] < partsB[i]) return -1;
  }
  return 0;
}

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
  }
}

const UPDATE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
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
const MULTI_INSTALL_SCAN_FILE = path.join(path.dirname(UPDATE_CHECK_FILE), '.multi-install-scan');

/** Warn once when a different agents-cli install than the running copy exists on the machine:
 * divergent installs are how self-updates "succeed" without changing the command the user types.
 * Re-fires only when the install roots or their helper-copy safety change. */
function maybeWarnMultiInstall(): void {
  const sentinel = path.join(getRuntimeStateDir(), 'multi-install-warned');
  let runningRoot: string;
  try {
    runningRoot = resolveRunningPackageRoot(__dirname);
  } catch {
    return;
  }
  const inventory = resolveMultiInstallInventory(
    runningRoot,
    VERSION,
    process.env.PATH || '',
    MULTI_INSTALL_SCAN_FILE,
  );

  if (inventory.length < 2) {
    try { fs.unlinkSync(sentinel); } catch {  }
    return;
  }

  const key = inventory
    .map((info) => `${info.packageRoot}\t${info.version}\t${info.note}`)
    .sort()
    .join('\n');
  try {
    if (fs.readFileSync(sentinel, 'utf-8') === key) return;
  } catch {  }

  console.error(chalk.yellow('Multiple agents-cli installs detected:'));
  for (const info of inventory) {
    console.error(chalk.gray(`  ${info.packageRoot}  ${info.version}  (${info.note})`));
  }
  // RUSH-2705/2713: advertise the `agents sync --prune-clis` purge only for copies it will really
  // delete. A duplicate it won't auto-purge (a healthy >=1.22.30 peer, or a vulnerable pre-1.22.30
  // copy with no fixed peer) would make it a no-op remedy, so name the manual removal command.
  const peers = inventory.filter((info) => !info.running);
  console.error(chalk.gray('Upgrades apply to the running copy.'));
  if (peers.some((info) => info.autoPurgeable)) {
    console.error(chalk.gray(
      'Purge npx-cache / legacy / pre-1.22.30 copies with: agents sync --prune-clis',
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
  } catch {  }
}

function shouldFetchLatest(cache: UpdateCheckCache | null): boolean {
  if (!cache) return true;
  return Date.now() - cache.lastCheck > UPDATE_CHECK_INTERVAL_MS;
}

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
  // Download the published tarball and prove its bytes match the registry integrity before
  // installing, then install the local trusted .tgz. A `name@version` spec would let the package
  // manager install whatever the registry serves unchecked. A mismatch throws (fail closed).
  const tarball = await downloadVerifiedTarball(metadata.tarball, metadata.integrity);
  try {
    // Clear any orphaned npm reify staging dir from a crashed upgrade before the package manager
    // stages the new one (PHNX-3393); otherwise npm's rename onto that deterministic path fails
    // ENOTEMPTY and every upgrade dead-ends. bun does not use that scheme.
    await sweepStaleInstallStaging(packageRoot);
    // Upgrade with the package manager that owns this install. A bun global install lives at
    // <bunGlobalDir>/node_modules (no `lib`), so `npm install --prefix` would write elsewhere and
    // never touch the running copy; npm exits 0 and the verify fails.
    if (detectPackageManager(packageRoot) === 'bun') {
      await installPackageWithBun(tarball);
    } else {
      await installPackageIntoPrefix(tarball, deriveGlobalPrefix(packageRoot));
    }
  } finally {
    try {
      fs.rmSync(path.dirname(tarball), { recursive: true, force: true });
    } catch {
    }
  }
  await verifyInstalledVersion(packageRoot, metadata.version);
  await refreshAliasShims(packageRoot);
  // PHNX-2768: the npm install can leave the package at the new version with the global bin links
  // gone, which stranded zion. The upgrade owns those links, restores any npm dropped and fails
  // loud if one cannot resolve. Only the npm-prefix POSIX layout has these symlinks.
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
  // The Keychain helper moved with the standalone `secrets` engine (PHNX-3989) and refreshes
  // itself off this upgrade path. The menu-bar helper still rides this path: an installed release
  // build moves to the newest published one. Best-effort; the daemon's self-heal tick repeats it.
  if (process.platform === 'darwin') {
    try {
      const { updateMenubarHelperIfNewer } = await import('./lib/menubar/install-menubar.js');
      await updateMenubarHelperIfNewer({ force: true });
    } catch {
    }
  }
}

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
      // Re-exec the verified install's entrypoint and exit: PATH lookup of `agents` could resolve
      // a different copy than the one just upgraded.
      // Use getCliLaunch; never hand-roll `[process.execPath, entrypoint]` for a compiled binary.
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

/** Background update check, once per 24h cache window: GET
 * registry.npmjs.org/@phnx-labs/agents-cli/latest. Fire-and-forget, never blocks the foreground.
 * Disable with AGENTS_CLI_DISABLE_AUTO_UPDATE=1 in the shell rc. */
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
    });
}

async function checkForUpdates(): Promise<void> {
  if (process.env.AGENTS_CLI_DISABLE_AUTO_UPDATE) return;

  maybeWarnMultiInstall();

  const cache = readUpdateCache(UPDATE_CHECK_FILE);

  if (shouldFetchLatest(cache)) {
    refreshUpdateCacheInBackground();
  }

  if (shouldPromptUpgrade(cache, VERSION)) {
    try {
      await promptUpgrade(cache!.latestVersion);
    } catch (err) {
      const { isPromptCancelled } = await import('./commands/utils.js');
      if (isPromptCancelled(err)) return;
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
  // Pure documentation paths must never trigger interactive repair, mirroring the
  // isDocumentationRequest check around ensureInitialized. Covers bare `agents --version` and
  // `agents <subcommand> --help`.
  if (isDocumentationRequest) {
    return;
  }
  if (requestedCommand === 'sync' || requestedCommand === 'refresh-rules') {
    return;
  }

  // Past the documentation and non-TTY checks, heal shim/shadow/PATH conditions through the
  // unified self-heal registry, silently, so users who never start the daemon still get healed.
  // Only a one-time notice prints, for what a machine can't silently fix.
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

// Inline command registrars: defined here because they close over entry-point-local state (program
// re-parsing, VERSION, the npm upgrade helpers). The lazy registrar and the all-commands fallback
// both call them, so behavior matches the old eager registration.


function registerPermsAliasCommand(p: Command): void {
  p.command('perms', { hidden: true })
    .allowUnknownOption()
    .allowExcessArguments()
    .action(async () => {
      console.log(chalk.yellow('Deprecated: Use "agents permissions" instead of "agents perms"\n'));
      const args = process.argv.slice(2);
      args[0] = 'permissions';
      await program.parseAsync(['node', 'agents', ...args]);
    });
}

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

/** Removed `check` command (RUSH-1234): re-parses as `doctor --check`, forwarding remaining flags
 * so `check --quiet/--json/--devices` and the drift-check exit code survive. The notice goes to
 * stderr so `--json` stdout stays clean for CI. */
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

/** Removed `resources` command (RUSH-1234): re-parses as `view --merged`, where the cross-layer
 * first-wins table now lives (`agents inspect <target>` covers per-agent/per-repo detail).
 * Forwards remaining flags like `--json`. */
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

/** Removed `hq` command, the JSON bridge for the Agents HQ floor. No UI consumed it and it had no
 * external users, so it is gone with no replacement. Kept as a hidden tombstone so a stale
 * invocation gets a clear message and non-zero exit instead of commander's raw "unknown command". */
function registerHqTombstoneCommand(p: Command): void {
  p.command('hq', { hidden: true })
    .allowUnknownOption()
    .allowExcessArguments()
    .action(() => {
      die('"agents hq" was removed (internal Agents HQ floor bridge, no longer used).');
    });
}

/** Hidden `agents _internal <sub>` namespace for machine-to-machine calls: `friction` and
 * `mergeable-prs` (the `pr-merge-on-green` poll; prints `owner/repo#n` for CI-green,
 * non-author-approved open PRs). */
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
        process.exit(0);
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
      }
    });
}

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
              `Could not purge ${purge.failed.length} stale install${purge.failed.length === 1 ? '' : 's'}; re-run agents sync --prune-clis.`,
            ));
          }
          // RUSH-2705/2713: duplicates --fix won't auto-purge (a healthy >=1.22.30 peer, or a
          // pre-1.22.30 copy with no fixed peer) get the command that removes them named, instead
          // of a silent nag.
          for (const u of purge.unresolved) {
            console.log(chalk.gray(
              `Duplicate ${u.version} at ${u.packageRoot} left in place; remove it with: ${u.manualRemoveCommand}`,
            ));
          }
        } catch {
        }
        if (compareVersions(resolvedVersion, VERSION) > 0) {
          await showWhatsNew(VERSION, resolvedVersion);
        }
      } catch (err) {
        if (isPromptCancelled(err)) return;
        spinner.fail(`Upgrade failed: ${err instanceof Error ? err.message : String(err)}`);
        console.log(chalk.gray(`Run manually: agents upgrade ${version ? version + ' ' : ''}--yes`));
        // A failed upgrade must exit non-zero (PHNX-2768). The fleet rollout keys a box `ok` on
        // `agents upgrade` exiting 0, and exiting 0 on failure let a stranded box (package
        // upgraded, bin links gone) read `unverified` instead of `failed`.
        process.exitCode = 1;
      }
}

function registerUpgradeRuntimeCommand(p: Command): void {
  registerUpgradeCommand(p, runUpgrade);
}


async function reg(loader: ModuleLoader): Promise<void> {
  (await loader())(program);
}

/** Register exactly the command(s) the requested top-level name needs; returns false for an unknown
 * name. Lazy commands are not handled here: they must register after applyGlobalHelpConventions to
 * match main's ordering. Inline aliases/tombstones load their target via COMMAND_LOADERS. */
async function registerEagerForRequest(name: string): Promise<boolean> {
  switch (name) {
    case 'perms':
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
      registerCheckTombstoneCommand(program);
      for (const loader of COMMAND_LOADERS['doctor'] ?? []) await reg(loader);
      return true;
    case 'resources':
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

// Safety net for unknown commands that still reach commander (rare after the pre-parse
// spellcheck). Candidates come from the plain-string KNOWN_TOP_LEVEL_COMMANDS set so this never
// depends on every module being registered (RUSH-2329).
program.on('command:*', (operands) => {
  const unknown = operands[0];
  const { closest, minDist } = closestTopLevelCommand(unknown, KNOWN_TOP_LEVEL_COMMANDS);

  if (minDist === 1 && closest && !RETIRED_TOP_LEVEL_COMMANDS.has(unknown)) {
    const args = process.argv.slice(2);
    args[0] = closest;
    // The --device router ran on the original typo'd name, so it fell through to here. A plain
    // local re-parse would silently run a corrected `docto --device box` locally, not remotely,
    // so re-run the router with the CORRECTED name first (RUSH-2022 review r2).
    void (async () => {
      if (LAZY_COMMAND_NAMES.has(closest)) {
        for (const loader of COMMAND_LOADERS[closest] ?? []) await reg(loader);
      } else {
        await registerEagerForRequest(closest);
      }
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

const passedArgs = normalizeResumeDeviceArgs(process.argv.slice(2));
process.argv.splice(2, process.argv.length - 2, ...passedArgs);
// Commander owns `--version` on the root and intercepts it even after `sessions`, before the
// subcommand can parse its version filter. Rewrite only that value-taking nested form; bare
// `agents --version` and other commands keep the root flag.
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
const helpOrVersionRequested = passedArgs.some(
  (arg) => arg === '--help' || arg === '-h' || arg === '--version' || arg === '-V',
);
const isDocumentationRequest = helpOrVersionRequested || helpAllRequested;

// White-label: a brand can hide built-in top-level commands, which must behave as nonexistent
// (unknown-command plus spellcheck) under that brand. `brandDisabled` is empty for the unbranded
// CLI, making this a no-op there.
const brandDisabled = disabledCommandsForActiveBrand();
const requestedIsDisabled = requestedCommand !== undefined && brandDisabled.has(requestedCommand);

// `--device` passthrough runs this invocation over SSH before local registration, update check or
// sync; only allowlisted read-only, config and teams commands route here (not `run`/`sessions`).
// RUSH-2374: load passthrough.js only when a routing flag is present (saved ~187ms per command).
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

const isLazyRequest = requestedCommand !== undefined && LAZY_COMMAND_NAMES.has(requestedCommand);
const rootHelpRequested =
  requestedCommand === undefined &&
  (helpAllRequested || passedArgs.includes('--help') || passedArgs.includes('-h') || passedArgs.length === 0);
let requestedIsUnknown = false;
if (requestedIsDisabled) {
  requestedIsUnknown = true;
} else if (rootHelpRequested) {
  await registerAllCommands(program);
} else if (requestedCommand !== undefined && !isLazyRequest) {
  const known = await registerEagerForRequest(requestedCommand);
  if (!known) {
    requestedIsUnknown = true;
  }
}

applyGlobalHelpConventions(program);

if (!helpAllRequested) {
  setCompactRootHelp(program);
}

if (isLazyRequest && !requestedIsDisabled) {
  for (const loader of COMMAND_LOADERS[requestedCommand!]) await reg(loader);
} else if (requestedIsUnknown && requestedCommand) {
  // Spellcheck from the plain-string name set, which already includes lazy names and inline
  // aliases/tombstones, so `agents session` suggests `sessions` without loading either module.
  const candidates = [...KNOWN_TOP_LEVEL_COMMANDS].filter((name) => !brandDisabled.has(name));
  const { closest, minDist } = closestTopLevelCommand(requestedCommand, candidates);

  if (
    minDist === 1 &&
    closest &&
    !requestedIsDisabled &&
    !RETIRED_TOP_LEVEL_COMMANDS.has(requestedCommand)
  ) {
    passedArgs[0] = closest;
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
    console.error(`error: unknown command '${requestedCommand}'`);
    if (closest && minDist <= 3) {
      console.error(`(Did you mean ${closest}?)`);
    }
    process.exit(1);
  }
}

if (brandDisabled.size > 0) {
  const kept = program.commands.filter((c) => !brandDisabled.has(c.name()));
  if (kept.length !== program.commands.length) {
    (program as unknown as { commands: typeof program.commands }).commands = kept;
  }
}

// --help-all is a custom root option: render the full non-compact tree and exit before migrations
// and update checks. It is not the built-in --help, so commander would otherwise treat a bare
// program-with-subcommands as missing a command and error.
if (helpAllRequested) {
  program.outputHelp();
  process.exit(0);
}

// `agents update --check` is a pure read-only preview, so it must not fire the mutating startup
// steps: self-update check, background repo sync, migrations, menu-bar install, shim self-heal
// (PHNX-3940).
const isReadOnlyUpdatePreview =
  !isDocumentationRequest &&
  passedArgs.find((arg) => !arg.startsWith('-')) === 'update' &&
  passedArgs.includes('--check');

if (!isDocumentationRequest) {
  bootMark('bootstrap:evaluated');
  if (!isReadOnlyUpdatePreview) {
    await checkForUpdates();

    const { spawnDetachedSync } = await import('./lib/auto-pull.js');
    spawnDetachedSync();
  }
}

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

const SETUP_EXEMPT_COMMANDS = new Set(['setup', 'help', 'uninstall']);

// Fold legacy ~/.agents-system/ into ~/.agents/.system/ before ensureInitialized, which exits on
// a .git still under the legacy path. Runs outside the sentinel guard (pre-fold releases set it).
// Idempotent; skipped for --help/--version/--help-all, which load no migration graph (RUSH-2454).
if (process.env.AGENTS_SKIP_MIGRATION !== '1' && !isDocumentationRequest && !isReadOnlyUpdatePreview) {
  try {
    const { foldLegacySystemRepo } = await import('./lib/migrate-fold.js');
    foldLegacySystemRepo();
  } catch {  }
}

if (
  !firstRun &&
  requestedCommand &&
  !SETUP_EXEMPT_COMMANDS.has(requestedCommand) &&
  !isDocumentationRequest &&
  !isReadOnlyUpdatePreview
) {
  const { ensureInitialized } = await import('./commands/setup.js');
  await ensureInitialized(program);
}

// One-shot idempotent migrations, each guarded by existence checks; a sentinel in the system dir
// short-circuits the scan once a migration version has run. AGENTS_SKIP_MIGRATION=1 disables this
// for tests with their own legacy fixtures. Skipped for --help/--version/--help-all (RUSH-2454).
if (process.env.AGENTS_SKIP_MIGRATION !== '1' && !isDocumentationRequest && !isReadOnlyUpdatePreview) {
  try {
    const sentinel = getMigratedSentinelPath();
    // The sentinel is keyed to the migration schema version, not the binary version. Bumping the
    // suffix re-runs migrations for every user; binary releases that don't change the schema must
    // not, since overlapping steps could destroy user content (issue #20).
    const sentinelValue = 'v21';
    let needRun = true;
    try {
      if (fs.existsSync(sentinel) && fs.readFileSync(sentinel, 'utf-8').trim() === sentinelValue) {
        needRun = false;
      }
    } catch {  }
    if (needRun) {
      const { runMigration } = await import('./lib/installations/migrate.js');
      await runMigration();
      try {
        fs.mkdirSync(path.dirname(sentinel), { recursive: true });
        fs.writeFileSync(sentinel, sentinelValue);
      } catch {  }
    }
  } catch {  }
}

// Auto-enable the macOS menu-bar helper once, best-effort and idempotent: it no-ops off darwin,
// after `agents menubar disable`, when already installed, or when no bundle ships.
if (
  process.platform === 'darwin' &&
  process.env.AGENTS_SKIP_MIGRATION !== '1' &&
  !isDocumentationRequest &&
  !isReadOnlyUpdatePreview
) {
  try {
    const { installMenubarLaunchAgentOnUpgrade } = await import('./lib/menubar/install-menubar.js');
    installMenubarLaunchAgentOnUpgrade();
  } catch {  }
}

// Bare invocation prints the root help: commander auto-displays help on an empty parse only when
// subcommands are registered, and lazy startup registers none for a bare call, so `agents` would
// exit silently. Runs after first-run setup and migrations; exits 0 like `agents --help`.
if (passedArgs.length === 0) {
  program.outputHelp();
  process.exit(0);
}

try {
  if (!isReadOnlyUpdatePreview) {
    await maybeBootstrapShimIntegration(requestedCommand, isDocumentationRequest, verboseStartup);
  }
  bootMark('bootstrap:pre-parse');
  await program.parseAsync();
} catch (err) {
  if (err instanceof Error && err.name === 'ExitPromptError') {
    process.exit(130);
  }
  if (err instanceof Error) {
    // The browser-service/CDP/IPC typed errors came from the in-repo browser engine, deleted in
    // PHNX-4101; the standalone `browser` CLI prints its own errors and agents-cli forwards its
    // exit code, so nothing is special-cased here.

    // A --device targeting a password-auth device throws this from resolveHost with an actionable
    // message (switch to key auth or enroll as a host). Handling it here covers every resolveHost
    // caller at the source instead of per call site.
    if (err.name === 'DeviceOffloadUnsupportedError') {
      console.error(err.message);
      process.exit(1);
    }
    // The standalone `secrets` CLI is a required external dependency (DIST-1). When it is missing
    // or a request fails, the client throws a typed SecretsClientError with install guidance.
    if (err.name === 'SecretsClientError') {
      console.error(err.message);
      process.exit(1);
    }
  }
  throw err;
}
