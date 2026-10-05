import { Command } from 'commander';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { configureRootCommand } from '../lib/startup/root-command.js';
import { KNOWN_TOP_LEVEL_COMMANDS, RETIRED_TOP_LEVEL_COMMANDS } from '../lib/startup/command-registry.js';
export { KNOWN_TOP_LEVEL_COMMANDS, RETIRED_TOP_LEVEL_COMMANDS } from '../lib/startup/command-registry.js';

export type Registrar = (program: Command) => void;

export type ModuleLoader = () => Promise<Registrar>;

const loadView: ModuleLoader = async () => (await import('../commands/view.js')).registerViewCommand;
const loadInspect: ModuleLoader = async () => (await import('../commands/inspect.js')).registerInspectCommand;
const loadFeedback: ModuleLoader = async () => (await import('../commands/feedback.js')).registerFeedbackCommand;
const loadCommands: ModuleLoader = async () => (await import('../commands/commands.js')).registerCommandsCommands;
const loadHooks: ModuleLoader = async () => (await import('../commands/hooks.js')).registerHooksCommands;
const loadSkills: ModuleLoader = async () => (await import('../commands/skills.js')).registerSkillsCommands;
const loadRules: ModuleLoader = async () => (await import('../commands/rules.js')).registerRulesCommands;
const loadMemory: ModuleLoader = async () => (await import('../commands/memory.js')).registerMemoryCommands;
const loadPermissions: ModuleLoader = async () => (await import('../commands/permissions.js')).registerPermissionsCommands;
const loadMcp: ModuleLoader = async () => (await import('../commands/mcp.js')).registerMcpCommands;
const loadCli: ModuleLoader = async () => (await import('../commands/cli.js')).registerCliCommands;
const loadSubagents: ModuleLoader = async () => (await import('../commands/subagents.js')).registerSubagentsCommands;
const loadPlugins: ModuleLoader = async () => (await import('../commands/plugins.js')).registerPluginsCommands;
const loadWorkflows: ModuleLoader = async () => (await import('../commands/workflows.js')).registerWorkflowsCommands;
export const loadVersions: ModuleLoader = async () => (await import('../commands/versions.js')).registerVersionsCommands;
export const loadUpdate: ModuleLoader = async () => (await import('../commands/update.js')).registerUpdateCommand;
const loadImport: ModuleLoader = async () => (await import('../commands/import.js')).registerImportCommand;
const loadPackages: ModuleLoader = async () => (await import('../commands/packages.js')).registerPackagesCommands;
const loadRoutines: ModuleLoader = async () => (await import('../commands/routines.js')).registerRoutinesCommands;
const loadProjects: ModuleLoader = async () => (await import('../commands/projects.js')).registerProjectsCommands;
export const loadRun: ModuleLoader = async () => (await import('../commands/exec.js')).registerRunCommand;
const loadOpen: ModuleLoader = async () => (await import('../commands/open.js')).registerOpenCommand;
const loadFork: ModuleLoader = async () => (await import('../commands/fork.js')).registerForkCommand;
const loadConfig: ModuleLoader = async () => (await import('../commands/config.js')).registerConfigCommand;
const loadModels: ModuleLoader = async () => (await import('../commands/models.js')).registerModelsCommand;
const loadModes: ModuleLoader = async () => (await import('../commands/modes.js')).registerModesCommand;
export const loadPrune: ModuleLoader = async () => (await import('../commands/prune.js')).registerPruneCommand;
const loadTrash: ModuleLoader = async () => (await import('../commands/trash.js')).registerTrashCommands;
const loadRestore: ModuleLoader = async () => (await import('../commands/trash.js')).registerRestoreCommand;
export const loadDoctor: ModuleLoader = async () => (await import('../commands/doctor.js')).registerDoctorCommand;
const loadRoute: ModuleLoader = async () => (await import('../commands/route.js')).registerRouteCommands;
const loadHarness: ModuleLoader = async () => (await import('../commands/harness.js')).registerHarnessCommands;
const loadSecrets: ModuleLoader = async () => (await import('../commands/secrets-passthrough.js')).registerSecretsCommands;
const loadMenubar: ModuleLoader = async () => (await import('../commands/menubar.js')).registerMenubarCommands;
const loadSync: ModuleLoader = async () => (await import('../commands/sync.js')).registerSyncCommand;
const loadRefreshRules: ModuleLoader = async () => (await import('../commands/refresh-rules.js')).registerRefreshRulesCommand;
const loadFactory: ModuleLoader = async () => (await import('../commands/factory.js')).registerFactoryCommands;
const loadInsights: ModuleLoader = async () => (await import('../commands/insights.js')).registerInsightsCommand;
const loadTrace: ModuleLoader = async () => (await import('../commands/sessions-trace.js')).registerTraceCommand;
const loadTmux: ModuleLoader = async () => (await import('../commands/tmux.js')).registerTmuxCommands;
const loadWatchdog: ModuleLoader = async () => (await import('../commands/watchdog.js')).registerWatchdogCommand;
const loadBrowser: ModuleLoader = async () => (await import('../commands/browser.js')).registerBrowserCommand;
const loadComputer: ModuleLoader = async () => (await import('../commands/computer.js')).registerComputerCommand;
const loadLogs: ModuleLoader = async () => (await import('../commands/logs.js')).registerLogsCommand;
const loadEvents: ModuleLoader = async () => (await import('../commands/events.js')).registerEventsCommand;
const loadSsh: ModuleLoader = async () => (await import('../commands/ssh.js')).registerSshCommands;
const loadRepo: ModuleLoader = async () => (await import('../commands/repo.js')).registerRepoCommands;
const loadSetup: ModuleLoader = async () => (await import('../commands/setup.js')).registerSetupCommand;
const loadUninstall: ModuleLoader = async () => (await import('../commands/uninstall.js')).registerUninstallCommands;
const loadUpgrade: ModuleLoader = async () => (await import('../commands/upgrade.js')).registerUpgradeCommand;
export const loadSessions: ModuleLoader = async () => (await import('../commands/sessions.js')).registerSessionsCommands;
export const loadTeams: ModuleLoader = async () => (await import('../commands/teams.js')).registerTeamsCommands;
const loadCloud: ModuleLoader = async () => (await import('../commands/cloud.js')).registerCloudCommands;
const loadMessage: ModuleLoader = async () => (await import('../commands/message.js')).registerMessageCommand;
const loadPs: ModuleLoader = async () => (await import('../commands/ps.js')).registerPsCommand;
const loadSend: ModuleLoader = async () => (await import('../commands/send.js')).registerSendCommand;
const loadFeed: ModuleLoader = async () => (await import('../commands/feed.js')).registerFeedCommand;
const loadMailboxes: ModuleLoader = async () => (await import('../commands/mailboxes.js')).registerMailboxesCommand;
const loadWebhooks: ModuleLoader = async () => (await import('../commands/webhook.js')).registerWebhooksCommand;
const loadHumans: ModuleLoader = async () => (await import('../commands/humans.js')).registerHumansCommands;
const loadAccounts: ModuleLoader = async () => (await import('../commands/accounts.js')).registerAccountsCommand;
const loadDaemon: ModuleLoader = async () => (await import('../commands/daemon.js')).registerDaemonCommand;
const loadAuth: ModuleLoader = async () => (await import('../commands/auth.js')).registerAuthCommand;
const loadTraces: ModuleLoader = async () => (await import('../commands/traces.js')).registerTracesCommands;
export const loadReminders: ModuleLoader = async () => (await import('../commands/reminders.js')).registerRemindersCommand;

