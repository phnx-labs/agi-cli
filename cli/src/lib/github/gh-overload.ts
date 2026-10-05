/** The delegate behind the `gh` PATH shim: routes `gh pr checks` over REST, not GraphQL. Only that
 * verb is handled; all else execs real gh. `--watch` polls REST re-anchored to the live head
 * (PHNX-3042); one-shot falls back to REST only on GraphQL rate limit. Fail open to real gh. */

import { execFile, spawn } from 'child_process';
import { promisify } from 'util';
import { isCiGreen } from './pr-verdict.js';
import { isRateLimitError, pendingCheckSuites, prHead, rollupForSha, type RollupItem } from './rest.js';

const execFileAsync = promisify(execFile);

interface Parsed {
  realGh: string;
  ghArgs: string[];
}

export function parseDelegateArgs(argv: string[]): Parsed {
  let realGh = 'gh';
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--real-gh') {
      realGh = argv[++i] ?? 'gh';
    } else if (argv[i] === '--') {
      rest.push(...argv.slice(i + 1));
      break;
    } else {
      rest.push(argv[i]);
    }
  }
  return { realGh, ghArgs: rest };
}

export interface Target {
  repo: string;
  number: number;
}

const PR_URL = /github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/;

export function repoFromRemote(remoteUrl: string): string | null {
  const m = remoteUrl.trim().match(/github\.com[:/]([^/]+)\/(.+?)(?:\.git)?$/);
  return m ? `${m[1]}/${m[2]}` : null;
}

/** Resolves `{repo, number}` from the `gh pr checks` argv and cwd over git/REST only. Returns
 * null (pass through to real gh) when unresolvable, e.g. no number and no open PR for the
 * branch. */
export async function resolveTarget(
  ghArgs: string[],
  cwd: string,
  realGh: string,
): Promise<Target | null> {
  const idx = ghArgs.indexOf('checks');
  const arg = idx >= 0 ? ghArgs.slice(idx + 1).find((a) => !a.startsWith('-')) : undefined;

  if (arg) {
    const url = arg.match(PR_URL);
    if (url) return { repo: `${url[1]}/${url[2]}`, number: Number(url[3]) };
    if (/^\d+$/.test(arg)) {
      const repo = await repoFromCwd(cwd, ghArgs);
      if (repo) return { repo, number: Number(arg) };
    }
    return null;
  }

  const repo = await repoFromCwd(cwd, ghArgs);
  if (!repo) return null;
  try {
    const branch = (await execFileAsync('git', ['-C', cwd, 'symbolic-ref', '--short', 'HEAD']))
      .stdout.trim();
    if (!branch) return null;
    const owner = repo.split('/')[0];
    const out = await execFileAsync(realGh, [
      'api', `repos/${repo}/pulls`, '--method', 'GET',
      '-f', `head=${owner}:${branch}`, '-f', 'state=open',
      '--jq', '.[0].number // empty',
    ], { env: ghChildEnv() });
    const n = out.stdout.trim();
    return n ? { repo, number: Number(n) } : null;
  } catch {
    return null;
  }
}

async function repoFromCwd(cwd: string, ghArgs: string[]): Promise<string | null> {
  const ri = ghArgs.indexOf('--repo');
  if (ri >= 0 && ghArgs[ri + 1]) return ghArgs[ri + 1];
  try {
    const out = await execFileAsync('git', ['-C', cwd, 'remote', 'get-url', 'origin']);
    return repoFromRemote(out.stdout);
  } catch {
    return null;
  }
}

function ghChildEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  env.AGENTS_GH_SHIM = '1';
  env.GH_NO_COLOR = '1';
  env.GH_PAGER = 'cat';
  env.NO_COLOR = '1';
  delete env.FORCE_COLOR;
  delete env.CLICOLOR_FORCE;
  return env;
}

function restExec(realGh: string) {
  return async (args: string[]): Promise<string> => {
    const { stdout } = await execFileAsync(realGh, args, {
      env: ghChildEnv(),
      maxBuffer: 16 * 1024 * 1024,
    });
    return String(stdout ?? '');
  };
}

function passthrough(realGh: string, ghArgs: string[]): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(realGh, ghArgs, { stdio: 'inherit', env: ghChildEnv() });
    child.on('close', (code) => resolve(code ?? 0));
    child.on('error', () => resolve(127));
  });
}

