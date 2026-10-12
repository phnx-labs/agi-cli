/**
 * Lazy command registry.
 *
 * The CLI entry point (src/index.ts) used to statically import every command
 * module and call its `registerXCommand(program)` on every invocation. That
 * loaded the entire command tree (~50 modules) before the first line of output,
 * dominating cold-start latency.
 *
 * This module maps each user-typed top-level command name to a thunk that
 * dynamically imports ONLY the module(s) that command needs. Fast commands
 * (`--version`, `view`, compact `--help`) now pay for just the one module they
 * use; the full tree is loaded only on rare slow paths (`agents --help --all`,
 * the command-index generator). Unknown-command spellcheck uses the plain
 * `KNOWN_TOP_LEVEL_COMMANDS` string set and does not load every module.
 *
 * Parity is non-negotiable: the name -> loader map below mirrors exactly which
 * module registers which top-level command on `main`. Multi-command modules
 * (versions, packages) map several names to the same loader; `prune` needs BOTH
 * versions (which creates `prune <specs...>`) and prune.js (which attaches the
 * `cleanup` subcommand to it), in that order — see commands/prune.ts.
 */
import { Command } from 'commander';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { FRONT_DOOR, type RootHelpGroup } from '../lib/help.js';
import { configureRootCommand } from '../lib/startup/root-command.js';
import { KNOWN_TOP_LEVEL_COMMANDS, RETIRED_TOP_LEVEL_COMMANDS } from '../lib/startup/command-registry.js';
export { KNOWN_TOP_LEVEL_COMMANDS, RETIRED_TOP_LEVEL_COMMANDS } from '../lib/startup/command-registry.js';

/** A function that registers one or more commands onto the root program. */
export type Registrar = (program: Command) => void;

/** A thunk that dynamically imports a command module and returns its registrar. */
export type ModuleLoader = () => Promise<Registrar>;

