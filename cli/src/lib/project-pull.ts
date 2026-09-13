/**
 * Project pull — fast-forward every fleet checkout of a named project.
 *
 * Safety contract (binding for all paths in this module):
 *   - Dirty trees are blocked immediately (no fetch attempted).
 *   - Only checkouts on the remote's default branch are fast-forwarded.
 *   - Local commits ahead of upstream block the pull.
 *   - Fast-forward ONLY — no rebase, no reset, no history rewrite.
 *   - Missing checkouts are reported, never cloned.
 *   - Malformed or partial peer envelopes fail CLOSED and LOUD (the parse
 *     returns `valid: false`, so the peer lands in `parseFailed` and drives a
 *     non-zero exit — never an empty result set that reads as "nothing to do").
 *   - Git hook symlinks are NEVER installed during a pull.
 *
 * The fan-out extends the `projects status` seam: the same
 * `projectRepoTargetsForDef` expansion drives both commands, so they
 * always operate on exactly the same set of directories.
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import chalk from 'chalk';
import { expandLocalHome } from './project-root.js';
import { type ProjectRepoTarget } from './projects.js';
import { type RemoteAgentsJsonParseResult } from './remote-agents-json.js';
import { getRepoCommit, getRemoteUrl, pullRepo } from './git.js';
import { parseOwnerRepoFromRemote } from './registry.js';
import { machineId } from './machine-id.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ProjectPullStatus = 'updated' | 'current' | 'missing' | 'blocked' | 'failed';

export interface ProjectPullResult {
  /** Machine that ran the pull (from {@link machineId}). */
  host: string;
  /** Home-relative path — re-roots on each fleet device. */
  path: string;
  /** Expected GitHub slug, echoed from the target for reference. */
  expectedSlug?: string;
  status: ProjectPullStatus;
  branch?: string;
  upstream?: string;
  /** Short commit hash HEAD was at before the pull. */
  before?: string;
  /** Short commit hash HEAD is at after the pull. */
  after?: string;
  /** Human-readable status or error; present when status is not `current`. */
  message?: string;
}

/** The wire format this machine emits for the fleet fan-out. Fail-closed on parse. */
interface ProjectPullEnvelope {
  schemaVersion: 1;
  kind: 'project-pull';
  /** The emitting machine's {@link machineId} — verified by the caller. */
  machine: string;
  /** Hash of the target list the caller sent — verified before trusting results. */
  targetFingerprint: string;
  results: ProjectPullResult[];
}

// ---------------------------------------------------------------------------
// Target fingerprint
// ---------------------------------------------------------------------------

/**
 * Deterministic hash of a target list so the orchestrator can verify the peer
 * pulled the same set of directories it intended to request. Computed from the
 * canonical `path\0expectedSlug` representation, sorted so insertion order does
 * not matter.
 */
export function fingerprintTargets(targets: ProjectRepoTarget[]): string {
  const lines = targets
    .map((t) => `${t.path}\0${t.expectedSlug ?? ''}`)
    .sort();
  return crypto.createHash('sha256').update(lines.join('\n')).digest('hex').slice(0, 16);
}

// ---------------------------------------------------------------------------
// Target wire encoding (the `pull` → `pull-local` CLI-arg boundary)
// ---------------------------------------------------------------------------

/**
 * Encode a target list as the single `--targets` argument the orchestrating
 * `pull` hands to a peer's hidden `pull-local`.
 *
 * A target is a `{ path, expectedSlug }` PAIR, and both halves must survive the
 * hop: `expectedSlug` is what makes the peer refuse to fast-forward a directory
 * whose `origin` is a different repo, and it is also hashed into
 * {@link fingerprintTargets}. Sending bare paths therefore broke the fan-out
 * twice over — slug verification silently became a no-op on every peer, and the
 * peer's slug-less fingerprint could never match the caller's, so
 * {@link parseProjectPullEnvelope} discarded the peer's whole result set. JSON
 * keeps the pair intact; both transports quote it as one argument
 * (`shellQuote` on bash, `powershellQuote` inside a base64 `-EncodedCommand`
 * on Windows), so no escaping is owed here.
 */
export function encodePullTargets(targets: ProjectRepoTarget[]): string {
  return JSON.stringify(
    targets.map((t) => (t.expectedSlug === undefined ? { path: t.path } : { path: t.path, expectedSlug: t.expectedSlug })),
  );
}

