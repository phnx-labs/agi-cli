/** Daemon-generated session titles (PHNX-3797), anchored in what the user asked, not the agent's
 * latest line. Rung 1: the user's first message, instantly. Rung 2: a cheap model's ACTION+OBJECT
 * title, made ONCE in the daemon, keyed by sessionTitleSourceKey; consumers read the row. */

import { createHash } from 'node:crypto';
import type { AgentId } from '../types.js';
// Type-only, plus dynamic imports inside the tick: the pure helpers here are
// read by render paths that must not pull the SQLite index into a listing.
import type { SessionTitleCandidateRow } from './db.js';

/** The phrase every title prompt carries, a stable sentinel (not the human instruction).
 * `traces/sync.ts` uses it to classify the session as `utility`, and isSessionTitlePrompt uses it
 * so the titler never titles its own sessions (a runaway loop). */
export const SESSION_TITLE_PROMPT_MARKER = 'Generate a concise session headline';

/** Hard ceiling on a stored title; the prompt asks for far less. */
export const SESSION_TITLE_MAX_CHARS = 60;
/** Hard ceiling on words kept from a model reply that ignored the word budget. */
export const SESSION_TITLE_MAX_WORDS = 8;
/** How much user text the prompt carries — enough to be specific, bounded for cost. */
export const SESSION_TITLE_INPUT_MAX_CHARS = 2000;

/** How many sessions one periodic sweep may generate for. */
export const SESSION_TITLE_MAX_PER_TICK = 2;
/** How many recent rows a sweep inspects before picking that batch. */
export const SESSION_TITLE_CANDIDATE_SCAN = 200;
/** Only sessions active within this window are titled — older rows are not shown. */
export const SESSION_TITLE_MAX_AGE_MS = 14 * 24 * 60 * 60_000;
/** Per-generation subprocess ceiling. A title is not worth waiting on. */
export const SESSION_TITLE_TIMEOUT_MS = 45_000;

/** The harnesses the titler will run as, best first. The first installed one wins. */
export const SESSION_TITLE_AGENTS = ['claude', 'codex', 'grok', 'kimi', 'opencode'] as const;

/** The user text a title is derived from, plus the context that makes it technical. */
export interface SessionTitleInput {
  firstUserMessage?: string | null;
  topic?: string | null;
  project?: string | null;
  ticketId?: string | null;
  gitBranch?: string | null;
}

/** The user text itself — the ONLY thing the source key is computed over. */
export function sessionTitleSourceText(input: SessionTitleInput): string {
  const raw = (input.firstUserMessage || input.topic || '').replace(/\s+/g, ' ').trim();
  return raw.length > SESSION_TITLE_INPUT_MAX_CHARS ? raw.slice(0, SESSION_TITLE_INPUT_MAX_CHARS) : raw;
}

/** Stable identity of the text a title was generated from, stored beside the title so 'already
 * titled' differs from 'first message changed' without keeping a copy of the text. Empty text
 * yields `null`. */
export function sessionTitleSourceKey(input: SessionTitleInput): string | null {
  const text = sessionTitleSourceText(input);
  if (!text) return null;
  return createHash('sha256').update(text).digest('hex').slice(0, 16);
}

/** True when this text is one of the titler's own prompts. The titler runs a real harness whose
 * transcript becomes another untitled session, so without this guard every title would create work
 * for the next sweep forever. */
export function isSessionTitlePrompt(...values: Array<string | null | undefined>): boolean {
  return values.some((v) => typeof v === 'string' && v.includes(SESSION_TITLE_PROMPT_MARKER));
}

/** The one-shot prompt for the cheap model: an action + object headline ("Triage the AGI board"),
 * not a bare noun or a sentence. The word budget is soft here and hard-enforced by
 * sanitizeGeneratedTitle's SESSION_TITLE_MAX_WORDS. */
