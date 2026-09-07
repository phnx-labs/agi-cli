/**
 * Desktop notification when a headless `agents run` finishes (`--notify`).
 *
 * The notifying process is the one that OWNS the run. That is the whole point:
 * the menu bar's quick dispatch used to post its completion notice from the
 * dispatching MenubarHelper's process-termination callback, so a helper that
 * restarted (an upgrade, a crash) took the callback with it — the run kept
 * going, reparented to launchd, and no notification could ever fire. Posting
 * from the run process instead means the notice survives anything that happens
 * to the menu bar, and `notifyDesktop` spawns a FRESH one-shot notifier, so it
 * does not need a helper to have been running at dispatch time either.
 *
 * Armed once via `process.on('exit')` so it covers every way the run command
 * terminates — local spawn, `--device` dispatch, `--lease` box, the error path —
 * rather than being sprinkled over ~50 `process.exit` call sites where the next
 * new exit path would silently miss it.
 */
import * as path from 'path';
import { notifyDesktop, type DesktopNotification } from './menubar/notify-desktop.js';

export interface RunNotifyContext {
  /** Agent that ran, e.g. `claude`. */
  agent: string;
  /** `--name` slug when the caller named the run; falls back to the agent. */
  name?: string;
  /** The prompt, used for a one-line reminder of what the run was about. */
  prompt?: string;
  /** Working directory the run was scoped to; its basename names the project. */
  cwd?: string;
  /** Machine the run executed on, when it was dispatched off-box. */
  host?: string;
  /** Clickable target — a PR/ticket URL the caller already knows. */
  url?: string;
  /** Session id the run coined, so the banner can open/focus it. */
  sessionId?: string;
  /** Report/log path the run produced — becomes the `open-report` choice + `open:` action. */
  reportPath?: string;
}

/** Notification body cap: a banner truncates anyway, and a wall of text is noise. */
const BODY_MAX = 120;

function shorten(text: string, max = BODY_MAX): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/**
 * The finish notification for one run. Pure — the exit handler and the tests
 * both build through here, so what ships is what is asserted.
 */
export function buildRunFinishNotification(
  ctx: RunNotifyContext,
  exitCode: number,
): DesktopNotification {
  const label = ctx.name?.trim() || ctx.agent;
  const project = ctx.cwd ? path.basename(ctx.cwd) : undefined;
  const where = [project, ctx.host].filter(Boolean).join(' · ');
  const ok = exitCode === 0;
  const n: DesktopNotification = {
    title: ok ? `${label} finished` : `${label} failed`,
    body: shorten(ctx.prompt?.trim() || `${ctx.agent} run`),
    // The harness that ran becomes the banner's right-hand avatar, so a finished
    // run is identifiable at a glance even when `--name` renamed the title.
    agent: ctx.agent,
    // Categorize so the companion can offer the run's follow-up buttons; a
    // failed run gets the failure category, a clean one the done category.
    category: ok ? 'done' : 'failure',
  };
  if (where) n.subtitle = where;
  if (ctx.sessionId) n.sessionId = ctx.sessionId;
  // The primary click target: a report opens the report file, else the PR url.
  if (ctx.reportPath) n.action = `open:${ctx.reportPath}`;
  else if (ctx.url) n.action = `url:${ctx.url}`;
  // Follow-up buttons the companion renders: open the report when one exists,
  // open the PR when a url is known. `open-report` reuses the `open:` action
  // resolution; `open-pr` opens `ctx.url`.
  const choices: { id: string; label: string }[] = [];
  if (ctx.reportPath) choices.push({ id: 'open-report', label: 'Open report' });
  if (ctx.url) choices.push({ id: 'open-pr', label: 'Open PR' });
  if (choices.length) n.choices = choices;
  return n;
}

/**
 * Post the finish notification when this process exits. Best-effort by
 * construction: `notifyDesktop` swallows its own failures, and a run killed
 * outright (SIGKILL) never reaches an exit handler — that is the documented
 * limit, not a case to paper over.
 */
export function armRunFinishNotification(ctx: RunNotifyContext): void {
  process.on('exit', (code) => {
    notifyDesktop(buildRunFinishNotification(ctx, code));
  });
}
