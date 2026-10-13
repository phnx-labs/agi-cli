import { Command } from 'commander';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { configureRootCommand } from '../lib/startup/root-command.js';
import { KNOWN_TOP_LEVEL_COMMANDS, RETIRED_TOP_LEVEL_COMMANDS } from '../lib/startup/command-registry.js';
export { KNOWN_TOP_LEVEL_COMMANDS, RETIRED_TOP_LEVEL_COMMANDS, removedToolGroupMessage } from '../lib/startup/command-registry.js';

export type Registrar = (program: Command) => void;

export type ModuleLoader = () => Promise<Registrar>;

const loadView: ModuleLoader = async () => (await import('../commands/view.js')).registerViewCommand;
const loadInspect: ModuleLoader = async () => (await import('../commands/inspect.js')).registerInspectCommand;
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
const loadRoutines: ModuleLoader = async () => (await import('../commands/routines.js')).registerRoutinesCommands;
const loadProjects: ModuleLoader = async () => (await import('../commands/projects.js')).registerProjectsCommands;
export const loadRun: ModuleLoader = async () => (await import('../commands/exec.js')).registerRunCommand;
const loadOpen: ModuleLoader = async () => (await import('../commands/open.js')).registerOpenCommand;
const loadFork: ModuleLoader = async () => (await import('../commands/fork.js')).registerForkCommand;
const loadConfig: ModuleLoader = async () => (await import('../commands/config.js')).registerConfigCommand;
const loadModels: ModuleLoader = async () => (await import('../commands/models.js')).registerModelsCommand;
export const loadPrune: ModuleLoader = async () => (await import('../commands/prune.js')).registerPruneCommand;
export const loadDoctor: ModuleLoader = async () => (await import('../commands/doctor.js')).registerDoctorCommand;
const loadHarness: ModuleLoader = async () => (await import('../commands/harness.js')).registerHarnessCommands;
const loadMenubar: ModuleLoader = async () => (await import('../commands/menubar.js')).registerMenubarCommands;
const loadSync: ModuleLoader = async () => (await import('../commands/sync.js')).registerSyncCommand;
const loadRefreshRules: ModuleLoader = async () => (await import('../commands/refresh-rules.js')).registerRefreshRulesCommand;
const loadFactory: ModuleLoader = async () => (await import('../commands/factory.js')).registerFactoryCommands;
const loadInsights: ModuleLoader = async () => (await import('../commands/insights.js')).registerInsightsCommand;
const loadTrace: ModuleLoader = async () => (await import('../commands/sessions-trace.js')).registerTraceCommand;
const loadWatchdog: ModuleLoader = async () => (await import('../commands/watchdog.js')).registerWatchdogCommand;
const loadEvents: ModuleLoader = async () => (await import('../commands/events.js')).registerEventsCommand;
const loadSsh: ModuleLoader = async () => (await import('../commands/ssh.js')).registerSshCommands;
const loadRepo: ModuleLoader = async () => (await import('../commands/repo.js')).registerRepoCommands;
const loadSetup: ModuleLoader = async () => (await import('../commands/setup.js')).registerSetupCommand;
const loadUninstall: ModuleLoader = async () => (await import('../commands/uninstall.js')).registerUninstallCommands;
const loadUpgrade: ModuleLoader = async () => (await import('../commands/upgrade.js')).registerUpgradeCommand;
export const loadTeams: ModuleLoader = async () => (await import('../commands/teams.js')).registerTeamsCommands;
const loadCloud: ModuleLoader = async () => (await import('../commands/cloud.js')).registerCloudCommands;
const loadPs: ModuleLoader = async () => (await import('../commands/ps.js')).registerPsCommand;
const loadSend: ModuleLoader = async () => (await import('../commands/send.js')).registerSendCommand;
const loadLead: ModuleLoader = async () => (await import('../commands/lead.js')).registerLeadCommand;
const loadFeed: ModuleLoader = async () => (await import('../commands/feed.js')).registerFeedCommand;
const loadAccounts: ModuleLoader = async () => (await import('../commands/accounts.js')).registerAccountsCommand;
const loadDaemon: ModuleLoader = async () => (await import('../commands/daemon.js')).registerDaemonCommand;
const loadAuth: ModuleLoader = async () => (await import('../commands/auth.js')).registerAuthCommand;
const loadRecordings: ModuleLoader = async () => (await import('../commands/recordings.js')).registerRecordingsCommand;

export const LAZY_COMMAND_NAMES: ReadonlySet<string> = new Set([
  'teams',
  'cloud',
]);

export const COMMAND_LOADERS: Record<string, ModuleLoader[]> = {
  accounts: [loadAccounts],
  view: [loadView],
  inspect: [loadInspect],
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
  routines: [loadRoutines],
  projects: [loadProjects],
  run: [loadRun],
  _callback: [loadOpen],
  open: [loadOpen],
  fork: [loadFork],
  config: [loadConfig],
  models: [loadModels],
  doctor: [loadDoctor],
  harness: [loadHarness],
  harnesses: [loadHarness],
  menubar: [loadMenubar],
  sync: [loadSync],
  'refresh-rules': [loadRefreshRules],
  factory: [loadFactory],
  insights: [loadInsights],
  trace: [loadTrace],
  watchdog: [loadWatchdog],
  events: [loadEvents],
  ssh: [loadSsh],
  devices: [loadSsh],
  fleet: [loadSsh],
  repos: [loadRepo],
  repo: [loadRepo],
  setup: [loadSetup],
  uninstall: [loadUninstall],
  upgrade: [loadUpgrade],
  teams: [loadTeams],
  cloud: [loadCloud],
  ps: [loadPs],
  send: [loadSend],
  feed: [loadFeed],
  lead: [loadLead],
  daemon: [loadDaemon],
  auth: [loadAuth],
  recordings: [loadRecordings],
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