// One loader per command module. Each dynamically imports the module and hands
// back its register function. Kept as named consts so src/index.ts can compose
// them into the exact main-branch registration order for the slow path.
export const loadView: ModuleLoader = async () => (await import('../commands/view.js')).registerViewCommand;
export const loadInspect: ModuleLoader = async () => (await import('../commands/inspect.js')).registerInspectCommand;
export const loadFeedback: ModuleLoader = async () => (await import('../commands/feedback.js')).registerFeedbackCommand;
export const loadCommands: ModuleLoader = async () => (await import('../commands/commands.js')).registerCommandsCommands;
export const loadHooks: ModuleLoader = async () => (await import('../commands/hooks.js')).registerHooksCommands;
export const loadSkills: ModuleLoader = async () => (await import('../commands/skills.js')).registerSkillsCommands;
export const loadRules: ModuleLoader = async () => (await import('../commands/rules.js')).registerRulesCommands;
export const loadMemory: ModuleLoader = async () => (await import('../commands/memory.js')).registerMemoryCommands;
export const loadPermissions: ModuleLoader = async () => (await import('../commands/permissions.js')).registerPermissionsCommands;
export const loadMcp: ModuleLoader = async () => (await import('../commands/mcp.js')).registerMcpCommands;
export const loadCli: ModuleLoader = async () => (await import('../commands/cli.js')).registerCliCommands;
export const loadSubagents: ModuleLoader = async () => (await import('../commands/subagents.js')).registerSubagentsCommands;
export const loadPlugins: ModuleLoader = async () => (await import('../commands/plugins.js')).registerPluginsCommands;
export const loadWorkflows: ModuleLoader = async () => (await import('../commands/workflows.js')).registerWorkflowsCommands;
export const loadVersions: ModuleLoader = async () => (await import('../commands/versions.js')).registerVersionsCommands;
export const loadUpdate: ModuleLoader = async () => (await import('../commands/update.js')).registerUpdateCommand;
export const loadImport: ModuleLoader = async () => (await import('../commands/import.js')).registerImportCommand;
export const loadPackages: ModuleLoader = async () => (await import('../commands/packages.js')).registerPackagesCommands;
export const loadRoutines: ModuleLoader = async () => (await import('../commands/routines.js')).registerRoutinesCommands;
export const loadMonitors: ModuleLoader = async () => (await import('../commands/monitors.js')).registerMonitorsCommands;
export const loadProjects: ModuleLoader = async () => (await import('../commands/projects.js')).registerProjectsCommands;
export const loadRun: ModuleLoader = async () => (await import('../commands/exec.js')).registerRunCommand;
export const loadOpen: ModuleLoader = async () => (await import('../commands/open.js')).registerOpenCommand;
export const loadReconnect: ModuleLoader = async () => (await import('../commands/reconnect.js')).registerReconnectCommand;
export const loadFork: ModuleLoader = async () => (await import('../commands/fork.js')).registerForkCommand;
export const loadConfig: ModuleLoader = async () => (await import('../commands/config.js')).registerConfigCommand;
export const loadModels: ModuleLoader = async () => (await import('../commands/models.js')).registerModelsCommand;
export const loadModes: ModuleLoader = async () => (await import('../commands/modes.js')).registerModesCommand;
export const loadPrune: ModuleLoader = async () => (await import('../commands/prune.js')).registerPruneCommand;
export const loadTrash: ModuleLoader = async () => (await import('../commands/trash.js')).registerTrashCommands;
export const loadRestore: ModuleLoader = async () => (await import('../commands/trash.js')).registerRestoreCommand;
export const loadDoctor: ModuleLoader = async () => (await import('../commands/doctor.js')).registerDoctorCommand;
export const loadRoute: ModuleLoader = async () => (await import('../commands/route.js')).registerRouteCommands;
export const loadHarness: ModuleLoader = async () => (await import('../commands/harness.js')).registerHarnessCommands;
export const loadSecrets: ModuleLoader = async () => (await import('../commands/secrets.js')).registerSecretsCommands;
export const loadMenubar: ModuleLoader = async () => (await import('../commands/menubar.js')).registerMenubarCommands;
export const loadSync: ModuleLoader = async () => (await import('../commands/sync.js')).registerSyncCommand;
export const loadRefreshRules: ModuleLoader = async () => (await import('../commands/refresh-rules.js')).registerRefreshRulesCommand;
export const loadFactory: ModuleLoader = async () => (await import('../commands/factory.js')).registerFactoryCommands;
export const loadInsights: ModuleLoader = async () => (await import('../commands/insights.js')).registerInsightsCommand;
export const loadTrace: ModuleLoader = async () => (await import('../commands/sessions-trace.js')).registerTraceCommand;
export const loadPerf: ModuleLoader = async () => (await import('../commands/perf.js')).registerPerfCommand;
export const loadPty: ModuleLoader = async () => (await import('../commands/pty.js')).registerPtyCommands;
export const loadTmux: ModuleLoader = async () => (await import('../commands/tmux.js')).registerTmuxCommands;
export const loadWatchdog: ModuleLoader = async () => (await import('../commands/watchdog.js')).registerWatchdogCommand;
export const loadBrowser: ModuleLoader = async () => (await import('../commands/browser.js')).registerBrowserCommand;
export const loadComputer: ModuleLoader = async () => (await import('../commands/computer.js')).registerComputerCommand;
export const loadLogs: ModuleLoader = async () => (await import('../commands/logs.js')).registerLogsCommand;
export const loadEvents: ModuleLoader = async () => (await import('../commands/events.js')).registerEventsCommand;
export const loadSsh: ModuleLoader = async () => (await import('../commands/ssh.js')).registerSshCommands;
export const loadRepo: ModuleLoader = async () => (await import('../commands/repo.js')).registerRepoCommands;
export const loadSetup: ModuleLoader = async () => (await import('../commands/setup.js')).registerSetupCommand;
export const loadUninstall: ModuleLoader = async () => (await import('../commands/uninstall.js')).registerUninstallCommands;
export const loadUpgrade: ModuleLoader = async () => (await import('../commands/upgrade.js')).registerUpgradeCommand;
export const loadSessions: ModuleLoader = async () => (await import('../commands/sessions.js')).registerSessionsCommands;
export const loadTeams: ModuleLoader = async () => (await import('../commands/teams.js')).registerTeamsCommands;
export const loadCloud: ModuleLoader = async () => (await import('../commands/cloud.js')).registerCloudCommands;
export const loadMessage: ModuleLoader = async () => (await import('../commands/message.js')).registerMessageCommand;
export const loadSend: ModuleLoader = async () => (await import('../commands/send.js')).registerSendCommand;
export const loadFeed: ModuleLoader = async () => (await import('../commands/feed.js')).registerFeedCommand;
export const loadMailboxes: ModuleLoader = async () => (await import('../commands/mailboxes.js')).registerMailboxesCommand;
// Registers the `artifacts` group (`share` + `setup` + nested `unshare`).
export const loadArtifacts: ModuleLoader = async () => (await import('../commands/artifacts.js')).registerArtifactsCommands;
export const loadWebhooks: ModuleLoader = async () => (await import('../commands/webhook.js')).registerWebhooksCommand;
export const loadHumans: ModuleLoader = async () => (await import('../commands/humans.js')).registerHumansCommands;
export const loadAccounts: ModuleLoader = async () => (await import('../commands/accounts.js')).registerAccountsCommand;
export const loadDaemon: ModuleLoader = async () => (await import('../commands/daemon.js')).registerDaemonCommand;
export const loadAuth: ModuleLoader = async () => (await import('../commands/auth.js')).registerAuthCommand;
export const loadTraces: ModuleLoader = async () => (await import('../commands/traces.js')).registerTracesCommands;

