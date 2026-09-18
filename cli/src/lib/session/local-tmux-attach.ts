/**
 * Attach a LIVE tmux pane on THIS box, with zero SSH — the local half of the
 * PHNX-3292 product rule: "first unique match wins, local before fleet."
 *
 * `agents tmux ls` prints `ag-<agent>-<8hex>` names. A selector that already
 * names one of those panes (the full alias, or its bare 8-hex suffix when it
 * is unique among LIVE local panes) is attached directly — no session index
 * lookup, no fleet SSH fan-out. `sessions resume`, the deprecated `sessions
 * attach`, and `sessions focus` all take this gate before anything else.
 *
 * Lives outside `commands/` (not in focus.ts) so `sessions-resume.ts` and
 * `attach.ts` can both import it without a focus.ts <-> sessions-resume.ts
 * import cycle (focus.ts already imports from sessions-resume.ts).
 */
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

/**
 * Classify a selector against the live tmux server. Split from the attach so the
 * decision is testable against a real tmux server without replacing the caller's
 * shell (attaching is not something a test can undo).
 */
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

/**
 * A local `ag-<agent>-<8hex>` alias names a pane on THIS box. Attach it
 * without any fleet SSH. `--device` keeps the sweep: the caller scoped
 * identity to another machine.
 */
export function shouldAttachLocalTmuxAliasBeforeFleet(
  selector: string | undefined,
  hosts: string[],
): selector is string {
  return !!selector && hosts.length === 0 && isAgentTmuxAlias(selector);
}

/**
 * Attach a live tmux session named exactly as the selector, without needing the
 * session index to know anything about it.
 *
 * SES-41 requires a `ag-<agent>-<8hex>` tmux alias to resolve, but the alias's
 * hex is the LAUNCH id, not the harness session id, and for a harness that
 * writes no `state/sessions/<pid>.json` record there is no mapping back to a
 * SessionMeta at all. The pane is the thing the user asked for, and its NAME is
 * sufficient to attach it — so an unattributable session is still reachable
 * instead of being a dead end that forces raw `tmux -S … attach`.
 *
 * Returns false when this is not an alias, the server/session is absent, or
 * every pane is dead — the caller then continues to normal id resolution.
 * SES-39's "re-read `pane_dead` immediately before attach" is honoured here:
 * liveness is queried at attach time, not read from a roster.
 */
async function attachLiveTmuxAlias(selector: string): Promise<boolean> {
  const socket = getDefaultSocketPath();
  if (await resolveTmuxAliasState(selector, socket) !== 'live') return false;

  if (!process.stdout.isTTY) {
    console.error(chalk.red(`"${selector}" is a live tmux session, but attaching needs a TTY.`));
    console.error(chalk.gray(`  Run it from a terminal, or: agents tmux attach ${selector}`));
    process.exitCode = 1;
    return true;
  }
  // Already inside a tmux client on this socket — which is the normal state for
  // an interactive agent session here — MOVE that client instead of nesting a
  // second one. jumpTo (go.ts) does the same; attaching from inside tmux
  // otherwise stacks clients rather than taking you to the session.
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

/**
 * Resolve a bare 8-hex selector (`agents tmux ls`'s hex column, typed without
 * the `ag-<agent>-` prefix) against LIVE local panes only. Dead panes matching
 * the suffix are excluded before the uniqueness check — a retained, exited pane
 * must never compete with (or block) a live one for the same short id.
 *
 * Exported for direct testing: `attachLocalLiveSelector` composes this with a
 * real `attachTmux()` call, which a unit test cannot safely invoke (it takes
 * over the terminal).
 */
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

/**
 * The full local gate (PHNX-3292 rule 1): a selector that is either a live
 * local tmux alias, or a bare 8-hex short id that names exactly one live local
 * pane, attaches immediately — zero SSH. `--device`/`hosts` scopes identity to
 * another machine and disables this gate entirely (rule 4).
 *
 * Two LIVE local panes matching the same 8-hex suffix fail closed (rule 5): a
 * collision is reported with both names rather than guessing, and the caller
 * must not fall through to fleet resolution for a selector that is genuinely
 * ambiguous ON THIS BOX.
 *
 * Returns `false` (never attached, never reported) when the selector does not
 * name a live local pane at all, so the caller can continue to session-id
 * resolution / the fleet race.
 */
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
