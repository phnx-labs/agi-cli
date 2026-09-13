/**
 * Terminal injection — Gap 2 of the Terminal Engine.
 *
 * Where the rest of the engine OPENS a surface (a tab / split running a
 * command), injection types into an ALREADY-running surface. It's the primitive
 * a native watchdog (RUSH-1415) needs to nudge a stalled agent with "continue"
 * delivered into the exact terminal that agent lives in — the gap flagged in
 * src/lib/session/provenance.ts:20:
 *
 *   > Actually delivering the keystrokes is Gap 2 (pty/tmux send-keys).
 *
 * It mirrors the engine's shape exactly: pure per-backend spec builders (like
 * `tmuxTabArgv` / `itermTabScript`) produce a `LaunchSpec` (argv), and the same
 * `runSpec` transport runs it — so injection inherits the engine's local/remote
 * (`--device` over SSH) execution for free. A `LaunchSpec` never opens anything;
 * building one is side-effect-free and unit-testable without a display.
 *
 * Backends (each addresses the EXACT split, not the frontmost surface):
 *   - tmux  → `tmux send-keys -t <pane>` — the send-keys primitive addressed by
 *             pane id + socket (the exact rail provenance.ts identifies).
 *   - iterm (macOS) → AppleScript `tell session id "<uuid>" to write text` —
 *             addresses the precise iTerm2 split by its session UUID WITHOUT
 *             `activate`, so it never steals focus or types into the wrong split.
 *             Uses the engine's `appleScriptStr` escaper; guarded by the iterm
 *             backend's `isAvailable` (platform + app installed).
 *   - vscodium (VSCodium / Cursor / VS Code) → the editor CLI's `--open-url`
 *             into the swarmify `swarm-ext` extension's `/inject` verb, targeting
 *             a live-terminals.json terminal by id. Focus-independent, exact
 *             terminal, and (like the launch backend, src/lib/terminal/backends/
 *             vscodium-agent.ts) works over `--device` SSH and on Linux.
 *   - ghostty (macOS) → COARSE only: Ghostty has no scripting dictionary, so
 *             there is no per-split addressing — this raises a window and types
 *             via System Events keystrokes, stealing focus. The resolver refuses
 *             to route here by default (see resolve.ts); it stays behind an
 *             explicit opt-in.
 *
 * Ink-TUI Enter semantics: Claude's Ink TUI swallows an Enter fused to the text,
 * so the default path delivers the text and the Enter as TWO SEPARATE writes
 * (swarmify's `sendText(text,false)` then `sendText('\r',false)`). `combined`
 * opts into one fused write for plain shells / REPLs.
 */

import { appleScriptStr } from './quote.js';
import { runSpec, type HostResolver } from './transport.js';
import { itermBackend, ghosttyBackend } from './backends/index.js';
import { currentContext, type LaunchSpec, type EngineContext } from './types.js';

/**
 * An already-running surface to type into. A superset of the engine's launch
 * `Backend`.
 */
export type InjectTarget =
  | { backend: 'tmux'; pane: string; socket?: string }
  | { backend: 'iterm'; session?: string }
  /**
   * A VSCodium / Cursor / VS Code integrated terminal, addressed by the id the
   * swarm-ext extension keys `live-terminals.json` on (the session UUID). `cli`
   * is the editor CLI on PATH (`codium` / `cursor` / `code`); `scheme` is its
   * URL scheme (`vscodium` / `cursor` / `vscode`) — the resolver fills both.
   */
  | { backend: 'vscodium'; terminalId: string; cli: string; scheme: string }
  | { backend: 'ghostty'; window?: string };

export type InjectBackend = InjectTarget['backend'];