/**
 * The exact `agents …` argv the fleet fan-out runs on each peer. Owned here,
 * beside the decoder, so the two halves of the hop cannot drift apart and a
 * test can exercise the real caller-side arguments rather than a retyped copy.
 */
export function pullLocalArgs(targets: ProjectRepoTarget[]): string[] {
  return ['projects', 'pull-local', '--targets', encodePullTargets(targets)];
}

/**
 * Decode the `--targets` argument back into targets on the peer. THROWS on any
 * malformed input rather than returning a partial list: a peer that cannot tell
 * exactly which directories it was asked to pull must fail loudly, not
 * fast-forward a guessed subset.
 */
export function decodePullTargets(raw: string): ProjectRepoTarget[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('not valid JSON');
  }
  if (!Array.isArray(parsed)) throw new Error('expected a JSON array of targets');
  return parsed.map((x, i) => {
    if (!x || typeof x !== 'object' || Array.isArray(x)) throw new Error(`target ${i} is not an object`);
    const o = x as Record<string, unknown>;
    if (typeof o.path !== 'string' || o.path.length === 0) throw new Error(`target ${i} has no "path"`);
    if (o.expectedSlug !== undefined && typeof o.expectedSlug !== 'string') {
      throw new Error(`target ${i} has a non-string "expectedSlug"`);
    }
    return o.expectedSlug === undefined
      ? { path: o.path }
      : { path: o.path, expectedSlug: o.expectedSlug as string };
  });
}

// ---------------------------------------------------------------------------
// Local pull
// ---------------------------------------------------------------------------

/**
 * Pull each target on THIS machine, sequentially (concurrent worktree writes
 * can corrupt the git index). Returns one result per target.
 *
 * Missing checkouts (no directory or no `.git`) are reported as `missing` and
 * skipped — never cloned. A slug mismatch (the directory's `origin` remote does
 * not match the expected slug) is reported as `blocked`.
 */
export async function pullProjectTargets(
  targets: ProjectRepoTarget[],
  host: string = machineId(),
): Promise<ProjectPullResult[]> {
  const results: ProjectPullResult[] = [];

  for (const target of targets) {
    const absPath = expandLocalHome(target.path);

    // Missing directory or not a git repo: report and skip.
    if (!fs.existsSync(absPath) || !fs.existsSync(path.join(absPath, '.git'))) {
      results.push({
        host,
        path: target.path,
        expectedSlug: target.expectedSlug,
        status: 'missing',
        message: 'Checkout not present on this device',
      });
      continue;
    }

    // Slug verification: if the project def declares a slug, the directory's
    // origin must match it. A mismatch means the path hosts a different repo
    // and we must not fast-forward it under a wrong project's command.
    // An unreadable remote URL or an unrecognised remote shape is also blocked —
    // we cannot confirm the checkout is the right repo, so we fail closed.
    if (target.expectedSlug) {
      const remoteUrl = await getRemoteUrl(absPath);
      if (remoteUrl === null) {
        results.push({
          host,
          path: target.path,
          expectedSlug: target.expectedSlug,
          status: 'blocked',
          message: `Slug verification failed: no origin remote found (expected ${target.expectedSlug})`,
        });
        continue;
      }
      const actualSlug = parseOwnerRepoFromRemote(remoteUrl);
      if (actualSlug === null) {
        results.push({
          host,
          path: target.path,
          expectedSlug: target.expectedSlug,
          status: 'blocked',
          message: `Slug verification failed: cannot parse remote URL "${remoteUrl}" (expected ${target.expectedSlug})`,
        });
        continue;
      }
      if (actualSlug.toLowerCase() !== target.expectedSlug.toLowerCase()) {
        results.push({
          host,
          path: target.path,
          expectedSlug: target.expectedSlug,
          status: 'blocked',
          message: `Slug mismatch: expected ${target.expectedSlug}, found ${actualSlug}`,
        });
        continue;
      }
    }

    // Capture HEAD before the pull for the before→after diff in output.
    // getRepoCommit already returns an 8-char short hash and never throws.
    const beforeRaw = await getRepoCommit(absPath);
    const before = beforeRaw === 'unknown' ? undefined : beforeRaw;

    // Fast-forward in strict mode. The option contract is documented on PullRepoOptions.
    let pull: Awaited<ReturnType<typeof pullRepo>>;
    try {
      pull = await pullRepo(absPath, { mode: 'default-branch-fast-forward' });
    } catch (err) {
      results.push({
        host,
        path: target.path,
        expectedSlug: target.expectedSlug,
        status: 'failed',
        before,
        message: (err as Error).message,
      });
      continue;
    }

    if (!pull.success) {
      results.push({
        host,
        path: target.path,
        expectedSlug: target.expectedSlug,
        status: 'blocked',
        branch: pull.branch,
        before,
        message: pull.error,
      });
      continue;
    }

    const after = pull.commit;
    // Both are 8-char short hashes; equal → already up-to-date.
    const status: ProjectPullStatus = before !== undefined && before !== after ? 'updated' : 'current';
    results.push({
      host,
      path: target.path,
      expectedSlug: target.expectedSlug,
      status,
      branch: pull.branch,
      before,
      after,
    });
  }

  return results;
}

