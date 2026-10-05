/** Attach a live tmux pane on this box with zero SSH (PHNX-3292: first unique match wins, local
 * before fleet). Lives outside focus.ts to avoid an import cycle with sessions-resume.ts. */
import fs from 'node:fs';
import chalk from 'chalk';
import { attachTmux, ensureSessionHookRepaired, getDefaultSocketPath, hasSession, listSessions, runTmux, teardownIfAgentExited } from '../tmux/index.js';
import { isAgentTmuxAlias } from '@phnx-labs/sessions-cli/reader';

export type TmuxAliasState = 'not-an-alias' | 'no-server' | 'absent' | 'dead' | 'live';

/** Width of `SessionMeta.shortId` / the hex an `ag-<agent>-<8hex>` alias embeds. */
const SHORT_SESSION_ID_RE = /^[0-9a-f]{8}$/i;

/** Shape of the tmux alias the CLI mints for an agent session: `ag-<agent>-<shortid>`.
 * Delegates to the one canonical matcher beside the name parsers in active.ts. */
export function looksLikeTmuxAlias(selector: string): boolean {
  return isAgentTmuxAlias(selector);
}

/** Classify a selector against the live tmux server; split from the attach so tests need not
 * replace the shell. */
export async function resolveTmuxAliasState(selector: string, socket?: string): Promise<TmuxAliasState> {
  if (!looksLikeTmuxAlias(selector)) return 'not-an-alias';
  const sock = socket ?? getDefaultSocketPath();
  if (!fs.existsSync(sock)) return 'no-server';
  if (!(await hasSession(selector, sock).catch(() => false))) return 'absent';

  const panes = await runTmux({
    socket: sock,
    args: ['list-panes', '-t', `=${selector}`, '-F', '#{pane_dead}'],
  }).catch(() => undefined);
  const states = (panes?.stdout ?? '').split('\n').map(s => s.trim()).filter(Boolean);
  return states.some(d => d === '0') ? 'live' : 'dead';
}

/** A local `ag-<agent>-<8hex>` alias names a pane on this box and attaches without fleet SSH.
 * `--device` keeps the sweep because the caller scoped identity to another machine. */
export function shouldAttachLocalTmuxAliasBeforeFleet(
  selector: string | undefined,
  hosts: string[],
): selector is string {
  return !!selector && hosts.length === 0 && isAgentTmuxAlias(selector);
}

/** Attach a live tmux session named exactly as the selector, without the session index (SES-41).
 * The alias hex is the launch id, not the harness session id, so the pane's name must suffice.
 * Liveness is re-read at attach time (SES-39); false lets the caller resolve by id. */
async function attachLiveTmuxAlias(selector: string): Promise<boolean> {
  const socket = getDefaultSocketPath();
  if (await resolveTmuxAliasState(selector, socket) !== 'live') return false;

  if (!process.stdout.isTTY) {
    console.error(chalk.red(`"${selector}" is a live tmux session, but attaching needs a TTY.`));
    console.error(chalk.gray(`  Run it from a terminal, or: agents tmux attach ${selector}`));
    process.exitCode = 1;
    return true;
  }
  // Already inside a tmux client on this socket: move that client (as jumpTo in go.ts does)
  // instead of nesting a second one.
  if (process.env.TMUX) {
    await runTmux({ socket, args: ['switch-client', '-t', `=${selector}`], throwOnError: false }).catch(() => {});
    console.log(chalk.gray(`Switched this tmux client to ${selector}.`));
    return true;
  }
  console.log(chalk.gray(`Attaching ${selector} — Ctrl-b d to detach.`));
  // Repair a legacy/stale pane-died hook before handing the session to an
  // attach client — the 5-min daemon reconcile that used to cover this was
  // deleted; attach-time repair is what closes the gap now (RUSH-2435).
  await ensureSessionHookRepaired(selector, socket);
  const code = await attachTmux({ socket, args: ['attach-session', '-t', `=${selector}`] });
  await teardownIfAgentExited(selector, socket);
  process.exitCode = code;
  return true;
}

type LocalAliasBySuffix =
  | { kind: 'alias'; alias: string }
  | { kind: 'collision'; aliases: string[] }
  | { kind: 'none' };

/** Resolve a bare 8-hex selector against live local panes only; dead panes are excluded before the
 * uniqueness check. Exported for tests because attachTmux() takes over the terminal. */
export async function resolveUniqueLocalLiveAliasBySuffix(shortId: string, socket?: string): Promise<LocalAliasBySuffix> {
  const sock = socket ?? getDefaultSocketPath();
  if (!fs.existsSync(sock)) return { kind: 'none' };
  let sessions;
  try {
    sessions = await listSessions({ socket: sock });
  } catch {
    return { kind: 'none' };
  }
  const named = sessions
    .map((session) => session.name)
    .filter((name) => isAgentTmuxAlias(name) && name.toLowerCase().endsWith(shortId.toLowerCase()));
  if (named.length === 0) return { kind: 'none' };

  const states = await Promise.all(named.map(async (name) => ({ name, state: await resolveTmuxAliasState(name, sock) })));
  const live = states.filter((entry) => entry.state === 'live').map((entry) => entry.name);
  if (live.length === 0) return { kind: 'none' };
  if (live.length > 1) return { kind: 'collision', aliases: live };
  return { kind: 'alias', alias: live[0] };
}

/** The local gate (PHNX-3292 rules 1, 4, 5): a live alias or a unique live 8-hex id attaches with
 * zero SSH; `--device`/`hosts` disables it. Two live panes with one suffix fail closed with both
 * names reported, with no fall-through to the fleet. */
export async function attachLocalLiveSelector(selector: string | undefined, hosts: string[]): Promise<boolean> {
  if (shouldAttachLocalTmuxAliasBeforeFleet(selector, hosts)) {
    return attachLiveTmuxAlias(selector);
  }
  if (!selector || hosts.length > 0 || !SHORT_SESSION_ID_RE.test(selector)) return false;

  const found = await resolveUniqueLocalLiveAliasBySuffix(selector);
  if (found.kind === 'none') return false;
  if (found.kind === 'collision') {
    console.error(chalk.red(`"${selector}" matches ${found.aliases.length} live local panes: ${found.aliases.join(', ')}`));
    console.error(chalk.gray('  Pass the full alias to disambiguate — see: agents tmux ls'));
    process.exitCode = 1;
    return true;
  }
  return attachLiveTmuxAlias(found.alias);
}
