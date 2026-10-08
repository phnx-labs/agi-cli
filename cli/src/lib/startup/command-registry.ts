const LOADED_COMMAND_NAMES = [
  'accounts', 'auth', 'view', 'inspect', 'commands', 'hooks', 'skills', 'rules', 'memory',
  'permissions', 'mcp', 'clis', 'subagents', 'plugins', 'workflows', 'add', 'use',
  'remove', 'rm', 'purge', 'update', 'prune', 'import', 'registry', 'search', 'install', 'packages',
  'routines', 'projects', 'run', '_callback', 'open', 'fork', 'config',
  'models', 'trash', 'doctor',
  'route', 'routes', 'harness', 'harnesses', 'secrets', 'menubar', 'sync',
  'refresh-rules', 'factory', 'insights', 'trace',
  'tmux', 'watchdog', 'browser', 'computer', 'logs', 'events',
  'ssh', 'devices', 'fleet', 'repos', 'repo', 'setup', 'uninstall', 'upgrade', 'sessions',
  'teams', 'cloud', 'message', 'ps', 'send', 'feed',
  'mailboxes', 'mailbox', 'webhooks',
  'daemon', 'traces', 'recordings',
] as const;

const INLINE_COMMAND_NAMES = [
  'perms', 'exec', 'jobs', 'cron', 'check', 'resources', 'hq', '_internal',
] as const;

export const KNOWN_TOP_LEVEL_COMMANDS: ReadonlySet<string> = new Set<string>([
  ...LOADED_COMMAND_NAMES,
  ...INLINE_COMMAND_NAMES,
]);

export const RETIRED_TOP_LEVEL_COMMANDS: ReadonlySet<string> = new Set([

  'webhook',
  'org',
  'serve',
  'usage',
  'login',
  'logout',
  'budget',
  'bench',
  'mine',
  'cost',
  'output',
  'profiles',
  'snapshot',
  'cp',
  'resume',
  'roster',
  'set',
  'share',
  'artifacts',
  'timeline',
  'status',
  'tickets',
  'alias',
  'inbox',
  'unshare',
  'audit',
  'trends',
  'apply',
  'beta',
  'perf',
  'list',
  'humans',
  'reminders',
  'modes',
  'feedback',
  'restore',
]);

export function isKnownTopLevelCommand(name: string): boolean {
  return KNOWN_TOP_LEVEL_COMMANDS.has(name);
}