// ---------------------------------------------------------------------------
// Envelope builder (used by the hidden `pull-local` peer command)
// ---------------------------------------------------------------------------

export function buildPullEnvelope(
  results: ProjectPullResult[],
  targets: ProjectRepoTarget[],
): ProjectPullEnvelope {
  return {
    schemaVersion: 1,
    kind: 'project-pull',
    machine: machineId(),
    targetFingerprint: fingerprintTargets(targets),
    results,
  };
}

// ---------------------------------------------------------------------------
// Envelope parser (fail-closed — every validation failure returns [])
// ---------------------------------------------------------------------------

/**
 * Parse a peer's `projects pull-local` stdout. Fails CLOSED **and
 * LOUD**: any structural anomaly (wrong schema version, wrong kind, machine
 * mismatch, fingerprint mismatch, non-array results, malformed rows) returns
 * `{ items: [], valid: false }` rather than silently accepting a partial or
 * spoofed payload.
 *
 * `valid: false` is what makes the failure visible. A bare `[]` normalizes to
 * `{ items: [], valid: true }` in `normalizeRemoteAgentsJsonParse`, so the peer
 * would be recorded as having answered with nothing to report — indistinguishable
 * from a device that genuinely had no work, even though it had already run
 * `git fetch` + `merge --ff-only` or hit a real `blocked`/`failed`. Returning
 * the result shape instead lands the peer in `parseFailed`, which the caller
 * both prints and treats as a non-zero exit.
 */
export function parseProjectPullEnvelope(
  stdout: string,
  machine: string,
  opts: { expectedFingerprint?: string } = {},
): RemoteAgentsJsonParseResult<ProjectPullResult> {
  const rejected = { items: [] as ProjectPullResult[], valid: false };

  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return rejected;
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return rejected;
  const env = parsed as Record<string, unknown>;

  // Every field is load-bearing — a partial envelope is not trusted.
  if (env.schemaVersion !== 1) return rejected;
  if (env.kind !== 'project-pull') return rejected;
  if (typeof env.machine !== 'string' || env.machine !== machine) return rejected;
  if (opts.expectedFingerprint !== undefined && env.targetFingerprint !== opts.expectedFingerprint) return rejected;
  if (!Array.isArray(env.results)) return rejected;

  const validStatuses = new Set<string>(['updated', 'current', 'missing', 'blocked', 'failed']);
  const items: ProjectPullResult[] = [];
  for (const x of env.results as unknown[]) {
    // A malformed ROW is the same class of failure as a malformed envelope:
    // dropping it would hide one directory's real outcome inside an otherwise
    // healthy-looking answer.
    if (!x || typeof x !== 'object' || Array.isArray(x)) return rejected;
    const r = x as Record<string, unknown>;
    if (typeof r.path !== 'string') return rejected;
    if (typeof r.status !== 'string' || !validStatuses.has(r.status)) return rejected;
    const result: ProjectPullResult = {
      host: machine,
      path: r.path,
      status: r.status as ProjectPullStatus,
    };
    if (typeof r.expectedSlug === 'string') result.expectedSlug = r.expectedSlug;
    if (typeof r.branch === 'string') result.branch = r.branch;
    if (typeof r.upstream === 'string') result.upstream = r.upstream;
    if (typeof r.before === 'string') result.before = r.before;
    if (typeof r.after === 'string') result.after = r.after;
    if (typeof r.message === 'string') result.message = r.message;
    items.push(result);
  }
  return { items, valid: true };
}

