/**
 * Daemon-generated session TITLES (PHNX-3797).
 *
 * The headline on a session row answers "what is this session about?", so it has
 * to be anchored in what the USER asked for. It used to be the agent's latest
 * transcript line — verbose, rolling, and unrecognizable to the person who
 * started the run. The fix is a two-rung answer:
 *
 *  1. INSTANT, free: the user's own first message (already in the index) is the
 *     honest fallback shown from the moment the session appears.
 *  2. UPGRADED, once: this module asks a CHEAP model (the `cheap` tier — haiku
 *     on Claude — through the same `agents run --model <tier>` resolution every
 *     other call uses) for a 3-6 word TECHNICAL title of what the session worked
 *     on, and persists it in the session index.
 *
 * Generation happens ONCE per session, in the daemon, and is keyed by
 * {@link sessionTitleSourceKey} — a hash of the user text the title was derived
 * from — so a sweep that sees a stored key matching the row's current text skips
 * it (the cache hit) and regenerates only when that first user message actually
 * changed, or when an operator asks explicitly
 * (`agents sessions backfill titles --refresh`). There is no per-tick model call
 * and no per-client generation: the daemon writes one value, every consumer
 * (local list, picker, `sessions watch --json`, the fleet mirror, AGI EXT) reads
 * it off the row.
 *
 * Everything here except {@link runSessionTitleTick} is pure, and the tick takes
 * an injectable runner seam, so the whole path is testable without spawning a
 * harness.
 */

import { createHash } from 'node:crypto';
import type { AgentId } from '../types.js';
// Type-only, plus dynamic imports inside the tick: the pure helpers here are
// read by render paths that must not pull the SQLite index into a listing.
import type { SessionTitleCandidateRow } from './db.js';

/**
 * The phrase every generated-title prompt carries. Load-bearing twice over:
 * `traces/sync.ts` classifies a session whose topic matches it as internal
 * `utility` plumbing rather than agent work, and {@link isSessionTitlePrompt}
 * uses it to keep the titler from titling its OWN spawned sessions — which
 * would otherwise be a runaway loop, since each generation creates one more
 * untitled session.
 */
export const SESSION_TITLE_PROMPT_MARKER = 'Generate a 3-6 word technical title';

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

/**
 * Stable identity of the text a title was generated from. Storing this beside
 * the title is what makes "already titled" distinguishable from "the user's
 * first message changed" without keeping a second copy of that text.
 * Empty text yields `null`: there is nothing to title.
 */
export function sessionTitleSourceKey(input: SessionTitleInput): string | null {
  const text = sessionTitleSourceText(input);
  if (!text) return null;
  return createHash('sha256').update(text).digest('hex').slice(0, 16);
}

/**
 * True when this text is one of the titler's OWN prompts. The titler runs a real
 * harness, which writes a real transcript, which lands in the index as another
 * untitled session — so without this guard every title generated would create
 * work for the next sweep, forever.
 */
export function isSessionTitlePrompt(...values: Array<string | null | undefined>): boolean {
  return values.some((v) => typeof v === 'string' && v.includes(SESSION_TITLE_PROMPT_MARKER));
}

/** The one-shot prompt handed to the cheap model. */
export function renderSessionTitlePrompt(input: SessionTitleInput): string {
  const text = sessionTitleSourceText(input);
  const context = [
    input.project ? `Repository: ${input.project}` : null,
    input.ticketId ? `Ticket: ${input.ticketId}` : null,
    input.gitBranch ? `Branch: ${input.gitBranch}` : null,
  ].filter(Boolean);
  return [
    `${SESSION_TITLE_PROMPT_MARKER} naming what this coding session worked on.`,
    'Name the concrete feature, component, or fix — not the person, not the pleasantries.',
    'Respond IMMEDIATELY with only the title. Do NOT investigate, do NOT read files, do NOT use any tools.',
    'No quotes, no trailing punctuation, no explanation.',
    ...(context.length ? ['', ...context] : []),
    '',
    "The user's request:",
    '---',
    text,
    '---',
  ].join('\n');
}

/**
 * Reduce a model reply to a storable title, or `undefined` when it produced
 * nothing usable. Takes the first non-empty line (a chatty model puts the title
 * first), strips wrapping quotes/backticks and trailing punctuation, and applies
 * the word + character ceilings. A reply that is really a refusal or an
 * explanation fails the ceilings and is dropped rather than shown.
 */
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

/**
 * Compile-time guard: resolves to `T` only when `T` actually declares a
 * `generatedTitle` key, and to `never` otherwise.
 *
 * This exists because structural typing makes the obvious signature useless. A
 * parameter typed `{ generatedTitle?: string }` is satisfied by an object type
 * that has no such property at all, so passing a projection that DROPPED the
 * field — the watchdog's `SessionOutcome`, which copied `label`/`name`/`topic`
 * off the session and left `generatedTitle` behind — compiles cleanly and
 * silently degrades {@link sessionHeadline} back to `label || topic`. That is a
 * real bug this feature shipped once and a lexical lint cannot see, since the
 * call site looks correct. `keyof` includes optional keys, so every legitimate
 * carrier (`SessionMeta`, `ActiveSession`, a `Pick<>` that names it) still
 * passes; only a type that never modelled the rung is rejected.
 */
