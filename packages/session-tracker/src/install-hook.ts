// Installs the polyglot src/hook.sh as a SessionStart hook in each agent's
// native config file. Idempotent — running twice does not double-register.
//
// CLI usage:
//   tsx src/install-hook.ts claude
//   tsx src/install-hook.ts claude codex cursor

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath } from 'url';
import * as TOML from 'smol-toml';
import * as YAML from 'yaml';
import type { AgentId } from './types.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const HOOK_PATH = path.resolve(__dirname, 'hook.sh');

export interface InstallResult {
  agent: AgentId;
  installed: boolean;
  configPath: string;
  error?: string;
}

export interface InstallOptions {
  dryRun?: boolean;
  hookPathOverride?: string;
  /** Home directory whose harness-native config should be written. Defaults to
   *  `os.homedir()` so the live config (usually a symlink into the active
   *  version home) is updated. */
  home?: string;
}

function hookCommand(agent: AgentId, opts: InstallOptions): string {
  const hook = opts.hookPathOverride ?? HOOK_PATH;
  return `${hook} ${agent}`;
}

/** Recognize current registrations and the retired builtin sidecar writer. */
function isOwnHookCommand(command: string): boolean {
  const first = command.trim().split(/\s+/)[0];
  return (first.endsWith('hook.sh') && first.includes('session-tracker'))
    || first.endsWith('/.agents/.cache/shims/builtin-hooks/session-tracker.sh');
}

async function readJson(p: string): Promise<any> {
  try {
    const raw = await fs.promises.readFile(p, 'utf8');
    return JSON.parse(raw);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw err;
  }
}

async function writeJsonAtomic(p: string, data: any): Promise<void> {
  await fs.promises.mkdir(path.dirname(p), { recursive: true });
  const tmp = `${p}.${process.pid}.${Date.now()}.tmp`;
  try {
    await fs.promises.writeFile(tmp, JSON.stringify(data, null, 2), 'utf8');
    await fs.promises.rename(tmp, p);
  } catch (err) {
    try { await fs.promises.unlink(tmp); } catch { /* best-effort */ }
    throw err;
  }
}

async function installClaude(opts: InstallOptions): Promise<InstallResult> {
  const configPath = path.join(opts.home ?? os.homedir(), '.claude', 'settings.json');
  const command = hookCommand('claude', opts);
  if (opts.dryRun) {
    return { agent: 'claude', installed: false, configPath };
  }
  const cfg = await readJson(configPath);
  cfg.hooks = cfg.hooks ?? {};
  cfg.hooks.SessionStart = cfg.hooks.SessionStart ?? [];
  // Remove any prior registration of THIS hook path (idempotency).
  for (const entry of cfg.hooks.SessionStart) {
    if (!entry || !Array.isArray(entry.hooks)) continue;
    entry.hooks = entry.hooks.filter(
      (h: any) => !(h && h.command && isOwnHookCommand(h.command)),
    );
  }
  // Find or create the empty-matcher group and add our hook.
  let group = cfg.hooks.SessionStart.find((e: any) => e && e.matcher === '');
  if (!group) {
    group = { matcher: '', hooks: [] };
    cfg.hooks.SessionStart.push(group);
  }
  group.hooks.push({ type: 'command', command, timeout: 5 });
  await writeJsonAtomic(configPath, cfg);
  return { agent: 'claude', installed: true, configPath };
}

async function installCodex(opts: InstallOptions): Promise<InstallResult> {
  const configPath = path.join(opts.home ?? os.homedir(), '.codex', 'hooks.json');
  const command = hookCommand('codex', opts);
  if (opts.dryRun) {
    return { agent: 'codex', installed: false, configPath };
  }
  const cfg = await readJson(configPath);
  cfg.hooks = cfg.hooks ?? {};
  cfg.hooks.SessionStart = cfg.hooks.SessionStart ?? [];
  for (const entry of cfg.hooks.SessionStart) {
    if (!entry || !Array.isArray(entry.hooks)) continue;
    entry.hooks = entry.hooks.filter(
      (h: any) => !(h && h.command && isOwnHookCommand(h.command)),
    );
  }
  let group = cfg.hooks.SessionStart.find((e: any) => e && (e.matcher === '' || e.matcher === 'startup|resume'));
  if (!group) {
    group = { matcher: 'startup|resume', hooks: [] };
    cfg.hooks.SessionStart.push(group);
  }
  group.hooks.push({ type: 'command', command, timeout: 5 });
  await writeJsonAtomic(configPath, cfg);
  return { agent: 'codex', installed: true, configPath };
}

