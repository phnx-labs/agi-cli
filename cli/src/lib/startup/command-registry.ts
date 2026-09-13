const LOADED_COMMAND_NAMES = [
  'accounts', 'auth', 'view', 'inspect', 'feedback', 'commands', 'hooks', 'skills', 'rules', 'memory',
  'permissions', 'mcp', 'clis', 'subagents', 'plugins', 'workflows', 'add', 'use',
  'remove', 'rm', 'purge', 'update', 'prune', 'import', 'registry', 'search', 'install', 'packages',
  'routines', 'monitors', 'projects', 'run', '_callback', 'open', 'fork', 'config',
  'models', 'modes', 'trash', 'restore', 'doctor',
  'route', 'routes', 'harness', 'harnesses', 'secrets', 'menubar', 'sync',
  'refresh-rules', 'factory', 'insights', 'trace', 'reminders',
  'pty', 'tmux', 'watchdog', 'browser', 'computer', 'logs', 'events',
  'ssh', 'devices', 'fleet', 'repos', 'repo', 'setup', 'uninstall', 'upgrade', 'sessions',
  'teams', 'cloud', 'message', 'send', 'feed',
  'mailboxes', 'mailbox', 'artifacts', 'webhooks',
  'humans', 'daemon', 'traces',
] as const;

const INLINE_COMMAND_NAMES = [
  'perms', 'exec', 'jobs', 'cron', 'check', 'resources', 'hq', '_internal',
] as const;

/**
 * Every top-level command name the CLI answers to — the loader table plus the
 * inline aliases/tombstones above. This is the "does this command exist?"
 * predicate for code that runs BEFORE commander parses, most importantly the
 * `--device` router (lib/hosts/passthrough.ts): without it a typo'd
 * command carrying `--device` reported a flag-support error instead of
 * `unknown command` (RUSH-2022).
 *
 * Commander sub-aliases (`sessions ls`, `teams rm`, …) are deliberately absent —
 * this set is top-level only. `command-registry.test.ts` pins it against the real
 * registered command tree so a new command can never drift out of it.
 */
export const KNOWN_TOP_LEVEL_COMMANDS: ReadonlySet<string> = new Set<string>([
  ...LOADED_COMMAND_NAMES,
  ...INLINE_COMMAND_NAMES,
]);

/**
 * Former top-level names that must NOT auto-correct (edit-distance 1) into a
 * live command. Without this a pruned surface silently misroutes: the typed
 * name is gone, the spellchecker finds a neighbour, and the CLI runs something
 * the user never asked for instead of saying the command is gone.
 *
 * `set` moved under `agents models`/`agents config` (RUSH-2579); `share` moved
 * under `agents artifacts share` (RUSH-2580). login/logout/budget/bench/mine/
 * cost/output/profiles/snapshot/cp/resume/roster moved under nested homes
 * (cli-surface-consolidate). `timeline` was removed as a duplicated surface —
 * use `agents feed --filter updates` (RUSH-2692). `status` moved under
 * `agents sync status` (RUSH-2864). `tickets` was removed — use `linear`
 * (linear-cli) (RUSH-2932). `alias` moved under `agents setup alias` (RUSH-2965).
 * `inbox` was a pure alias of `agents feed` (RUSH-2984). `unshare` nested under
 * `agents artifacts unshare` (RUSH-2989). `audit` nested under `agents events audit`.
 * `trends` was removed with the insights recipe collapse — the one counter
 * surface is `agents insights mix` (PHNX-3391). `serve` (the
 * read-only local web companion + `--control` anchor) was removed with the
 * unshipped iOS Fleet Cockpit it existed for (RUSH-3001). `apply` nested under
 * `agents fleet apply` / `agents devices apply`. `beta` nested under
 * `agents setup beta` (RUSH-2981). `org` (the Prix-coupled account layer) was
 * removed; `agents auth` returned against Phoenix ID with `auth space` as the
 * team surface (RUSH-2581). `usage` was removed as a duplicate surface of
 * `agents view`, which renders per-account usage with account, version, and
 * auth state beside it (RUSH-3079). `perf` nested under `agents insights perf`
 * — performance metrics are an insight, not a top-level noun (PHNX-3391).
 * `list` was removed — it was a long-deprecated full duplicate of `agents view`
 * (it already printed "agents list is now agents view"); `agents view` is the
 * one version-listing surface (PHNX-3391). The `agents trash restore` subcommand
 * was likewise removed as an exact duplicate of top-level `agents restore`.
 */
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
