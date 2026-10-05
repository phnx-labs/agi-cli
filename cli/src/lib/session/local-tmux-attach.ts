import fs from 'node:fs';
import chalk from 'chalk';
import { attachTmux, ensureSessionHookRepaired, getDefaultSocketPath, hasSession, listSessions, runTmux, teardownIfAgentExited } from '../tmux/index.js';
import { isAgentTmuxAlias } from '@phnx-labs/sessions-cli/reader';

export type TmuxAliasState = 'not-an-alias' | 'no-server' | 'absent' | 'dead' | 'live';

const SHORT_SESSION_ID_RE = /^[0-9a-f]{8}$/i;

export function looksLikeTmuxAlias(selector: string): boolean {
  return isAgentTmuxAlias(selector);
}

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

export function shouldAttachLocalTmuxAliasBeforeFleet(
  selector: string | undefined,
  hosts: string[],
): selector is string {

  return !!selector && hosts.length === 0 && isAgentTmuxAlias(selector);
}

async function attachLiveTmuxAlias(selector: string): Promise<boolean> {
  const socket = getDefaultSocketPath();
  if (await resolveTmuxAliasState(selector, socket) !== 'live') return false;

  if (!process.stdout.isTTY) {
    console.error(chalk.red(`"${selector}" is a live tmux session, but attaching needs a TTY.`));
    console.error(chalk.gray(`  Run it from a terminal, or: agents tmux attach ${selector}`));
    process.exitCode = 1;
    return true;
  }
  if (process.env.TMUX) {
    await runTmux({ socket, args: ['switch-client', '-t', `=${selector}`], throwOnError: false }).catch(() => {});
    console.log(chalk.gray(`Switched this tmux client to ${selector}.`));
    return true;
  }
  console.log(chalk.gray(`Attaching ${selector} — Ctrl-b d to detach.`));
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