// ---------------------------------------------------------------------------
// Exit-code predicate
// ---------------------------------------------------------------------------

/**
 * Returns `true` when every pull completed successfully (`updated` or
 * `current`). `missing` paths are skipped by design — their absence does not
 * count as a failure. `blocked` and `failed` paths drive a non-zero exit.
 */
export function projectPullComplete(results: ProjectPullResult[]): boolean {
  return results.every((r) => r.status !== 'blocked' && r.status !== 'failed');
}

// ---------------------------------------------------------------------------
// Human-readable output
// ---------------------------------------------------------------------------

function statusIcon(s: ProjectPullStatus): string {
  switch (s) {
    case 'updated': return chalk.green('✓');
    case 'current': return chalk.dim('·');
    case 'missing': return chalk.yellow('?');
    case 'blocked': return chalk.red('✗');
    case 'failed':  return chalk.red('✗');
  }
}

function statusLabel(r: ProjectPullResult): string {
  switch (r.status) {
    case 'updated': {
      const diff = r.before && r.after ? chalk.dim(` ${r.before}→${r.after}`) : '';
      const br = r.branch ? ` (${r.branch})` : '';
      return `${chalk.green('updated')}${br}${diff}`;
    }
    case 'current': {
      const br = r.branch ? chalk.dim(` (${r.branch})`) : '';
      return `${chalk.dim('already current')}${br}`;
    }
    case 'missing':
      return chalk.yellow('missing — skipped');
    case 'blocked':
      return `${chalk.red('blocked')}${r.message ? chalk.dim(` — ${r.message}`) : ''}`;
    case 'failed':
      return `${chalk.red('failed')}${r.message ? chalk.dim(` — ${r.message}`) : ''}`;
  }
}

/**
 * Print a human-readable per-host / per-path pull summary to stdout, followed
 * by a one-line counts footer. Does not exit — the caller controls the exit code.
 *
 * `unavailableDevices` never answered (offline, no CLI, timed out).
 * `unverifiedDevices` DID answer but their envelope failed verification, so
 * their real outcome is unknown — a strictly worse state than silence, and the
 * one the caller turns into a non-zero exit.
 */
export function printProjectPullSummary(
  projectName: string,
  results: ProjectPullResult[],
  unavailableDevices: string[],
  unverifiedDevices: string[] = [],
): void {
  const counts: Record<ProjectPullStatus, number> = { updated: 0, current: 0, missing: 0, blocked: 0, failed: 0 };
  for (const r of results) counts[r.status]++;

  console.log(chalk.bold(`${projectName}`));

  const hosts = [...new Set(results.map((r) => r.host))].sort();
  for (const host of hosts) {
    const hostResults = results.filter((r) => r.host === host);
    const hasProblems = hostResults.some((r) => r.status === 'blocked' || r.status === 'failed');
    const hostLabel = hasProblems ? chalk.red(host) : chalk.cyan(host);
    console.log(`  ${hostLabel}`);
    for (const r of hostResults) {
      console.log(`    ${statusIcon(r.status)} ${chalk.dim(r.path)} ${statusLabel(r)}`);
    }
  }

  if (unavailableDevices.length > 0) {
    console.log(chalk.gray(`  unavailable: ${unavailableDevices.join(', ')}`));
  }
  if (unverifiedDevices.length > 0) {
    console.log(chalk.red(`  unverified: ${unverifiedDevices.join(', ')} — answered, but the result could not be verified; their checkouts may have changed`));
  }

  const parts: string[] = [];
  if (counts.updated) parts.push(chalk.green(`${counts.updated} updated`));
  if (counts.current) parts.push(chalk.dim(`${counts.current} current`));
  if (counts.missing) parts.push(chalk.yellow(`${counts.missing} missing`));
  if (counts.blocked) parts.push(chalk.red(`${counts.blocked} blocked`));
  if (counts.failed) parts.push(chalk.red(`${counts.failed} failed`));
  console.log(`  ${parts.join(chalk.dim(' · '))}`);
}