async function installCursor(opts: InstallOptions): Promise<InstallResult> {
  const configPath = path.join(opts.home ?? os.homedir(), '.cursor', 'hooks.json');
  const command = hookCommand('cursor', opts);
  if (opts.dryRun) {
    return { agent: 'cursor', installed: false, configPath };
  }
  const cfg = await readJson(configPath);
  cfg.hooks = cfg.hooks ?? {};
  cfg.hooks.sessionStart = cfg.hooks.sessionStart ?? [];
  cfg.hooks.sessionStart = cfg.hooks.sessionStart.filter(
    (h: any) => !(h && h.command && isOwnHookCommand(h.command)),
  );
  cfg.hooks.sessionStart.push({ type: 'command', command, timeout: 5 });
  await writeJsonAtomic(configPath, cfg);
  return { agent: 'cursor', installed: true, configPath };
}

async function installGrok(opts: InstallOptions): Promise<InstallResult> {
  const configPath = path.join(opts.home ?? os.homedir(), '.grok', 'hooks', 'session-start.json');
  const command = hookCommand('grok', opts);
  if (opts.dryRun) {
    return { agent: 'grok', installed: false, configPath };
  }
  await writeJsonAtomic(configPath, { command, timeout: 5 });
  return { agent: 'grok', installed: true, configPath };
}

async function installDroid(opts: InstallOptions): Promise<InstallResult> {
  const configPath = path.join(opts.home ?? os.homedir(), '.factory', 'settings.json');
  const command = hookCommand('droid', opts);
  if (opts.dryRun) return { agent: 'droid', installed: false, configPath };
  const cfg = await readJson(configPath);
  cfg.hooks = cfg.hooks ?? {};
  cfg.hooks.SessionStart = cfg.hooks.SessionStart ?? [];
  for (const entry of cfg.hooks.SessionStart) {
    if (!entry || !Array.isArray(entry.hooks)) continue;
    entry.hooks = entry.hooks.filter(
      (hook: any) => !(hook?.command && isOwnHookCommand(String(hook.command))),
    );
  }
  let group = cfg.hooks.SessionStart.find((entry: any) => entry?.matcher === '');
  if (!group) {
    group = { matcher: '', hooks: [] };
    cfg.hooks.SessionStart.push(group);
  }
  group.hooks.push({ type: 'command', command, timeout: 5 });
  await writeJsonAtomic(configPath, cfg);
  return { agent: 'droid', installed: true, configPath };
}