export function renderSessionTitlePrompt(input: SessionTitleInput): string {
  const text = sessionTitleSourceText(input);
  const context = [
    input.project ? `Repository: ${input.project}` : null,
    input.ticketId ? `Ticket: ${input.ticketId}` : null,
    input.gitBranch ? `Branch: ${input.gitBranch}` : null,
  ].filter(Boolean);
  return [
    `${SESSION_TITLE_PROMPT_MARKER} naming what this coding session is working on.`,
    'Write an ACTION + OBJECT headline of 4 to 8 words — a verb phrase naming the concrete task,',
    'e.g. "Triage the AGI board" or "Rename browser profile — default confusion".',
    'NOT a single noun, NOT a full sentence. Name the concrete feature, component, or fix —',
    'not the person, not the pleasantries.',
    'Respond IMMEDIATELY with only the headline. Do NOT investigate, do NOT read files, do NOT use any tools.',
    'No quotes, no trailing punctuation, no explanation.',
    ...(context.length ? ['', ...context] : []),
    '',
    "The user's request:",
    '---',
    text,
    '---',
  ].join('\n');
}

/** Reduce a model reply to a storable title, or undefined. Takes the first non-empty line, strips
 * wrapping quotes and trailing punctuation, and applies word and character ceilings; a refusal or
 * explanation fails them and is dropped. */