/**
 * Commands whose modules pull in the SQLite-backed session/cloud stack. They are
 * registered AFTER `applyGlobalHelpConventions` (mirroring main's order: help
 * conventions at module top-level, lazy registration just before parse), so they
 * inherit the root's custom help formatter rather than getting the per-command
 * recursive pass. Keeping that ordering preserves their `--help` output exactly.
 */
// `roster` was a sessions --active alias — removed; use sessions --active.
export const LAZY_COMMAND_NAMES: ReadonlySet<string> = new Set([
  'sessions',
  'reconnect',
  'teams',
  'cloud',
  'message',
]);

/**
 * User-typed top-level command name -> ordered list of module loaders to run.
 *
 * Most names map to a single loader. The exceptions encode real coupling on main:
 *  - `add`/`use`/`list`/`remove`/`rm`/`purge` all come from the versions module.
 *  - `registry`/`search`/`install` all come from the packages module.
 *  - `trash` and `restore` are separate registrars in the trash module.
 *  - `prune` needs versions FIRST (it creates `prune <specs...>`) then prune.js
 *    (which finds that command and attaches the `cleanup` subcommand).
 *
 * Inline deprecated aliases (memory/perms/exec/jobs/cron) and the inline
 * `upgrade` command are NOT here — they are closures over entry-point state and
 * are handled directly in src/index.ts.
 */
