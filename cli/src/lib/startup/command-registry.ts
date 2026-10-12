const LOADED_COMMAND_NAMES = [
  'accounts', 'auth', 'view', 'inspect', 'commands', 'hooks', 'skills', 'rules', 'memory',
  'permissions', 'mcp', 'clis', 'subagents', 'plugins', 'workflows', 'add', 'use',
  'remove', 'rm', 'purge', 'update', 'prune', 'import',
  'routines', 'projects', 'run', '_callback', 'open', 'fork', 'config',
  'models', 'doctor',
  'harness', 'harnesses', 'menubar', 'sync',
  'refresh-rules', 'factory', 'insights', 'trace',
  'watchdog', 'events',
  'ssh', 'devices', 'fleet', 'repos', 'repo', 'setup', 'uninstall', 'upgrade',
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

const STANDALONE_TOOL_GROUPS = ['browser', 'computer', 'secrets', 'sessions'] as const;

const MOVED_SESSIONS_VERBS: Readonly<Record<string, string>> = {
  resume: 'agents run auto --resume <id>',
  focus: 'agents ps focus',
  stop: 'agents ps stop',
  detach: 'agents ps detach',
  migrate: 'agents ps migrate',
  migrations: 'agents ps migrations',
  preview: 'agents ps preview',
  watch: 'agents ps watch --json',
  inject: 'agents send --channel session --to <id> --text <text>',
  fork: 'agents fork',
  backfill: 'agents daemon index backfill',
  optimize: 'agents daemon index optimize',
  stats: 'agents insights resources',
  insights: 'agents insights',
  'backup-setup': 'agents setup session-backup',
};

export const REMOVED_TOOL_GROUPS: ReadonlySet<string> = new Set(STANDALONE_TOOL_GROUPS);

export function removedToolGroupMessage(group: string, rest: readonly string[]): string | undefined {
  if (!REMOVED_TOOL_GROUPS.has(group)) return undefined;
  const verb = group === 'sessions' ? rest.find((arg) => Object.hasOwn(MOVED_SESSIONS_VERBS, arg)) : undefined;
  const moved = verb === undefined ? undefined : MOVED_SESSIONS_VERBS[verb];
  if (moved) return `error: 'agents sessions ${verb}' was removed; use '${moved}'.`;
  if (group === 'sessions' && rest.some((arg) => arg === '--active' || arg === '--roots')) {
    return rest.includes('--roots')
      ? `error: 'agents sessions --roots' was removed; use 'agents daemon index roots'.`
      : `error: 'agents sessions --active' was removed; use 'agents ps'.`;
  }
  return `error: 'agents ${group}' was removed; use the standalone '${group}' CLI (${group} --help).`;
}

export function isKnownTopLevelCommand(name: string): boolean {
  return KNOWN_TOP_LEVEL_COMMANDS.has(name);
}
