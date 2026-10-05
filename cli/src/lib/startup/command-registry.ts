const LOADED_COMMAND_NAMES = [
  'accounts', 'auth', 'view', 'inspect', 'feedback', 'commands', 'hooks', 'skills', 'rules', 'memory',
  'permissions', 'mcp', 'clis', 'subagents', 'plugins', 'workflows', 'add', 'use',
  'remove', 'rm', 'purge', 'update', 'prune', 'import', 'registry', 'search', 'install', 'packages',
  'routines', 'monitors', 'projects', 'run', '_callback', 'open', 'fork', 'config',
  'models', 'modes', 'trash', 'restore', 'doctor',
  'route', 'routes', 'harness', 'harnesses', 'secrets', 'menubar', 'sync',
  'refresh-rules', 'factory', 'insights', 'trace', 'reminders',
  'tmux', 'watchdog', 'browser', 'computer', 'logs', 'events',
  'ssh', 'devices', 'fleet', 'repos', 'repo', 'setup', 'uninstall', 'upgrade', 'sessions',
  'teams', 'cloud', 'message', 'ps', 'send', 'feed',
  'mailboxes', 'mailbox', 'webhooks',
  'humans', 'daemon', 'traces',
] as const;

const INLINE_COMMAND_NAMES = [
  'perms', 'exec', 'jobs', 'cron', 'check', 'resources', 'hq', '_internal',
] as const;

/** Every top-level command name the CLI answers to (loader table plus inline aliases/tombstones):
 * the 'does this command exist?' predicate for code before commander parses, chiefly the
 * `--device` router, so a typo with `--device` says unknown command (RUSH-2022). Test-pinned. */
export const KNOWN_TOP_LEVEL_COMMANDS: ReadonlySet<string> = new Set<string>([
  ...LOADED_COMMAND_NAMES,
  ...INLINE_COMMAND_NAMES,
]);

/** Former top-level names that must not auto-correct (edit-distance 1) into a live command, else a
 * pruned surface misroutes to something the user never asked for. E.g. `set` (RUSH-2579),
 * `share`/`artifacts` (artifacts-cli, PHNX-3992), `usage` (RUSH-3079), `list` (PHNX-3391). */
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
]);

export function isKnownTopLevelCommand(name: string): boolean {
  return KNOWN_TOP_LEVEL_COMMANDS.has(name);
}