export const COMMAND_LOADERS: Record<string, ModuleLoader[]> = {
  accounts: [loadAccounts],
  view: [loadView],
  inspect: [loadInspect],
  feedback: [loadFeedback],
  commands: [loadCommands],
  hooks: [loadHooks],
  skills: [loadSkills],
  rules: [loadRules],
  memory: [loadMemory],
  permissions: [loadPermissions],
  mcp: [loadMcp],
  clis: [loadCli],
  subagents: [loadSubagents],
  plugins: [loadPlugins],
  workflows: [loadWorkflows],
  add: [loadVersions],
  use: [loadVersions],
  list: [loadVersions],
  remove: [loadVersions],
  rm: [loadVersions],
  purge: [loadVersions],
  update: [loadUpdate],
  prune: [loadVersions, loadPrune],
  import: [loadImport],
  registry: [loadPackages],
  search: [loadPackages],
  install: [loadPackages],
  routines: [loadRoutines],
  monitors: [loadMonitors],
  projects: [loadProjects],
  run: [loadRun],
  open: [loadOpen],
  reconnect: [loadReconnect],
  fork: [loadFork],
  config: [loadConfig],
  models: [loadModels],
  modes: [loadModes],
  trash: [loadTrash],
  restore: [loadRestore],
  doctor: [loadDoctor],
  route: [loadRoute],
  harness: [loadHarness],
  harnesses: [loadHarness],
  secrets: [loadSecrets],
  menubar: [loadMenubar],
  sync: [loadSync],
  'refresh-rules': [loadRefreshRules],
  factory: [loadFactory],
  insights: [loadInsights],
  // `agents trace` is a top-level alias of `agents sessions trace` (precedent:
  // `agents insights` aliases `agents sessions insights`). One implementation.
  trace: [loadTrace],
  perf: [loadPerf],
  pty: [loadPty],
  tmux: [loadTmux],
  watchdog: [loadWatchdog],
  browser: [loadBrowser],
  computer: [loadComputer],
  logs: [loadLogs],
  events: [loadEvents],
  ssh: [loadSsh],
  devices: [loadSsh],
  // `fleet` is a commander alias of `devices` (see commands/ssh.ts); list it so
  // lazy registration loads the devices tree when the user types `agents fleet`.
  fleet: [loadSsh],
  // `repos` is the canonical command name; `repo` remains a convenience alias
  // (see commands/repo.ts). List both so lazy registration loads the tree
  // whichever the user types.
  repos: [loadRepo],
  repo: [loadRepo],
  setup: [loadSetup],
  uninstall: [loadUninstall],
  upgrade: [loadUpgrade],
  sessions: [loadSessions],
  teams: [loadTeams],
  cloud: [loadCloud],
  message: [loadMessage],
  send: [loadSend],
  notify: [loadSend],
  feed: [loadFeed],
  mailboxes: [loadMailboxes],
  mailbox: [loadMailboxes],
  artifacts: [loadArtifacts],
  webhooks: [loadWebhooks],
  humans: [loadHumans],
  daemon: [loadDaemon],
  auth: [loadAuth],
  traces: [loadTraces],
};

/**
 * Fail loud if compact root help names a group the loader table does not
 * register. Called from {@link buildFullCommandTree} so the index generator
 * and `--help --all` cannot silently ship a dead front-door entry.
 */
export function assertFrontDoorLoaders(): void {
  const missing = Object.keys(FRONT_DOOR).filter((name) => COMMAND_LOADERS[name] === undefined);
  if (missing.length > 0) {
    throw new Error(`FRONT_DOOR names command(s) not in COMMAND_LOADERS: ${missing.join(', ')}`);
  }
}

/**
 * Visible (non-hidden) top-level groups from a registered program, canonical
 * names only, UTF-16 codepoint order — the listing `agents --help --all` prints.
 */
export function visibleTopLevelGroups(program: Command): RootHelpGroup[] {
  return program
    .createHelp()
    .visibleCommands(program)
    .map((cmd) => ({ name: cmd.name(), description: cmd.description() }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/**
 * Register every module in {@link COMMAND_LOADERS} onto one fresh program and
 * return it — the full public command tree, deduped by loader identity so a
 * loader mapped to several names (e.g. `add`/`use`/`list` -> versions) runs once.
 *
 * Off the hot path only: the command-index generator (`scripts/gen-command-index.ts`),
 * `agents --help --all`, and the tests build the tree from this. Compact `--help`
 * stays a static string — src/index.ts registers just the one requested command
 * via `registerEagerForRequest`. The inline aliases/tombstones
 * ({@link INLINE_COMMAND_NAMES}) are NOT included: they are closures over
 * entry-point state that src/index.ts registers directly.
 */
export async function buildFullCommandTree(): Promise<Command> {
  assertFrontDoorLoaders();
  const packageJson = JSON.parse(readFileSync(fileURLToPath(new URL('../../package.json', import.meta.url)), 'utf8')) as { version: string };
  const program = configureRootCommand(new Command(), 'agents', packageJson.version);
  const done = new Set<ModuleLoader>();
  for (const loaders of Object.values(COMMAND_LOADERS)) {
    for (const loader of loaders) {
      if (done.has(loader)) continue;
      done.add(loader);
      (await loader())(program);
    }
  }
  return program;
}
