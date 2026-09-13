/**
 * Autonomous PR lifecycle for teams (issue #338).
 *
 * A team's teammates open PRs. This module watches those PRs and reacts:
 *   - RED CI  -> spawn a fresh fix wave (a teammate --after the one that failed,
 *                with the CI failure logs injected) that pushes a follow-up commit.
 *   - NEW REVIEW COMMENT -> route it to a `bugfix` teammate (--after the source),
 *                with the comment body injected.
 *
 * The DECISION logic here is a pure function (`decidePrActions`) over a snapshot
 * of check results + review comments + a set of already-handled ids. It never
 * touches the network — the poll-based collector (`pollPrSnapshot`, backed by the
 * `gh` CLI) and the orchestrator (`runPrWatch`) sit on top and feed it data. That
 * split keeps the spawn-or-not-spawn logic fully unit-testable (see
 * pr-watch.test.ts) and dedupe-correct.
 *
 * Follow-up (deferred, not required here): replace the poll loop with the
 * event-driven webhook receiver from #331 — `pollPrSnapshot` is the seam where a
 * `check_run` / `pull_request_review_comment` webhook payload would plug in,
 * producing the same PrSnapshot the pure decider already consumes.
 */
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

/**
 * A CI check result. Shaped after `gh pr checks <pr> --json name,state,link,workflow`,
 * where `state` is one of SUCCESS | FAILURE | PENDING | ERROR | CANCELLED | SKIPPING | ...
 *
 * Note on identity: `gh pr checks` exposes NO stable check-run id — `link` is the
 * per-run URL, which changes every time a workflow re-runs. So dedupe keys off the
 * check NAME (stable across re-runs), not the link (see `checkDedupeKey`). `link`
 * is retained only for the human-facing prompt and for scraping run logs.
 */
export interface PrCheck {
  name: string;
  state: string;
  link?: string;
  workflow?: string;
}

/** A PR review comment. Shaped after GitHub's `repos/{owner}/{repo}/pulls/{n}/comments`. */
export interface PrReviewComment {
  id: number;
  body: string;
  user?: string;
  path?: string;
  html_url?: string;
}

/** One PR under watch, with its current CI + comment snapshot. */
export interface PrSnapshot {
  /** The PR URL (https://github.com/{owner}/{repo}/pull/{n}). */
  prUrl: string;
  /**
   * Name of the teammate whose work opened this PR — the `--after` anchor the
   * spawned fix/bugfix teammate links to. Null when the PR can't be traced to a
   * named teammate (the reaction still fires, just without a dependency edge).
   */
  sourceTeammate: string | null;
  checks: PrCheck[];
  comments: PrReviewComment[];
}

/**
 * Default cap on how many fix/bugfix waves pr-watch spawns for a single PR before
 * it gives up and escalates to a human. A persistently-RED PR re-runs CI on every
 * follow-up commit; without a cap the loop would spawn teammates without bound
 * (issue #338). Configurable via `--max-waves`.
 */
export const DEFAULT_MAX_WAVES = 3;

/** A decision to spawn a follow-up teammate. Pure output of `decidePrActions`. */
export type PrWatchAction =
  | {
      kind: 'ci-fix';
      prUrl: string;
      sourceTeammate: string | null;
      check: PrCheck;
      /** Idempotency key — record it in `handled` once acted on so it never re-fires. */
      dedupeKey: string;
      /** 1-based wave number for this PR (used to name the spawned teammate uniquely). */
      wave: number;
    }
  | {
      kind: 'review-fix';
      prUrl: string;
      sourceTeammate: string | null;
      comment: PrReviewComment;
      dedupeKey: string;
      wave: number;
    }
  | {
      /**
       * The per-PR wave budget is exhausted — stop spawning, escalate to a human.
       * Emitted once per PR (deduped via `needsHumanKey`) instead of an N+1th fix.
       */
      kind: 'needs-human';
      prUrl: string;
      sourceTeammate: string | null;
      /** What triggered the escalation (e.g. `CI check "test"`). */
      subject: string;
      /** Waves already spent on this PR when the cap was hit. */
      waves: number;
      dedupeKey: string;
    };

/** The spawnable subset of actions — everything except the `needs-human` escalation. */
export type PrWatchSpawnAction = Extract<PrWatchAction, { kind: 'ci-fix' | 'review-fix' }>;

