import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

export interface PrCheck {
  name: string;
  state: string;
  link?: string;
  workflow?: string;
}

export interface PrReviewComment {
  id: number;
  body: string;
  user?: string;
  path?: string;
  html_url?: string;
}

export interface PrSnapshot {
  prUrl: string;
  sourceTeammate: string | null;
  checks: PrCheck[];
  comments: PrReviewComment[];
}

export const DEFAULT_MAX_WAVES = 3;

export type PrWatchAction =
  | {
      kind: 'ci-fix';
      prUrl: string;
      sourceTeammate: string | null;
      check: PrCheck;
      dedupeKey: string;
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
      kind: 'needs-human';
      prUrl: string;
      sourceTeammate: string | null;
      subject: string;
      waves: number;
      dedupeKey: string;
    };

export type PrWatchSpawnAction = Extract<PrWatchAction, { kind: 'ci-fix' | 'review-fix' }>;

const FAILED_STATES = new Set([
  'FAILURE',
  'ERROR',
  'CANCELLED',
  'TIMED_OUT',
  'ACTION_REQUIRED',
  'STARTUP_FAILURE',
]);

export function isFailedCheck(check: PrCheck): boolean {
  return FAILED_STATES.has((check.state || '').trim().toUpperCase());
}

export function checkDedupeKey(prUrl: string, check: PrCheck): string {
  return `ci:${prUrl}:${check.name}`;
}

export function commentDedupeKey(prUrl: string, comment: PrReviewComment): string {
  return `review:${prUrl}:${comment.id}`;
}

export function needsHumanKey(prUrl: string): string {
  return `needs-human:${prUrl}`;
}

export function decidePrActions(
  snapshot: PrSnapshot,
  handled: ReadonlySet<string>,
  waves: ReadonlyMap<string, number> = new Map(),
  maxWaves: number = DEFAULT_MAX_WAVES
): PrWatchAction[] {
  const actions: PrWatchAction[] = [];
  const { prUrl } = snapshot;
  let projected = waves.get(prUrl) ?? 0;
  let escalated = false;

  const escalate = (subject: string) => {
    if (escalated) return;
    const dedupeKey = needsHumanKey(prUrl);
    if (handled.has(dedupeKey)) return;
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

export function parsePrUrl(prUrl: string): { owner: string; repo: string; number: number } | null {
  const m = prUrl.match(/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
  if (!m) return null;
  return { owner: m[1], repo: m[2], number: Number(m[3]) };
}


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
    return [];
  }
}

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
    return `... (truncated ${stdout.length - maxChars} chars) ...\n` + stdout.slice(-maxChars);
  } catch {
    return '';
  }
}

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


export interface WatchTarget {
  prUrl: string;
  sourceTeammate: string | null;
}

interface PrWatchDeps {
  resolveTargets: () => Promise<WatchTarget[]>;
  pollSnapshot?: (prUrl: string, sourceTeammate: string | null) => Promise<PrSnapshot>;
  fetchLogs?: (check: PrCheck) => Promise<string>;
  react: (action: PrWatchSpawnAction, prompt: string) => Promise<string | null>;
  reactionSettled?: (label: string) => Promise<boolean>;
  onEvent?: (event: PrWatchEvent) => void;
}

export type PrWatchEvent =
  | { type: 'poll'; targets: number; timestamp: string }
  | { type: 'spawned'; action: PrWatchSpawnAction; label: string | null; timestamp: string }
  | { type: 'needs-human'; prUrl: string; subject: string; waves: number; timestamp: string }
  | { type: 'error'; prUrl: string; message: string; timestamp: string };

interface PrWatchOptions {
  intervalMs?: number;
  maxPolls?: number;
  handled?: Set<string>;
  waves?: Map<string, number>;
  maxWaves?: number;
  shouldStop?: () => boolean;
}

interface PrWatchResult {
  polls: number;
  spawned: number;
  neededHuman: number;
  handled: Set<string>;
  waves: Map<string, number>;
  stoppedBy: 'max-polls' | 'signal';
}

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

  const inFlight = new Map<string, string>();

  let polls = 0;
  let spawned = 0;
  let neededHuman = 0;

  for (;;) {
    if (opts.shouldStop?.()) {
      return { polls, spawned, neededHuman, handled, waves, stoppedBy: 'signal' };
    }

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