export function sanitizeGeneratedTitle(raw: string | null | undefined): string | undefined {
  if (!raw) return undefined;
  const firstLine = raw.split('\n').map((l) => l.trim()).find((l) => l.length > 0);
  if (!firstLine) return undefined;
  let title = firstLine
    .replace(/^["'`*_\s]+/, '')
    .replace(/["'`*_\s]+$/, '')
    .replace(/[.!?,;:]+$/, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!title) return undefined;
  // A model that ignored the budget gets truncated, not shown in full — a
  // paragraph in the headline slot is the very failure this feature removes.
  const words = title.split(' ');
  if (words.length > SESSION_TITLE_MAX_WORDS) title = words.slice(0, SESSION_TITLE_MAX_WORDS).join(' ');
  if (title.length > SESSION_TITLE_MAX_CHARS) title = title.slice(0, SESSION_TITLE_MAX_CHARS).trimEnd();
  // Never store the prompt back as a title (a harness that echoed its input).
  if (isSessionTitlePrompt(title)) return undefined;
  return title || undefined;
}

/** Compile-time guard: resolves to `T` only if `T` declares a `generatedTitle` key, else `never`. A
 * parameter typed `{ generatedTitle?: string }` accepts types lacking it, which let the watchdog's
 * `SessionOutcome` silently degrade the headline to `label || topic`. */
type CarriesTitleRung<T> = 'generatedTitle' extends keyof T ? T : never;

/** Headline for an indexed row on the live ladder (`deriveSessionRecap`): `/rename` label,
 * generated title, first-prompt topic; every `agents sessions` surface reads it here (PHNX-3797).
 * A row type lacking `generatedTitle` fails to compile (CarriesTitleRung): fix it, don't cast. */
export function sessionHeadline<
  T extends { label?: string | null; generatedTitle?: string | null; topic?: string | null },
>(row: CarriesTitleRung<T>): string | undefined {
  return row.label || row.generatedTitle || row.topic || undefined;
}

/* Proof that CarriesTitleRung still works, checked by the ordinary `tsc` run rather than a test
 * (tests are excluded from tsconfig; spawning a compiler cost ~15s of required CI, PHNX-3797). */
type IsNever<T> = [T] extends [never] ? true : false;
type AssertTrue<T extends true> = T;
type AssertFalse<T extends false> = T;

/** The shape of a projection that dropped the rung — the watchdog's old `SessionOutcome`. */
type RungLessRow = { label?: string | null; topic?: string | null };

// A row type that never modelled `generatedTitle` must NOT be callable.
type _rungLessRowIsRejected = AssertTrue<IsNever<CarriesTitleRung<RungLessRow>>>;
// A real carrier — optional key included — must still be callable.
type _realCarrierIsAccepted = AssertFalse<IsNever<CarriesTitleRung<SessionTitleCandidateRow>>>;

/** Runs the cheap model once and returns its raw stdout. Injectable so tests cover the whole
 * tick without spawning a harness. */
export type SessionTitleRunner = (prompt: string, signal?: AbortSignal) => Promise<string>;

/** The harness the titler runs as on this box, or null when none is installed. */
export async function resolveSessionTitleAgent(): Promise<string | null> {
  // Lazy import: this module is also imported by render paths that must not pull
  // the installation store (and its filesystem probes) into a hot listing.
  const { listInstalledVersions } = await import('../installations/store.js');
  for (const agent of SESSION_TITLE_AGENTS) {
    try {
      if (listInstalledVersions(agent as AgentId).length > 0) return agent;
    } catch {
      // An unreadable store for one agent must not hide the others.
    }
  }
  return null;
}

/** The real runner: one `agents run <agent> --mode plan --model cheap <prompt>` subprocess. `--mode
 * plan` keeps it read-only, and `--model cheap` uses the normal tier resolution instead of a
 * hardcoded model id that ages out. */
export async function defaultSessionTitleRunner(prompt: string, signal?: AbortSignal): Promise<string> {
  const [{ getAgentsInvocation }, { execFile }, { promisify }] = await Promise.all([
    import('../daemon/daemon.js'),
    import('node:child_process'),
    import('node:util'),
  ]);
  const agent = await resolveSessionTitleAgent();
  if (!agent) throw new Error('no installed harness can generate a session title');
  const inv = getAgentsInvocation(['run', agent, '--mode', 'plan', '--model', 'cheap', prompt]);
  const { stdout } = await promisify(execFile)(inv.command, inv.args, {
    encoding: 'utf8',
    maxBuffer: 1024 * 1024,
    timeout: SESSION_TITLE_TIMEOUT_MS,
    signal,
  });
  return stdout;
}

/** Pluggable backend turning a session's user text into a raw headline reply, the one
 * model-host-specific part of title generation (PHNX-3797). A local backend (e.g. ollama) is a
 * drop-in; sanitizeGeneratedTitle enforces ceilings. A throw means no title this sweep. */
export interface SessionTitleProvider {
  /** Stable id for logs/diagnostics (e.g. `'cloud'`, `'ollama'`). */
  readonly name: string;
  /** Produce a raw headline reply for one session's user text, or throw. */
  generate(input: SessionTitleInput, signal?: AbortSignal): Promise<string>;
}

/** The default provider: renders the shared prompt and runs it through a SessionTitleRunner
 * (defaults to the cheap `agents run --model cheap` subprocess). Tests inject a fake runner or
 * provider. */
export class CloudSessionTitleProvider implements SessionTitleProvider {
  readonly name = 'cloud';
  constructor(private readonly runner: SessionTitleRunner = defaultSessionTitleRunner) {}
  generate(input: SessionTitleInput, signal?: AbortSignal): Promise<string> {
    return this.runner(renderSessionTitlePrompt(input), signal);
  }
}

/** The provider used when a caller injects neither a `provider` nor a `run`. */
export function defaultSessionTitleProvider(): SessionTitleProvider {
  return new CloudSessionTitleProvider();
}

export interface SessionTitleTickOptions {
  /** Max sessions generated for in this sweep. */
  limit?: number;
  /** Title this session specifically (an explicit refresh), ignoring the recency window. */
  id?: string;
  /** Regenerate even when the stored key still matches the row's user text. */
  force?: boolean;
  /** The generation backend; defaults to defaultSessionTitleProvider (cheap cloud model). Swap in a
   * local model without touching the tick. Takes precedence over `run`. */
  provider?: SessionTitleProvider;
  /** Shortcut seam for the cloud provider's raw model call, wrapped in CloudSessionTitleProvider
   * when no `provider` is given. Kept for the daemon service and tests that inject only the
   * subprocess. */
  run?: SessionTitleRunner;
  signal?: AbortSignal;
  nowMs?: number;
  maxAgeMs?: number;
}

export interface SessionTitleTickResult {
  /** Rows inspected. */
  scanned: number;
  /** Rows already carrying a title for their current user text (the cache hit). */
  cached: number;
  /** Titles generated and persisted this sweep. */
  generated: number;
  /** Generation attempts that produced nothing usable (model unavailable, empty reply). */
  failed: number;
  titles: Array<{ id: string; title: string }>;
}

/** Decide what one sweep does without touching the model. Pure, so 'generate once, then cache-hit'
 * is testable: a candidate is work only when its user text yields a key that differs from the
 * stored one (or `force`). */
export function selectSessionsNeedingTitle(
  rows: SessionTitleCandidateRow[],
  opts: { limit: number; force?: boolean } = { limit: SESSION_TITLE_MAX_PER_TICK },
): { pending: Array<{ row: SessionTitleCandidateRow; sourceKey: string }>; cached: number } {
  const pending: Array<{ row: SessionTitleCandidateRow; sourceKey: string }> = [];
  let cached = 0;
  for (const row of rows) {
    // The titler's own runs are sessions too; titling them would spawn another.
    if (isSessionTitlePrompt(row.firstUserMessage, row.topic)) continue;
    const sourceKey = sessionTitleSourceKey(row);
    if (!sourceKey) continue;
    if (!opts.force && row.generatedTitle && row.generatedTitleKey === sourceKey) {
      cached++;
      continue;
    }
    if (pending.length < opts.limit) pending.push({ row, sourceKey });
  }
  return { pending, cached };
}

/** One titling sweep: pick sessions whose headline is still the raw user message, generate for at
 * most `limit`, and persist each. Best-effort: a failure leaves the row untitled. Throws only for
 * an explicit `id` matching no session. */
export async function runSessionTitleTick(
  options: SessionTitleTickOptions = {},
): Promise<SessionTitleTickResult> {
  const limit = options.limit ?? SESSION_TITLE_MAX_PER_TICK;
  const now = options.nowMs ?? Date.now();
  const result: SessionTitleTickResult = { scanned: 0, cached: 0, generated: 0, failed: 0, titles: [] };
  const { querySessionTitleCandidates, setSessionGeneratedTitle } = await import('./db.js');
  const rows = querySessionTitleCandidates(
    options.id ? 1 : SESSION_TITLE_CANDIDATE_SCAN,
    options.id
      ? { id: options.id }
      : { sinceMs: now - (options.maxAgeMs ?? SESSION_TITLE_MAX_AGE_MS) },
  );
  result.scanned = rows.length;
  // An explicitly requested session that has no indexed row is a caller error,
  // not a quiet sweep outcome: reporting "0 generated" would read as "already
  // current" for an id that was simply mistyped or not scanned yet.
  if (options.id && rows.length === 0) {
    throw new Error(
      `no indexed session matches "${options.id}" on this machine — ` +
      `a session is titled after it is indexed (the daemon indexes within seconds), ` +
      `and a peer's sessions are titled on the box that owns them`,
    );
  }
  const { pending, cached } = selectSessionsNeedingTitle(rows, { limit, force: options.force });
  result.cached = cached;
  if (pending.length === 0) return result;

  // The provider is the ONLY thing that varies by model host; everything above
  // (candidate selection, the source-key cache) and below (sanitize, persist) is
  // shared. A local backend is dropped in here, not woven through the tick.
  const provider = options.provider ?? new CloudSessionTitleProvider(options.run);
  for (const { row, sourceKey } of pending) {
    if (options.signal?.aborted) break;
    let title: string | undefined;
    try {
      title = sanitizeGeneratedTitle(await provider.generate(row, options.signal));
    } catch {
      // Harness unavailable, signed out, or over its deadline. Best-effort: the
      // row keeps showing the user's own words, and the caller backs off.
      title = undefined;
    }
    if (!title) {
      result.failed++;
      continue;
    }
    if (setSessionGeneratedTitle(row.id, title, sourceKey, now)) {
      result.generated++;
      result.titles.push({ id: row.id, title });
    }
  }
  return result;
}
