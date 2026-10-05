/** One-time 'star us on GitHub' nudge, printed once ever after a user's first successful headline
 * run (`agents run`/`teams`). Like maybeWarnMultiInstall, a marker under the regenerable
 * runtime-state dir records it. Stays out of non-interactive, CI, quiet and JSON output. */

import * as fs from 'fs';
import * as path from 'path';
import chalk from 'chalk';
import { getRuntimeStateDir } from './state.js';

/** Canonical GitHub repo the nudge points at (renamed from agents-cli). */
export const REPO_URL = 'https://github.com/phnx-labs/agi-cli';

/** Sentinel written the first (and only) time the nudge is shown. */
function nudgeSentinelPath(): string {
  return path.join(getRuntimeStateDir(), 'star-nudge-shown');
}

/** Has the star nudge already been shown on this machine? */
export function hasShownStarNudge(): boolean {
  try {
    return fs.existsSync(nudgeSentinelPath());
  } catch {
    return false;
  }
}

/** Inputs to the pure show/skip decision (kept side-effect free for testing). */
export interface StarNudgeContext {
  /** Caller asked for quiet / JSON output. */
  quiet?: boolean;
  /** stdout is attached to an interactive terminal. */
  isTTY: boolean;
  /** CI is set in the environment. */
  ci: boolean;
  /** User opted out via AGENTS_NO_NUDGE=1. */
  optedOut: boolean;
  /** The one-time sentinel already exists. */
  alreadyShown: boolean;
}

/** Pure decision: show the one-time star nudge unless output is quiet/JSON, the terminal is
 * non-interactive, CI is set, the user opted out, or it was already shown. */
export function shouldShowStarNudge(ctx: StarNudgeContext): boolean {
  if (ctx.quiet) return false;
  if (!ctx.isTTY) return false;
  if (ctx.ci) return false;
  if (ctx.optedOut) return false;
  if (ctx.alreadyShown) return false;
  return true;
}

/** Show the one-time star nudge if not yet shown and the context fits. Best-effort: never throws or
 * blocks the run. Skipped for quiet/JSON output, non-interactive stdout, CI, or AGENTS_NO_NUDGE=1. */
export function maybeShowStarNudge(opts: { quiet?: boolean } = {}): void {
  try {
    const show = shouldShowStarNudge({
      quiet: opts.quiet,
      isTTY: Boolean(process.stdout.isTTY),
      ci: Boolean(process.env.CI),
      optedOut: process.env.AGENTS_NO_NUDGE === '1',
      alreadyShown: hasShownStarNudge(),
    });
    if (!show) return;

    // Claim the one-time slot with an atomic exclusive create (O_EXCL): hasShownStarNudge() is
    // only a fast path, since existsSync+write is a TOCTOU race across processes (`agents teams`
    // spawns many). `wx` makes exactly one process succeed; the rest get EEXIST and stay silent.
    const sentinel = nudgeSentinelPath();
    fs.mkdirSync(path.dirname(sentinel), { recursive: true });
    try {
      fs.writeFileSync(sentinel, new Date().toISOString(), { flag: 'wx' });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'EEXIST') return; // another process won the race
      throw e; // real write failure -> caught by the outer best-effort guard
    }

    console.log(
      '\n' +
        chalk.gray('Enjoying agents-cli? Give it a star to help others find it: ') +
        chalk.cyan(REPO_URL),
    );
  } catch {
    /* best-effort: a nudge must never break a successful run */
  }
}