export interface InjectOptions {
  /** Append Enter after the text. Default true. */
  enter?: boolean;
  /**
   * Fuse the text and its Enter into a SINGLE write. Default false — the safe
   * default sends the text, then the Enter, as two separate writes (Ink-TUI
   * safe). Set true for plain shells / REPLs that want one atomic line.
   */
  combined?: boolean;
  /** tmux socket override (defaults to `target.socket`, then tmux's default socket). */
  socket?: string;
  /** Remote host for the tmux / AppleScript backends (runs the spec over SSH). Local by default. */
  host?: string;
  /** Resolve a host alias to an ssh target (see the engine's transport). */
  resolveHost?: HostResolver;
  /** Ambient context for the availability check (defaults to the live process context). */
  ctx?: EngineContext;
  /** Don't execute — return the spec(s) that WOULD run. Lets the macOS paths be asserted on Linux. */
  dryRun?: boolean;
  /**
   * Frame the text in bracketed-paste markers so a TUI inserts it verbatim
   * instead of reading each embedded newline as a submit. Required for a
   * multiline free-text answer. Only the tmux rail can carry it (see
   * {@link backendCarriesPaste}); every other backend refuses with an error.
   */
  paste?: boolean;
}

export interface InjectResult {
  ok: boolean;
  backend: InjectBackend;
  /**
   * Delivery is CONFIRMED to have reached the running agent, not merely dispatched.
   *
   * For tmux / iterm / ghostty, `ok` already means delivered: `tmux
   * send-keys` errors on a missing pane, `osascript write text` errors on a bad
   * session id — so a successful transport IS the confirmation. For **vscodium**, `ok` only means the
   * editor CLI accepted the `--open-url` hand-off; whether the swarm-ext extension
   * actually parsed the verb and typed anything is unknown from the CLI side (the
   * ext must ack — RUSH follow-up). So vscodium is delivered-but-UNCONFIRMED, and
   * the watchdog must not book a nudge as landed on that alone.
   */
  confirmed: boolean;
  /** Discrete writes delivered: 2 for the Ink-safe text+Enter split, 1 when combined or enter=false. */
  writes: number;
  /** For the tmux / AppleScript backends (or any dryRun), the spec(s) that ran / would run. */
  specs?: LaunchSpec[];
  error?: string;
}

/**
 * Whether a successful transport on this backend CONFIRMS delivery to the agent.
 * Everything but vscodium self-confirms (see InjectResult.confirmed); vscodium's
 * `--open-url` is fire-and-forget until the swarm-ext extension acks the verb.
 */
function backendConfirmsDelivery(backend: InjectBackend): boolean {
  return backend !== 'vscodium';
}

/** Carriage return — what Enter delivers into a raw PTY/tmux byte stream. */
const CR = '\r';

/**
 * Bracketed-paste framing (DEC mode 2004) — the pty contract for "insert this
 * verbatim, do not submit". A readline/Ink composer that sees the start marker
 * buffers every byte up to the end marker, so an embedded newline lands as a
 * literal newline in the draft instead of submitting the partial line.
 */
export const BRACKETED_PASTE_START = '[200~';
export const BRACKETED_PASTE_END = '[201~';

/**
 * Only tmux can carry the framing: `send-keys -l` writes the marker bytes
 * straight to the pty. ghostty simulates keystrokes, vscodium hands a JSON
 * payload to the extension, and iTerm's AppleScript `write text` cannot encode
 * a raw ESC byte — so a paste request on those is refused rather than
 * half-delivered as one submit per line.
 */
export function backendCarriesPaste(backend: InjectBackend): boolean {
  return backend === 'tmux';
}

// --- tmux -------------------------------------------------------------------

/**
 * argv for `tmux send-keys` targeting a pane by id. Starts with `tmux` (like the
 * engine's `tmuxTabArgv`) so the same transport runs it locally or over SSH. The
 * socket, when set, is positioned before the subcommand (`-S` must lead). `-l`
 * sends the keys literally; without it tmux interprets a key name like `Enter`.
 *
 * NOTE: distinct from `sendKeys()` in src/lib/tmux/session.ts — that one
 * addresses by session *name* on the default socket (the `agents tmux` surface)
 * and shells out directly; this one addresses by *pane id* + arbitrary socket and
 * returns an SSH-capable `LaunchSpec` for the engine transport. Don't collapse them.
 */
