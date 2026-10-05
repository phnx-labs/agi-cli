
import * as fs from 'fs';
import * as path from 'path';
import chalk from 'chalk';
import { getRuntimeStateDir } from './state.js';

export const REPO_URL = 'https://github.com/phnx-labs/agi-cli';

function nudgeSentinelPath(): string {
  return path.join(getRuntimeStateDir(), 'star-nudge-shown');
}

export function hasShownStarNudge(): boolean {
  try {
    return fs.existsSync(nudgeSentinelPath());
  } catch {
    return false;
  }
}

export interface StarNudgeContext {
  quiet?: boolean;
  isTTY: boolean;
  ci: boolean;
  optedOut: boolean;
  alreadyShown: boolean;
}

export function shouldShowStarNudge(ctx: StarNudgeContext): boolean {
  if (ctx.quiet) return false;
  if (!ctx.isTTY) return false;
  if (ctx.ci) return false;
  if (ctx.optedOut) return false;
  if (ctx.alreadyShown) return false;
  return true;
}

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

    const sentinel = nudgeSentinelPath();
    fs.mkdirSync(path.dirname(sentinel), { recursive: true });
    try {
      fs.writeFileSync(sentinel, new Date().toISOString(), { flag: 'wx' });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'EEXIST') return;
      throw e;
    }

    console.log(
      '\n' +
        chalk.gray('Enjoying agents-cli? Give it a star to help others find it: ') +
        chalk.cyan(REPO_URL),
    );
  } catch {
  }
}