export function renderRollup(input: RollupItem[], json: boolean): string {
  const rollup = [...input].sort((a, b) => a.name.localeCompare(b.name));
  if (json) {
    return JSON.stringify(
      rollup.map((c) => ({
        name: c.name,
        state: (c.conclusion || c.state || c.status || '').toLowerCase() || 'pending',
        link: c.link ?? '',
      })),
    );
  }
  return rollup
    .map((c) => {
      const s = (c.conclusion || c.state || c.status || 'PENDING').toUpperCase();
      const mark = s === 'SUCCESS' ? '✓' : s === 'SKIPPED' || s === 'NEUTRAL' ? '-' : s === 'FAILURE' || s === 'CANCELLED' || s === 'TIMED_OUT' || s === 'ACTION_REQUIRED' ? '✗' : '*';
      return `${mark} ${c.name}\t${s}${c.link ? `\t${c.link}` : ''}`;
    })
    .join('\n');
}

const NON_TERMINAL = new Set(['IN_PROGRESS', 'QUEUED', 'PENDING', 'WAITING', 'REQUESTED']);

/** True once CI has settled for this SHA. Check-suites only disambiguate an empty rollup (none
 * plus no pending suite is settled, a pending suite means wait). Once real checks exist, ignore
 * suites: some App reviewers leave a suite `queued` forever. */
export function isSettled(rollup: RollupItem[], pendingSuites: number): boolean {
  if (rollup.length === 0) return pendingSuites === 0;
  return rollup.every(
    (c) => !NON_TERMINAL.has((c.conclusion || c.state || c.status || '').toUpperCase()),
  );
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function watchChecks(target: Target, json: boolean, realGh: string): Promise<number> {
  const gh = restExec(realGh);
  const deadline = Date.now() + 30 * 60_000;
  let last = '';
  for (;;) {
    const head = await prHead(target.repo, target.number, gh);
    const [rollup, pending] = await Promise.all([
      rollupForSha(target.repo, head.sha, gh),
      pendingCheckSuites(target.repo, head.sha, gh),
    ]);
    const view = renderRollup(rollup, json);
    if (view && view !== last && !json) { process.stdout.write(view + '\n'); last = view; }
    if (isSettled(rollup, pending)) {
      if (json) process.stdout.write(view + '\n');
      const green = isCiGreen(rollup);
      if (rollup.length === 0) { process.stderr.write('no checks reported on the head commit\n'); return 0; }
      return green ? 0 : 1;
    }
    if (Date.now() > deadline) { process.stderr.write('gh(REST): watch timed out after 30m\n'); return 1; }
    await sleep(10_000);
  }
}

async function checksOnce(
  target: Target | null,
  json: boolean,
  realGh: string,
  ghArgs: string[],
): Promise<number> {
  try {
    const { stdout } = await execFileAsync(realGh, ghArgs, { env: ghChildEnv(), maxBuffer: 16 * 1024 * 1024 });
    process.stdout.write(stdout);
    return 0;
  } catch (err) {
    const e = err as { stderr?: string; stdout?: string; code?: number };
    if (!isRateLimitError(String(e.stderr ?? ''))) {
      if (e.stdout) process.stdout.write(e.stdout);
      if (e.stderr) process.stderr.write(e.stderr);
      return typeof e.code === 'number' ? e.code : 1;
    }
  }
  if (!target) return passthrough(realGh, ghArgs);
  const gh = restExec(realGh);
  const head = await prHead(target.repo, target.number, gh);
  const rollup = await rollupForSha(target.repo, head.sha, gh);
  process.stdout.write(renderRollup(rollup, json) + '\n');
  return isCiGreen(rollup) ? 0 : 1;
}

export async function runGhOverload(argv: string[], cwd: string = process.cwd()): Promise<number> {
  const { realGh, ghArgs } = parseDelegateArgs(argv);

  if (ghArgs[0] !== 'pr' || ghArgs[1] !== 'checks') return passthrough(realGh, ghArgs);

  const json = ghArgs.includes('--json');
  const watch = ghArgs.includes('--watch');
  const target = await resolveTarget(ghArgs, cwd, realGh);

  if (watch) {
    if (!target) return passthrough(realGh, ghArgs);
    return watchChecks(target, json, realGh);
  }
  return checksOnce(target, json, realGh, ghArgs);
}