/**
 * Check states that count as a RED CI failure worth spawning a fix wave for.
 * PENDING / SUCCESS / SKIPPING / NEUTRAL are deliberately excluded — a fix wave
 * only fires on a genuine, terminal failure.
 */
const FAILED_STATES = new Set([
  'FAILURE',
  'ERROR',
  'CANCELLED',
  'TIMED_OUT',
  'ACTION_REQUIRED',
  'STARTUP_FAILURE',
]);

/** True when a check is in a terminal failing state. */
export function isFailedCheck(check: PrCheck): boolean {
  return FAILED_STATES.has((check.state || '').trim().toUpperCase());
}

/**
 * Idempotency key for a failed check on a PR — dedupe by check NAME.
 *
 * The name is the ONLY identity that's stable across re-runs: when a fixer pushes
 * a follow-up commit, GitHub creates a fresh workflow run with a new `link` URL but
 * the SAME check name. Keying off `link` (as an earlier draft did) would treat every
 * re-run as a brand-new failure and spawn an unbounded chain of fixers (issue #338).
 * Keying off the name means a re-run of the same check is recognised as the same
 * logical failure; the per-PR wave counter then bounds how many times we retry it.
 */
export function checkDedupeKey(prUrl: string, check: PrCheck): string {
  return `ci:${prUrl}:${check.name}`;
}

/** Idempotency key for a review comment on a PR — dedupe by comment id. */
export function commentDedupeKey(prUrl: string, comment: PrReviewComment): string {
  return `review:${prUrl}:${comment.id}`;
}

/** Idempotency key for the one-shot "needs human" escalation on a PR. */
export function needsHumanKey(prUrl: string): string {
  return `needs-human:${prUrl}`;
}

/**
 * The pure heart of pr-watch: given a PR snapshot, the set of dedupe keys already
 * acted on, and how many fix waves each PR has already spent, decide which
 * follow-up teammates to spawn. Emits:
 *   - one `ci-fix` action per NEW failed check (dedup by check NAME)
 *   - one `review-fix` action per NEW review comment (dedup by comment id)
 *   - a single `needs-human` action (per PR) once the wave budget is exhausted,
 *     INSTEAD of spawning — so a persistently-failing PR escalates rather than
 *     spawning teammates without bound (issue #338).
 *
 * `waves` maps a PR URL to the number of fix/bugfix teammates already spawned for
 * it; once that reaches `maxWaves`, no further spawns are emitted for that PR.
 * Both the CI-fix and comment-routing paths draw from the SAME per-PR budget, so
 * neither can loop unboundedly.
 *
 * No network, no side effects, no reference to state beyond the passed
 * `handled` / `waves` — so the same failure never spawns twice and the caller
 * stays in control of when a wave is "spent".
 */
export function decidePrActions(
  snapshot: PrSnapshot,
  handled: ReadonlySet<string>,
  waves: ReadonlyMap<string, number> = new Map(),
  maxWaves: number = DEFAULT_MAX_WAVES
): PrWatchAction[] {
  const actions: PrWatchAction[] = [];
  const { prUrl } = snapshot;
  // Waves already spent, plus the ones we're about to emit in THIS pass — so a
  // single pass with several fresh failures can't blow past the budget.
  let projected = waves.get(prUrl) ?? 0;
  let escalated = false;

  const escalate = (subject: string) => {
    if (escalated) return;
    const dedupeKey = needsHumanKey(prUrl);
    if (handled.has(dedupeKey)) return; // already escalated this PR — stay silent
    escalated = true;
    actions.push({
      kind: 'needs-human',
      prUrl,
      sourceTeammate: snapshot.sourceTeammate,
      subject,
      waves: projected,
      dedupeKey,
    });
  };

  for (const check of snapshot.checks) {
    if (!isFailedCheck(check)) continue;
    const dedupeKey = checkDedupeKey(prUrl, check);
    if (handled.has(dedupeKey)) continue;
    if (projected >= maxWaves) {
      escalate(`CI check "${check.name}"`);
      continue;
    }
    projected++;
    actions.push({
      kind: 'ci-fix',
      prUrl,
      sourceTeammate: snapshot.sourceTeammate,
      check,
      dedupeKey,
      wave: projected,
    });
  }

  for (const comment of snapshot.comments) {
    const dedupeKey = commentDedupeKey(prUrl, comment);
    if (handled.has(dedupeKey)) continue;
    if (projected >= maxWaves) {
      escalate(`review comment #${comment.id}`);
      continue;
    }
    projected++;
    actions.push({
      kind: 'review-fix',
      prUrl,
      sourceTeammate: snapshot.sourceTeammate,
      comment,
      dedupeKey,
      wave: projected,
    });
  }

  return actions;
}

