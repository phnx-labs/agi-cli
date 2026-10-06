
import { appleScriptStr } from './quote.js';
import { runSpec, type HostResolver } from './transport.js';
import { itermBackend, ghosttyBackend } from './backends/index.js';
import { currentContext, type LaunchSpec, type EngineContext } from './types.js';

export type InjectTarget =
  | { backend: 'tmux'; pane: string; socket?: string }
  | { backend: 'iterm'; session?: string }
  | { backend: 'vscodium'; terminalId: string; cli: string; scheme: string }
  | { backend: 'ghostty'; window?: string };

export type InjectBackend = InjectTarget['backend'];

export interface InjectOptions {
  enter?: boolean;
  combined?: boolean;
  socket?: string;
  host?: string;
  resolveHost?: HostResolver;
  ctx?: EngineContext;
  dryRun?: boolean;
  deadlineMs?: number;
  paste?: boolean;
}

export interface InjectResult {
  ok: boolean;
  backend: InjectBackend;
  confirmed: boolean;
  writes: number;
  started: number;
  specs?: LaunchSpec[];
  error?: string;
}

function backendConfirmsDelivery(backend: InjectBackend): boolean {

  return backend !== 'vscodium';
}

const CR = '\r';

export const BRACKETED_PASTE_START = '\u001b[200~';
export const BRACKETED_PASTE_END = '\u001b[201~';

export function backendCarriesPaste(backend: InjectBackend): boolean {

  return backend === 'tmux';
}


export function tmuxSendKeysArgv(
  pane: string,
  keys: string,
  opts: { literal?: boolean; socket?: string } = {},
): string[] {
  const argv = ['tmux'];
  if (opts.socket) argv.push('-S', opts.socket);
  argv.push('send-keys', '-t', pane);
  if (opts.literal) argv.push('-l');
  argv.push('--', keys);
  return argv;
}

export function tmuxInjectSpecs(
  target: Extract<InjectTarget, { backend: 'tmux' }>,
  text: string,
  o: { enter: boolean; combined: boolean; socket?: string },
): LaunchSpec[] {

  const socket = o.socket ?? target.socket;
  if (o.enter && o.combined) {
    return [{ argv: tmuxSendKeysArgv(target.pane, text + CR, { literal: true, socket }) }];
  }
  const specs: LaunchSpec[] = [{ argv: tmuxSendKeysArgv(target.pane, text, { literal: true, socket }) }];
  if (o.enter) specs.push({ argv: tmuxSendKeysArgv(target.pane, 'Enter', { socket }) });
  return specs;
}


export function itermInjectScript(text: string, opts: { session?: string; enter: boolean; combined?: boolean }): string {
  const body: string[] =
    opts.enter && opts.combined
      ? [`write text ${appleScriptStr(text)}`]
      : opts.enter
        ? [`write text ${appleScriptStr(text)} newline no`, 'write text (character id 13) newline no']
        : [`write text ${appleScriptStr(text)} newline no`];

  const target = opts.session
    ? `session id ${appleScriptStr(opts.session)}`
    : 'current session of current window';

  return [
    'tell application "iTerm2"',
    `  tell ${target}`,
    ...body.map((l) => `    ${l}`),
    '  end tell',
    'end tell',
  ].join('\n');
}

export function ghosttyInjectScript(text: string, opts: { window?: string; enter: boolean }): string {
  const lines: string[] = ['tell application "System Events"', '  tell process "ghostty"', '    set frontmost to true'];
  if (opts.window) {
    lines.push(`    perform action "AXRaise" of (first window whose title contains ${appleScriptStr(opts.window)})`);
  }
  lines.push('  end tell');
  lines.push(`  keystroke ${appleScriptStr(text)}`);
  if (opts.enter) lines.push('  key code 36');
  lines.push('end tell');
  return lines.join('\n');
}

export function appleScriptInjectSpec(
  target: Extract<InjectTarget, { backend: 'iterm' | 'ghostty' }>,
  text: string,
  enter: boolean,
  combined = false,
): LaunchSpec {
  const script =
    target.backend === 'iterm'
      ? itermInjectScript(text, { session: target.session, enter, combined })
      : ghosttyInjectScript(text, { window: target.window, enter });
  return { argv: ['osascript', '-e', script] };
}


const EXTENSION_AUTHORITY = 'swarmify.swarm-ext';

export function vscodiumInjectUri(
  scheme: string,
  terminalId: string,
  text: string,
  opts: { enter: boolean; combined: boolean },
): string {
  const payload = { terminalId, text, enter: opts.enter, combined: opts.combined };
  const p = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  return `${scheme}://${EXTENSION_AUTHORITY}/inject?p=${p}`;
}

export function vscodiumInjectSpec(
  target: Extract<InjectTarget, { backend: 'vscodium' }>,
  text: string,
  opts: { enter: boolean; combined: boolean },
): LaunchSpec {
  return { argv: [target.cli, '--open-url', vscodiumInjectUri(target.scheme, target.terminalId, text, opts)] };
}


export async function injectIntoTerminal(
  target: InjectTarget,
  text: string,
  opts: InjectOptions = {},
): Promise<InjectResult> {
  const enter = opts.enter !== false;
  const combined = opts.combined === true;

  if (opts.paste === true && !backendCarriesPaste(target.backend)) {
    return {
      ok: false, confirmed: false, backend: target.backend, writes: 0, started: 0, specs: [],
      error: `The ${target.backend} rail cannot deliver a bracketed paste — open the session and paste it there.`,
    };
  }
  const payload = opts.paste === true ? `${BRACKETED_PASTE_START}${text}${BRACKETED_PASTE_END}` : text;

  const specs =
    target.backend === 'tmux'
      ? tmuxInjectSpecs(target, payload, { enter, combined, socket: opts.socket })
      : target.backend === 'vscodium'
        ? [vscodiumInjectSpec(target, payload, { enter, combined })]
        : [appleScriptInjectSpec(target, payload, enter, combined)];

  const writes =
    target.backend === 'tmux'
      ? specs.length
      : target.backend === 'ghostty'
        ? enter ? 2 : 1
        : enter && !combined ? 2 : 1;

  const confirmed = backendConfirmsDelivery(target.backend);

  if (opts.dryRun) return { ok: true, confirmed, backend: target.backend, writes, started: 0, specs };

  if (target.backend === 'iterm' || target.backend === 'ghostty') {
    if (!opts.host || opts.host === 'local') {
      const backend = target.backend === 'iterm' ? itermBackend : ghosttyBackend;
      const ctx = opts.ctx ?? currentContext();
      if (!backend.isAvailable(ctx)) {
        return { ok: false, confirmed: false, backend: target.backend, writes: 0, started: 0, specs, error: `${backend.label} is not available here (platform ${ctx.platform})` };
      }
    }
  }

  const endMs = opts.deadlineMs === undefined ? undefined : Date.now() + opts.deadlineMs;
  let sent = 0;
  let started = 0;
  for (const spec of specs) {
    const remaining = endMs === undefined ? undefined : endMs - Date.now();
    if (remaining !== undefined && remaining <= 0) {
      return {
        ok: false, confirmed: false, backend: target.backend, writes: sent, started, specs,
        error: `injection ran out of budget after ${sent} of ${specs.length} write(s)`,
      };
    }

    started += 1;
    const res = await runSpec(spec, opts.host, opts.resolveHost, remaining);
    if (!res.ok) {
      return { ok: false, confirmed: false, backend: target.backend, writes: sent, started, specs, error: res.error };
    }
    sent += 1;
  }
  return { ok: true, confirmed, backend: target.backend, writes, started, specs };
}