async function installKimi(opts: InstallOptions): Promise<InstallResult> {
  const configPath = path.join(opts.home ?? os.homedir(), '.kimi-code', 'config.toml');
  const command = hookCommand('kimi', opts);
  if (opts.dryRun) return { agent: 'kimi', installed: false, configPath };
  let cfg: Record<string, unknown> = {};
  try {
    cfg = TOML.parse(await fs.promises.readFile(configPath, 'utf8')) as Record<string, unknown>;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const hooks = (Array.isArray(cfg.hooks) ? cfg.hooks : []) as Array<Record<string, unknown>>;
  cfg.hooks = [
    ...hooks.filter((hook) => !(typeof hook.command === 'string' && isOwnHookCommand(hook.command))),
    { event: 'SessionStart', command, timeout: 5 },
  ];
  await fs.promises.mkdir(path.dirname(configPath), { recursive: true });
  await fs.promises.writeFile(configPath, TOML.stringify(cfg as Parameters<typeof TOML.stringify>[0]), 'utf8');
  return { agent: 'kimi', installed: true, configPath };
}

async function installHermes(opts: InstallOptions): Promise<InstallResult> {
  const configPath = path.join(opts.home ?? os.homedir(), '.hermes', 'config.yaml');
  const command = hookCommand('hermes', opts);
  if (opts.dryRun) return { agent: 'hermes', installed: false, configPath };
  // Read-modify-write the YAML, preserving every sibling key (mcp_servers, …) —
  // mirrors the CLI's registerHooksForHermes. Hermes maps SessionStart to the
  // `on_session_start` event (HERMES_EVENT_MAP in cli/src/lib/hooks/install.ts).
  let cfg: Record<string, unknown> = {};
  try {
    const parsed = YAML.parse(await fs.promises.readFile(configPath, 'utf8'));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) cfg = parsed as Record<string, unknown>;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const hooks =
    cfg.hooks && typeof cfg.hooks === 'object' && !Array.isArray(cfg.hooks)
      ? (cfg.hooks as Record<string, Array<Record<string, unknown>>>)
      : {};
  const existing = Array.isArray(hooks.on_session_start) ? hooks.on_session_start : [];
  hooks.on_session_start = [
    ...existing.filter(
      (h) => !(typeof h?.command === 'string' && isOwnHookCommand(h.command)),
    ),
    { command, timeout: 5 },
  ];
  cfg.hooks = hooks;
  await fs.promises.mkdir(path.dirname(configPath), { recursive: true });
  await fs.promises.writeFile(configPath, YAML.stringify(cfg), 'utf8');
  return { agent: 'hermes', installed: true, configPath };
}

/**
 * Per-agent support for the SessionStart state-writer hook — the single source of
 * truth, replacing a hardcoded switch whose `default` lumped "not wired up yet"
 * together with "genuinely can't host it" under one opaque "not yet implemented"
 * (RUSH-2205). Keyed by {@link AgentId}, so TypeScript forces an entry for every
 * agent and the completeness test can assert each is either installable or carries
 * a specific reason. The writer needs BOTH a native SessionStart hook the tracker
 * can write AND a `hook.sh` branch that parses the harness's payload:
 *
 *   - gemini      — hard-deprecated; kept only for parsing old sessions/config.
 *   - antigravity — its native config has no SessionStart event (only
 *                   before_tool_call / after_model_call / on_loop_stop / on_error).
 *   - opencode    — SessionStart is delivered by a generated TS plugin
 *                   (session.created), not a shell-command hook this tracker emits.
 *
 * openclaw and rush are absent from this package's {@link AgentId} entirely — the
 * former has no native SessionStart hook host, the latter is the Rush app, not a
 * hook-bearing harness — so the writer cannot reach them at all. Their headless
 * rows still surface via the discovery comm-map (cli/src/lib/session/active.ts).
 */
type HookSupport =
  | { install: (opts: InstallOptions) => Promise<InstallResult> }
  | { unsupported: string };

const HOOK_SUPPORT: Record<AgentId, HookSupport> = {
  claude: { install: installClaude },
  codex: { install: installCodex },
  cursor: { install: installCursor },
  grok: { install: installGrok },
  droid: { install: installDroid },
  kimi: { install: installKimi },
  hermes: { install: installHermes },
  gemini: { unsupported: 'gemini is hard-deprecated (kept only for parsing old sessions)' },
  antigravity: { unsupported: 'antigravity has no SessionStart hook event' },
  opencode: { unsupported: 'opencode SessionStart is a generated plugin, not a shell-command hook' },
};

/** Every agent id the hook installer knows — the keys of the compile-time-complete
 *  {@link HOOK_SUPPORT} table (Record<AgentId, …>), so this can never drift from AgentId. */
export const HOOK_AGENTS = Object.keys(HOOK_SUPPORT) as AgentId[];

export async function installHookFor(
  agent: AgentId,
  opts: InstallOptions = {},
): Promise<InstallResult> {
  const support = HOOK_SUPPORT[agent];
  if (!support) {
    return { agent, installed: false, configPath: '', error: `unknown agent '${agent}'` };
  }
  if ('unsupported' in support) {
    return { agent, installed: false, configPath: '', error: support.unsupported };
  }
  try {
    return await support.install(opts);
  } catch (err) {
    return {
      agent,
      installed: false,
      configPath: '',
      error: (err as Error).message,
    };
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const agents = process.argv.slice(2) as AgentId[];
  if (agents.length === 0) {
    console.error('usage: tsx src/install-hook.ts <agent> [<agent>...]');
    process.exit(2);
  }
  for (const a of agents) {
    const r = await installHookFor(a);
    console.log(JSON.stringify(r));
    if (r.error) process.exitCode = 1;
  }
}