export const LAZY_COMMAND_NAMES: ReadonlySet<string> = new Set([
  'sessions',
  'teams',
  'cloud',
  'message',
]);

export const COMMAND_LOADERS: Record<string, ModuleLoader[]> = {
  accounts: [loadAccounts],
  view: [loadView],
  inspect: [loadInspect],
  feedback: [loadFeedback],
  reminders: [loadReminders],
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
  remove: [loadVersions],
  rm: [loadVersions],
  purge: [loadVersions],
  update: [loadUpdate],
  prune: [loadVersions, loadPrune],
  import: [loadImport],
  registry: [loadPackages],
  search: [loadPackages],
  install: [loadPackages],
  packages: [loadPackages],
  routines: [loadRoutines],
  projects: [loadProjects],
  run: [loadRun],
  _callback: [loadOpen],
  open: [loadOpen],
  fork: [loadFork],
  config: [loadConfig],
  models: [loadModels],
  modes: [loadModes],
  trash: [loadTrash],
  restore: [loadRestore],
  doctor: [loadDoctor],
  route: [loadRoute],
  routes: [loadRoute],
  harness: [loadHarness],
  harnesses: [loadHarness],
  secrets: [loadSecrets],
  menubar: [loadMenubar],
  sync: [loadSync],
  'refresh-rules': [loadRefreshRules],
  factory: [loadFactory],
  insights: [loadInsights],
  trace: [loadTrace],
  tmux: [loadTmux],
  watchdog: [loadWatchdog],
  browser: [loadBrowser],
  computer: [loadComputer],
  logs: [loadLogs],
  events: [loadEvents],
  ssh: [loadSsh],
  devices: [loadSsh],
  fleet: [loadSsh],
  repos: [loadRepo],
  repo: [loadRepo],
  setup: [loadSetup],
  uninstall: [loadUninstall],
  upgrade: [loadUpgrade],
  sessions: [loadSessions],
  teams: [loadTeams],
  cloud: [loadCloud],
  message: [loadMessage],
  ps: [loadPs],
  send: [loadSend],
  feed: [loadFeed],
  mailboxes: [loadMailboxes],
  mailbox: [loadMailboxes],
  webhooks: [loadWebhooks],
  humans: [loadHumans],
  daemon: [loadDaemon],
  auth: [loadAuth],
  traces: [loadTraces],
};

export async function buildFullCommandTree(): Promise<Command> {
  const packageJson = JSON.parse(readFileSync(fileURLToPath(new URL('../../package.json', import.meta.url)), 'utf8')) as { version: string };
  const program = configureRootCommand(new Command(), 'agents', packageJson.version);
  await registerAllCommands(program);
  return program;
}

export async function registerAllCommands(program: Command): Promise<void> {
  const done = new Set<ModuleLoader>();
  for (const loaders of Object.values(COMMAND_LOADERS)) {
    for (const loader of loaders) {
      if (done.has(loader)) continue;
      done.add(loader);
      (await loader())(program);
    }
  }
}