export function tmuxSendKeysArgv(
  pane: string,
  keys: string,
  opts: { literal?: boolean; socket?: string } = {},
): string[] {
  const argv = ['tmux'];
  if (opts.socket) argv.push('-S', opts.socket);
  argv.push('send-keys', '-t', pane);
  if (opts.literal) argv.push('-l');
  argv.push(keys);
  return argv;
}

/** The one-or-two send-keys specs for a tmux injection (Ink-safe split by default). */
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
  // A separate Enter keypress — its own write, so the Ink TUI sees Enter alone.
  if (o.enter) specs.push({ argv: tmuxSendKeysArgv(target.pane, 'Enter', { socket }) });
  return specs;
}

// --- macOS (iterm / ghostty) ------------------------------------------------

/**
 * AppleScript that types into a SPECIFIC iTerm2 split via `tell session id
 * "<uuid>" to write text` — the exact split provenance's iterm rail identifies,
 * addressed by its session UUID. Crucially there is NO `activate`: `write text`
 * delivers to that session directly, so injection never brings iTerm forward or
 * types into whatever split happens to be focused. Omitting `session` targets
 * the current session (a direct-call convenience; the resolver always supplies
 * one).
 *
 * Enter semantics — iTerm's `write text` appends a trailing newline, which fuses
 * text+Enter into ONE write and Claude's Ink TUI swallows it. So the Ink-safe
 * default (enter, not combined) suppresses that newline (`write text … newline
 * no`) and sends the Return as a SEPARATE `write text` of a lone CR (`character
 * id 13`) — two distinct pty writes, Enter seen on its own. `combined` opts into
 * the single fused `write text` (auto-newline) for plain shells / REPLs.
 *
 * NOTE (macOS-only verification pending): the two-write CR path is the safe
 * choice because it mirrors the tmux/pty Ink-safe split that IS verified here on
 * Linux; whether a single `write text T` would also submit under Ink can only be
 * confirmed on a Mac running iTerm (see the PR body).
 */