/**
 * Build the task prompt for a CI-fix teammate. Pure so it's unit-testable: the
 * failing check + the fetched logs are injected as data.
 */
export function buildCiFixPrompt(action: Extract<PrWatchAction, { kind: 'ci-fix' }>, logs: string): string {
  const logsBlock = logs.trim()
    ? `\n\nCI failure logs:\n\`\`\`\n${logs.trim()}\n\`\`\``
    : `\n\n(No CI logs could be fetched — inspect the run at ${action.check.link ?? action.prUrl}.)`;
  return (
    `CI is RED on PR ${action.prUrl}. The check "${action.check.name}"` +
    (action.check.workflow ? ` (workflow: ${action.check.workflow})` : '') +
    ` failed with state ${action.check.state}. ` +
    `Diagnose the failure from the logs below, fix it, and push a follow-up commit to the SAME PR branch ` +
    `(check out the PR branch with \`gh pr checkout ${action.prUrl}\`, make the fix, commit, and push). ` +
    `Do not open a new PR — push to the existing branch so this PR goes green.` +
    logsBlock
  );
}

/**
 * Build the task prompt for a review-comment bugfix teammate. Pure so it's
 * unit-testable: the review comment is injected as data.
 */
export function buildReviewFixPrompt(action: Extract<PrWatchAction, { kind: 'review-fix' }>): string {
  const c = action.comment;
  const where = c.path ? ` on \`${c.path}\`` : '';
  const who = c.user ? `@${c.user}` : 'A reviewer';
  return (
    `${who} left a review comment${where} on PR ${action.prUrl}. ` +
    `Address it and push a follow-up commit to the SAME PR branch ` +
    `(check out the PR branch with \`gh pr checkout ${action.prUrl}\`, make the change, commit, and push). ` +
    `Do not open a new PR.\n\n` +
    `Review comment:\n${c.body}` +
    (c.html_url ? `\n\n(thread: ${c.html_url})` : '')
  );
}

