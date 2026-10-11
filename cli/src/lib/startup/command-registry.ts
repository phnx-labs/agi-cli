const LOADED_COMMAND_NAMES = [
  'accounts', 'auth', 'view', 'inspect', 'commands', 'hooks', 'skills', 'rules', 'memory',
  'permissions', 'mcp', 'clis', 'subagents', 'plugins', 'workflows', 'add', 'use',
  'remove', 'rm', 'purge', 'update', 'prune', 'import',
  'routines', 'projects', 'run', '_callback', 'open', 'fork', 'config',
  'models', 'doctor',
  'harness', 'harnesses', 'secrets', 'menubar', 'sync',
  'refresh-rules', 'factory', 'insights', 'trace',
  'watchdog', 'browser', 'computer', 'events',
  'ssh', 'devices', 'fleet', 'repos', 'repo', 'setup', 'uninstall', 'upgrade', 'sessions',
  'teams', 'cloud', 'ps', 'send', 'feed',
  'daemon', 'recordings',
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
  'route',
  'routes',
  'registry',
  'packages',
  'search',
  'install',
  'tmux',
  'message',
  'mailboxes',
  'mailbox',
  'traces',
  'webhooks',
  'logs',
  'trash',
]);

export function isKnownTopLevelCommand(name: string): boolean {
  return KNOWN_TOP_LEVEL_COMMANDS.has(name);
}