export function itermInjectScript(text: string, opts: { session?: string; enter: boolean; combined?: boolean }): string {
  // Two writes for the Ink-safe default; one fused write for combined / enter=false.
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

/**
 * AppleScript for Ghostty (no scripting dictionary): raise the target window via
 * System Events, then keystroke the text and a separate Return. `window` matches
 * a window whose title contains the string; omitted → the frontmost Ghostty window.
 */
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

/** The osascript spec for a macOS injection. One invocation delivers the text + Return. */
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

// --- vscodium (VSCodium / Cursor / VS Code integrated terminal) -------------

/** The swarmify extension identifier that owns the swarm-ext URI verbs (matches the launch backend). */
const EXTENSION_AUTHORITY = 'swarmify.swarm-ext';

/**
 * The `<scheme>://swarmify.swarm-ext/inject?p=<payload>` URL the extension
 * handles to type into an ALREADY-open integrated terminal (the inject sibling
 * of the launch backend's `/spawn`, src/lib/terminal/backends/vscodium-agent.ts).
 *
 * Payload is base64url-encoded JSON in a single `p` param — identical encoding
 * to `spawnUri`, and for the same reason: VS Code percent-decodes `uri.query`
 * once before the extension parses it, so a naive multi-param query would
 * mis-split a text containing `&`/`=`; base64url (`[A-Za-z0-9_-]`) survives that
 * decode untouched. `terminalId` is the id the extension keys live-terminals.json
 * on (the session UUID); `enter` tells the extension to submit; `combined` asks
 * it to fuse text+Enter into one write (default is the Ink-safe two-write split,
 * mirroring the tmux/iterm paths — the extension owns that split on its side).
 *
 * DEPENDENCY: the `/inject` verb ships in the swarm-ext extension via PR #608's
 * successor (PR #608 introduces `/spawn`; the inject verb + `write`/`enter`
 * handling is its follow-up). Until that lands, this routes correctly on the CLI
 * side but the extension will no-op the unknown verb. See the PR body.
 */
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

/** The editor-CLI spec for a VSCodium/Cursor/VS Code injection (one `--open-url` invocation). */
export function vscodiumInjectSpec(
  target: Extract<InjectTarget, { backend: 'vscodium' }>,
  text: string,
  opts: { enter: boolean; combined: boolean },
): LaunchSpec {
  return { argv: [target.cli, '--open-url', vscodiumInjectUri(target.scheme, target.terminalId, text, opts)] };
}

// --- public entry -----------------------------------------------------------

/**
 * Deliver `text` (+ Enter) into an existing terminal surface. Resolves the
 * target's backend and routes to the matching primitive. Never throws — launch
 * failures come back in the result, like the engine's `openSurface`.
 */
export async function injectIntoTerminal(
  target: InjectTarget,
  text: string,
  opts: InjectOptions = {},
): Promise<InjectResult> {
  const enter = opts.enter !== false;
  const combined = opts.combined === true;

  // Fail loud at the rail boundary: a backend that cannot carry the markers must
  // not silently deliver the raw text, which submits once per embedded newline.
  if (opts.paste === true && !backendCarriesPaste(target.backend)) {
    return {
      ok: false, confirmed: false, backend: target.backend, writes: 0, specs: [],
      error: `The ${target.backend} rail cannot deliver a bracketed paste — open the session and paste it there.`,
    };
  }
  const payload = opts.paste === true ? `${BRACKETED_PASTE_START}${text}${BRACKETED_PASTE_END}` : text;

  // tmux + AppleScript + editor-CLI backends all run through the engine transport.
  const specs =
    target.backend === 'tmux'
      ? tmuxInjectSpecs(target, payload, { enter, combined, socket: opts.socket })
      : target.backend === 'vscodium'
        ? [vscodiumInjectSpec(target, payload, { enter, combined })]
        : [appleScriptInjectSpec(target, payload, enter, combined)];

  // Discrete writes delivered on the far side. tmux counts its send-keys calls.
  // iterm/vscodium honor `combined` (text+Enter fused into one write). ghostty's
  // coarse keystroke path ignores `combined` (it always emits keystroke + a
  // separate Return), so its count tracks `enter` alone.
  const writes =
    target.backend === 'tmux'
      ? specs.length
      : target.backend === 'ghostty'
        ? enter ? 2 : 1
        : enter && !combined ? 2 : 1;

  const confirmed = backendConfirmsDelivery(target.backend);

  if (opts.dryRun) return { ok: true, confirmed, backend: target.backend, writes, specs };

  // AppleScript backends: guard on the backend's own availability, but only for a
  // LOCAL run (a remote host is assumed to have the app — its ssh leg reports failure).
  if (target.backend === 'iterm' || target.backend === 'ghostty') {
    if (!opts.host || opts.host === 'local') {
      const backend = target.backend === 'iterm' ? itermBackend : ghosttyBackend;
      const ctx = opts.ctx ?? currentContext();
      if (!backend.isAvailable(ctx)) {
        return { ok: false, confirmed: false, backend: target.backend, writes: 0, specs, error: `${backend.label} is not available here (platform ${ctx.platform})` };
      }
    }
  }

  for (const spec of specs) {
    const res = await runSpec(spec, opts.host, opts.resolveHost);
    if (!res.ok) return { ok: false, confirmed: false, backend: target.backend, writes: 0, specs, error: res.error };
  }
  return { ok: true, confirmed, backend: target.backend, writes, specs };
}