/** Parse an owner/repo/number triple out of a GitHub PR URL. Returns null when it doesn't match. */
export function parsePrUrl(prUrl: string): { owner: string; repo: string; number: number } | null {
  const m = prUrl.match(/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
  if (!m) return null;
  return { owner: m[1], repo: m[2], number: Number(m[3]) };
}

// ---------------------------------------------------------------------------
// Impure collectors — thin `gh` CLI wrappers. Kept out of the pure decider so
// tests never hit the network. These are the seam the #331 webhook receiver
// would replace: a webhook payload can synthesize the same PrCheck /
// PrReviewComment shapes and hand them straight to decidePrActions.
// ---------------------------------------------------------------------------

/** Fetch the current CI checks for a PR via `gh pr checks`. Returns [] on any gh error. */
async function fetchPrChecks(prUrl: string): Promise<PrCheck[]> {
  try {
    const { stdout } = await execFileAsync(
      'gh',
      ['pr', 'checks', prUrl, '--json', 'name,state,link,workflow'],
      { maxBuffer: 8 * 1024 * 1024 }
    );
    const raw = JSON.parse(stdout) as Array<Record<string, unknown>>;
    return raw.map((r) => ({
      name: String(r.name ?? ''),
      state: String(r.state ?? ''),
      link: r.link ? String(r.link) : undefined,
      workflow: r.workflow ? String(r.workflow) : undefined,
    }));
  } catch {
    // `gh pr checks` exits non-zero when checks are failing OR when none are
    // configured. Both surface as a throw here; treat "can't read" as "nothing
    // to act on" rather than crashing the watch loop.
    return [];
  }
}

/** Fetch review comments for a PR via `gh api`. Returns [] on any gh error. */
async function fetchPrReviewComments(prUrl: string): Promise<PrReviewComment[]> {
  const parsed = parsePrUrl(prUrl);
  if (!parsed) return [];
  try {
    const { stdout } = await execFileAsync(
      'gh',
      [
        'api',
        `repos/${parsed.owner}/${parsed.repo}/pulls/${parsed.number}/comments`,
        '--paginate',
      ],
      { maxBuffer: 16 * 1024 * 1024 }
    );
    const raw = JSON.parse(stdout) as Array<Record<string, unknown>>;
    return raw.map((r) => ({
      id: Number(r.id),
      body: String(r.body ?? ''),
      user:
        r.user && typeof r.user === 'object'
          ? String((r.user as Record<string, unknown>).login ?? '')
          : undefined,
      path: r.path ? String(r.path) : undefined,
      html_url: r.html_url ? String(r.html_url) : undefined,
    }));
  } catch {
    return [];
  }
}

/** Fetch the failing-run logs for a check via `gh run view --log-failed`. Best-effort, truncated. */
async function fetchCiFailureLogs(check: PrCheck, maxChars = 8000): Promise<string> {
  const runId = check.link?.match(/\/runs\/(\d+)/)?.[1] ?? check.link?.match(/\/actions\/runs\/(\d+)/)?.[1];
  if (!runId) return '';
  try {
    const { stdout } = await execFileAsync(
      'gh',
      ['run', 'view', runId, '--log-failed'],
      { maxBuffer: 32 * 1024 * 1024 }
    );
    if (stdout.length <= maxChars) return stdout;
    // Keep the tail — the actual error is almost always at the end of the log.
    return `... (truncated ${stdout.length - maxChars} chars) ...\n` + stdout.slice(-maxChars);
  } catch {
    return '';
  }
}

/** Collect a live PR snapshot from `gh`. The poll-mode seam for `runPrWatch`. */
async function pollPrSnapshot(
  prUrl: string,
  sourceTeammate: string | null
): Promise<PrSnapshot> {
  const [checks, comments] = await Promise.all([
    fetchPrChecks(prUrl),
    fetchPrReviewComments(prUrl),
  ]);
  return { prUrl, sourceTeammate, checks, comments };
}

// ---------------------------------------------------------------------------
// Orchestrator — the poll loop. Deps are injected so the loop is exercisable
// without gh or a real AgentManager; the command wires the real collectors +
// the handleSpawn-backed reactor.
// ---------------------------------------------------------------------------

/** A PR to watch, paired with the teammate that opened it. */
export interface WatchTarget {
  prUrl: string;
  sourceTeammate: string | null;
}

interface PrWatchDeps {
  /** Discover which PRs to watch this pass (teammates may open PRs mid-run). */
  resolveTargets: () => Promise<WatchTarget[]>;
  /** Snapshot one PR's CI + review comments. Defaults to `pollPrSnapshot`. */
  pollSnapshot?: (prUrl: string, sourceTeammate: string | null) => Promise<PrSnapshot>;
  /** Fetch CI failure logs for a ci-fix action. Defaults to `fetchCiFailureLogs`. */
  fetchLogs?: (check: PrCheck) => Promise<string>;
  /**
   * React to one decided spawn action: spawn the fix/bugfix teammate. The prompt
   * is pre-built with logs/comment injected. Return the spawned teammate label for
   * logging, or null if the spawn was skipped. `needs-human` actions never reach
   * here — they surface as a `needs-human` event instead.
   */
  react: (action: PrWatchSpawnAction, prompt: string) => Promise<string | null>;
  /**
   * True when a previously-spawned reaction has finished. Once its fixer settles,
   * the dedupe guard for that check clears so a check that is STILL red can spawn
   * its next (budget-bounded) wave; without this, a check would only ever get one
   * fix attempt per pr-watch run. Optional — when omitted, a check gets a single
   * wave until pr-watch restarts.
   */
  reactionSettled?: (label: string) => Promise<boolean>;
  /** Progress sink — one call per notable event (poll, spawn, escalate, error). */
  onEvent?: (event: PrWatchEvent) => void;
}

export type PrWatchEvent =
  | { type: 'poll'; targets: number; timestamp: string }
  | { type: 'spawned'; action: PrWatchSpawnAction; label: string | null; timestamp: string }
  | { type: 'needs-human'; prUrl: string; subject: string; waves: number; timestamp: string }
  | { type: 'error'; prUrl: string; message: string; timestamp: string };

interface PrWatchOptions {
  intervalMs?: number;
  /** Stop after this many polls (0 / undefined = run until signalled). */
  maxPolls?: number;
  /** Seed of already-handled dedupe keys (e.g. restored from disk). */
  handled?: Set<string>;
  /** Per-PR fix-wave counts, carried across restarts so the budget survives a restart. */
  waves?: Map<string, number>;
  /** Cap on fix waves per PR before escalating to a human. Defaults to DEFAULT_MAX_WAVES. */
  maxWaves?: number;
  /** Abort signal — resolves the loop at the next interval boundary. */
  shouldStop?: () => boolean;
}

interface PrWatchResult {
  polls: number;
  spawned: number;
  /** How many PRs escalated to a human (wave budget exhausted). */
  neededHuman: number;
  handled: Set<string>;
  waves: Map<string, number>;
  stoppedBy: 'max-polls' | 'signal';
}

/**
 * Run the pr-watch poll loop. Each pass: retire the dedupe guards of any fixers
 * that have finished (so a still-red check can spawn its next wave), resolve watch
 * targets, snapshot each PR, decide actions against the running `handled` set and
 * per-PR `waves` budget, then react — spawning fresh fixers, or emitting a
 * one-shot `needs-human` event once a PR's wave budget is spent. Every acted-on
 * dedupe key is recorded so a failure/comment never spawns twice within a wave,
 * and `waves` hard-caps the total spawns per PR (issue #338).
 */
export async function runPrWatch(
  deps: PrWatchDeps,
  opts: PrWatchOptions = {}
): Promise<PrWatchResult> {
  const intervalMs = opts.intervalMs ?? 15000;
  const maxPolls = opts.maxPolls ?? 0;
  const maxWaves = opts.maxWaves ?? DEFAULT_MAX_WAVES;
  const handled = opts.handled ?? new Set<string>();
  const waves = opts.waves ?? new Map<string, number>();
  const pollSnapshot = deps.pollSnapshot ?? pollPrSnapshot;
  const fetchLogs = deps.fetchLogs ?? fetchCiFailureLogs;
  const emit = deps.onEvent ?? (() => {});

  // dedupeKey -> spawned teammate label, for the settle sweep. When a fixer
  // finishes, its guard clears so the next wave (if still warranted) can fire.
  const inFlight = new Map<string, string>();

  let polls = 0;
  let spawned = 0;
  let neededHuman = 0;

  for (;;) {
    if (opts.shouldStop?.()) {
      return { polls, spawned, neededHuman, handled, waves, stoppedBy: 'signal' };
    }

    // Retire guards for finished fixers so a check that's STILL red after a fix
    // can spawn its next wave (bounded by `waves`). Skipped when no settle probe
    // is wired — then a check gets one wave until pr-watch restarts.
    if (deps.reactionSettled && inFlight.size > 0) {
      for (const [key, label] of [...inFlight]) {
        let done = false;
        try {
          done = await deps.reactionSettled(label);
        } catch {
          done = false;
        }
        if (done) {
          handled.delete(key);
          inFlight.delete(key);
        }
      }
    }

    const targets = await deps.resolveTargets();
    polls++;
    emit({ type: 'poll', targets: targets.length, timestamp: new Date().toISOString() });

    for (const target of targets) {
      let snap: PrSnapshot;
      try {
        snap = await pollSnapshot(target.prUrl, target.sourceTeammate);
      } catch (err) {
        emit({
          type: 'error',
          prUrl: target.prUrl,
          message: (err as Error).message,
          timestamp: new Date().toISOString(),
        });
        continue;
      }

      const actions = decidePrActions(snap, handled, waves, maxWaves);
      for (const action of actions) {
        // Record the key BEFORE reacting so a spawn failure can't loop-spam the
        // same failure — a bad action is dropped, not retried forever.
        handled.add(action.dedupeKey);

        if (action.kind === 'needs-human') {
          neededHuman++;
          emit({
            type: 'needs-human',
            prUrl: action.prUrl,
            subject: action.subject,
            waves: action.waves,
            timestamp: new Date().toISOString(),
          });
          continue;
        }

        // Spend a wave from this PR's budget for the spawn we're about to make.
        waves.set(action.prUrl, (waves.get(action.prUrl) ?? 0) + 1);
        const prompt =
          action.kind === 'ci-fix'
            ? buildCiFixPrompt(action, await fetchLogs(action.check))
            : buildReviewFixPrompt(action);
        try {
          const label = await deps.react(action, prompt);
          spawned++;
          if (label) inFlight.set(action.dedupeKey, label);
          emit({ type: 'spawned', action, label, timestamp: new Date().toISOString() });
        } catch (err) {
          emit({
            type: 'error',
            prUrl: action.prUrl,
            message: (err as Error).message,
            timestamp: new Date().toISOString(),
          });
        }
      }
    }

    if (maxPolls > 0 && polls >= maxPolls) {
      return { polls, spawned, neededHuman, handled, waves, stoppedBy: 'max-polls' };
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}