type CarriesTitleRung<T> = 'generatedTitle' extends keyof T ? T : never;

/**
 * The headline for an INDEXED session row, on the same ladder the live path uses
 * (`deriveSessionRecap`, active.ts): `/rename` label → daemon-generated title →
 * first-prompt topic. Every `agents sessions` surface that shows "what this
 * session is" reads it from here, so the CLI and the watch stream can never
 * disagree about a session's name (PHNX-3797).
 *
 * A caller whose row type does not carry `generatedTitle` fails to compile
 * (see {@link CarriesTitleRung}) — fix the projection to carry the field rather
 * than casting past this.
 */
export function sessionHeadline<
  T extends { label?: string | null; generatedTitle?: string | null; topic?: string | null },
>(row: CarriesTitleRung<T>): string | undefined {
  return row.label || row.generatedTitle || row.topic || undefined;
}

/*
 * Proof that {@link CarriesTitleRung} still does its job, checked by the ORDINARY
 * `tsc` run (`bun run build`, CI's `check:typecheck`) rather than by a test.
 *
 * A guard nobody proved can fail is not a guard, so this has to be asserted
 * somewhere. It deliberately lives in typechecked SOURCE and not in a
 * `*.test.ts`: `tsconfig.json` excludes `src/**\/*.test.ts`, so a test could only
 * check a type by spawning its own compiler — which is what this feature did
 * first, at ~15s of required-CI wall time for one assertion (PHNX-3797). Here the
 * same two properties cost nothing and are verified on every build, not only on
 * the runs where impact selection happens to pick that test file up.
 *
 * Weakening the guard to `type CarriesTitleRung<T> = T` breaks the build on
 * `_rungLessRowIsRejected`; over-tightening it so a legitimate optional carrier
 * resolves to `never` breaks it on `_realCarrierIsAccepted`.
 */
type IsNever<T> = [T] extends [never] ? true : false;
type AssertTrue<T extends true> = T;
type AssertFalse<T extends false> = T;

/** The shape of a projection that dropped the rung — the watchdog's old `SessionOutcome`. */
type RungLessRow = { label?: string | null; topic?: string | null };

// A row type that never modelled `generatedTitle` must NOT be callable.
type _rungLessRowIsRejected = AssertTrue<IsNever<CarriesTitleRung<RungLessRow>>>;
// A real carrier — optional key included — must still be callable.
type _realCarrierIsAccepted = AssertFalse<IsNever<CarriesTitleRung<SessionTitleCandidateRow>>>;

/**
 * Runs the cheap model once and returns its raw stdout. Injectable so tests
 * exercise the whole tick — candidate selection, key comparison, persistence —
 * without spawning a harness.
 */
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

/**
 * The real runner: ONE `agents run <agent> --mode plan --model cheap <prompt>`
 * subprocess. `--mode plan` keeps it read-only (it must never touch a repo), and
 * `--model cheap` goes through the same tier resolution every other run uses, so
 * the box's own catalog picks haiku (or its per-harness equivalent) rather than
 * this module hardcoding a model id that ages out.
 */
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

export interface SessionTitleTickOptions {
  /** Max sessions generated for in this sweep. */
  limit?: number;
  /** Title this session specifically (an explicit refresh), ignoring the recency window. */
  id?: string;
  /** Regenerate even when the stored key still matches the row's user text. */
  force?: boolean;
  /** Injected model call; defaults to {@link defaultSessionTitleRunner}. */
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

/**
 * Decide what one sweep should do, without touching the model. Pure over its
 * inputs so the "generate once, then cache-hit" property is directly testable:
 * a candidate is work only when its user text yields a key AND that key differs
 * from the one stored beside its title (or `force`).
 */
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

/**
 * One titling sweep: pick the sessions whose headline is still the raw user
 * message, generate a title for at most {@link SessionTitleTickOptions.limit} of
 * them, and persist each. Best-effort by contract — a failed generation leaves
 * the row untitled, which the ladder renders as the user's own first message.
 *
 * Throws only for an explicit {@link SessionTitleTickOptions.id} that matches no
 * indexed session (a caller error); the periodic sweep never throws.
 */
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

  const run = options.run ?? defaultSessionTitleRunner;
  for (const { row, sourceKey } of pending) {
    if (options.signal?.aborted) break;
    let title: string | undefined;
    try {
      title = sanitizeGeneratedTitle(await run(renderSessionTitlePrompt(row), options.signal));
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
