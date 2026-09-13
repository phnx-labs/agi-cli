/**
 * The delegate behind the `gh` PATH shim (`agents __gh --real-gh <path> -- <argv>`).
 *
 * Agents are statically trained to type `gh pr checks …`; the shim intercepts that
 * habit and routes it here so the rate-limit-prone read runs over REST instead of
 * GraphQL — no new command for an agent to remember. This is the Tier-1 scope:
 * only `gh pr checks` is handled; every other invocation execs the real gh
 * byte-for-byte (the shim already passes non-`pr checks` verbs straight to real gh,
 * and this file passes through defensively for anything it cannot cleanly serve).
 *
 * Two switch modes (see the PHNX-3501 plan):
 *   - `--watch` → EAGER REST: own the poll loop, re-anchored to the live head SHA
 *     each tick, so a superseded run's red can never be reported (PHNX-3042).
 *   - one-shot → LAZY: run real gh first; only translate to REST when it fails with
 *     the exact GraphQL rate-limit signal. An over-budget GraphQL call is rejected
 *     at 0 points, so this is nearly free and never reproduces gh's happy path.
 *
 * Fail-open is the rule: anything not cleanly resolvable (no PR number/URL, an
 * unmappable request) execs real gh rather than returning wrong data.
 */

import { execFile, spawn } from 'child_process';
import { promisify } from 'util';
import { isCiGreen } from './pr-verdict.js';
import { isRateLimitError, pendingCheckSuites, prHead, rollupForSha, type RollupItem } from './rest.js';

const execFileAsync = promisify(execFile);

interface Parsed {
  realGh: string;
  ghArgs: string[];
}

/** Split `--real-gh <path> -- <gh argv>`; defaults realGh to bare `gh`. */
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

/** owner/repo from a git remote URL, or null. */
export function repoFromRemote(remoteUrl: string): string | null {
  const m = remoteUrl.trim().match(/github\.com[:/]([^/]+)\/(.+?)(?:\.git)?$/);
  return m ? `${m[1]}/${m[2]}` : null;
}

/**
 * Resolve `{repo, number}` from the `gh pr checks` argv + cwd, over git/REST only.
 * Returns null (→ caller passes through to real gh) when it can't be resolved
 * cleanly, e.g. no number and no open PR for the current branch.
 */
export async function resolveTarget(
  ghArgs: string[],
  cwd: string,
  realGh: string,
): Promise<Target | null> {
  // `pr checks <n|url>` — the arg after "checks", if any.
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

  // No number: resolve the open PR for the current branch over REST.
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

/** `--repo owner/name` on the argv wins; else derive from cwd's origin remote. */
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

/** Env for any real-gh child: mark the shim sentinel + strip color (FORCE_COLOR breaks JSON). */
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

/** A REST GhExec bound to the real gh + sentinel env, so it never re-enters the shim. */
function restExec(realGh: string) {
  return async (args: string[]): Promise<string> => {
    const { stdout } = await execFileAsync(realGh, args, {
      env: ghChildEnv(),
      maxBuffer: 16 * 1024 * 1024,
    });
    return String(stdout ?? '');
  };
}

/** Passthrough: exec real gh inheriting stdio, resolve its exit code. */
function passthrough(realGh: string, ghArgs: string[]): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(realGh, ghArgs, { stdio: 'inherit', env: ghChildEnv() });
    child.on('close', (code) => resolve(code ?? 0));
    child.on('error', () => resolve(127));
  });
}

/** Render one rollup as `gh pr checks`-ish lines (or JSON when asked). */
export function renderRollup(input: RollupItem[], json: boolean): string {
  // Sort by name so identical states render identically across polls — otherwise
  // non-deterministic REST/Map order defeats the watch's change-detection dedup.
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

/**
 * True once CI has settled for this SHA.
 *
 * Check-suites only disambiguate an EMPTY rollup: no checks + no pending suites is
 * "genuinely none" (settled); no checks + a pending suite is "not registered yet"
 * (wait). Once real checks exist we decide on THEM alone and ignore suites — some
 * App integrations (claude/cursor reviewers) register a suite that stays `queued`
 * forever and never posts a run, exactly what `gh pr checks` also ignores.
 */
export function isSettled(rollup: RollupItem[], pendingSuites: number): boolean {
  if (rollup.length === 0) return pendingSuites === 0;
  return rollup.every(
    (c) => !NON_TERMINAL.has((c.conclusion || c.state || c.status || '').toUpperCase()),
  );
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Eager REST watch: poll to a terminal state, re-anchored to the live head SHA. */
async function watchChecks(target: Target, json: boolean, realGh: string): Promise<number> {
  const gh = restExec(realGh);
  const deadline = Date.now() + 30 * 60_000; // 30-min guard against a hung matrix
  let last = '';
  for (;;) {
    const head = await prHead(target.repo, target.number, gh); // re-anchor each tick
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

/** Lazy one-shot: real gh first; translate to REST only on the exact rate-limit signal. */
async function checksOnce(
  target: Target | null,
  json: boolean,
  realGh: string,
  ghArgs: string[],
): Promise<number> {
  // Try real gh, capturing output so we can detect the rate-limit signal.
  try {
    const { stdout } = await execFileAsync(realGh, ghArgs, { env: ghChildEnv(), maxBuffer: 16 * 1024 * 1024 });
    process.stdout.write(stdout);
    return 0;
  } catch (err) {
    const e = err as { stderr?: string; stdout?: string; code?: number };
    if (!isRateLimitError(String(e.stderr ?? ''))) {
      // A real failure (checks failing, bad flag). Pass gh's own output/exit through.
      if (e.stdout) process.stdout.write(e.stdout);
      if (e.stderr) process.stderr.write(e.stderr);
      return typeof e.code === 'number' ? e.code : 1;
    }
  }
  // Rate-limited: serve from REST if we can resolve the PR, else re-raise real gh.
  if (!target) return passthrough(realGh, ghArgs);
  const gh = restExec(realGh);
  const head = await prHead(target.repo, target.number, gh);
  const rollup = await rollupForSha(target.repo, head.sha, gh);
  process.stdout.write(renderRollup(rollup, json) + '\n');
  return isCiGreen(rollup) ? 0 : 1;
}

/** Entry point for the `__gh` early branch in index.ts. */
export async function runGhOverload(argv: string[], cwd: string = process.cwd()): Promise<number> {
  const { realGh, ghArgs } = parseDelegateArgs(argv);

  // Only `pr checks` is Tier-1. Anything else → real gh, untouched.
  if (ghArgs[0] !== 'pr' || ghArgs[1] !== 'checks') return passthrough(realGh, ghArgs);

  const json = ghArgs.includes('--json');
  const watch = ghArgs.includes('--watch');
  const target = await resolveTarget(ghArgs, cwd, realGh);

  if (watch) {
    if (!target) return passthrough(realGh, ghArgs); // can't resolve → let real gh try
    return watchChecks(target, json, realGh);
  }
  return checksOnce(target, json, realGh, ghArgs);
}
