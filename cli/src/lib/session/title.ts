
import { createHash } from 'node:crypto';
import type { AgentId } from '../types.js';
import type { SessionTitleCandidateRow } from './db.js';

// Stable cross-module sentinel: excludes the titler's own utility sessions; keep classifier/tests synchronized.
export const SESSION_TITLE_PROMPT_MARKER = 'Generate a concise session headline';

export const SESSION_TITLE_MAX_CHARS = 60;
export const SESSION_TITLE_MAX_WORDS = 8;
export const SESSION_TITLE_INPUT_MAX_CHARS = 2000;

export const SESSION_TITLE_MAX_PER_TICK = 2;
export const SESSION_TITLE_CANDIDATE_SCAN = 200;
export const SESSION_TITLE_MAX_AGE_MS = 14 * 24 * 60 * 60_000;
export const SESSION_TITLE_TIMEOUT_MS = 45_000;

export const SESSION_TITLE_AGENTS = ['claude', 'codex', 'grok', 'kimi', 'opencode'] as const;

export interface SessionTitleInput {
  firstUserMessage?: string | null;
  topic?: string | null;
  project?: string | null;
  ticketId?: string | null;
  gitBranch?: string | null;
}

export function sessionTitleSourceText(input: SessionTitleInput): string {
  const raw = (input.firstUserMessage || input.topic || '').replace(/\s+/g, ' ').trim();
  return raw.length > SESSION_TITLE_INPUT_MAX_CHARS ? raw.slice(0, SESSION_TITLE_INPUT_MAX_CHARS) : raw;
}

export function sessionTitleSourceKey(input: SessionTitleInput): string | null {
  const text = sessionTitleSourceText(input);
  if (!text) return null;
  return createHash('sha256').update(text).digest('hex').slice(0, 16);
}

export function isSessionTitlePrompt(...values: Array<string | null | undefined>): boolean {
  return values.some((v) => typeof v === 'string' && v.includes(SESSION_TITLE_PROMPT_MARKER));
}

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
  const words = title.split(' ');
  if (words.length > SESSION_TITLE_MAX_WORDS) title = words.slice(0, SESSION_TITLE_MAX_WORDS).join(' ');
  if (title.length > SESSION_TITLE_MAX_CHARS) title = title.slice(0, SESSION_TITLE_MAX_CHARS).trimEnd();
  if (isSessionTitlePrompt(title)) return undefined;
  return title || undefined;
}

// Reject projections omitting generatedTitle; structural typing would silently drop this headline rung.
type CarriesTitleRung<T> = 'generatedTitle' extends keyof T ? T : never;

export function sessionHeadline<
  T extends { label?: string | null; generatedTitle?: string | null; topic?: string | null },
>(row: CarriesTitleRung<T>): string | undefined {
  return row.label || row.generatedTitle || row.topic || undefined;
}

type IsNever<T> = [T] extends [never] ? true : false;
type AssertTrue<T extends true> = T;
type AssertFalse<T extends false> = T;

type RungLessRow = { label?: string | null; topic?: string | null };

type _rungLessRowIsRejected = AssertTrue<IsNever<CarriesTitleRung<RungLessRow>>>;
type _realCarrierIsAccepted = AssertFalse<IsNever<CarriesTitleRung<SessionTitleCandidateRow>>>;

export type SessionTitleRunner = (prompt: string, signal?: AbortSignal) => Promise<string>;

export async function resolveSessionTitleAgent(): Promise<string | null> {
  const { listInstalledVersions } = await import('../installations/store.js');
  for (const agent of SESSION_TITLE_AGENTS) {
    try {
      if (listInstalledVersions(agent as AgentId).length > 0) return agent;
    } catch {
    }
  }
  return null;
}

// Title generation runs read-only in plan mode on the cheap model tier.
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

export interface SessionTitleProvider {
  readonly name: string;
  generate(input: SessionTitleInput, signal?: AbortSignal): Promise<string>;
}

export class CloudSessionTitleProvider implements SessionTitleProvider {
  readonly name = 'cloud';
  constructor(private readonly runner: SessionTitleRunner = defaultSessionTitleRunner) {}
  generate(input: SessionTitleInput, signal?: AbortSignal): Promise<string> {
    return this.runner(renderSessionTitlePrompt(input), signal);
  }
}

export function defaultSessionTitleProvider(): SessionTitleProvider {
  return new CloudSessionTitleProvider();
}

export interface SessionTitleTickOptions {
  limit?: number;
  id?: string;
  force?: boolean;
  provider?: SessionTitleProvider;
  run?: SessionTitleRunner;
  signal?: AbortSignal;
  nowMs?: number;
  maxAgeMs?: number;
}

export interface SessionTitleTickResult {
  scanned: number;
  cached: number;
  generated: number;
  failed: number;
  titles: Array<{ id: string; title: string }>;
}

export function selectSessionsNeedingTitle(
  rows: SessionTitleCandidateRow[],
  opts: { limit: number; force?: boolean } = { limit: SESSION_TITLE_MAX_PER_TICK },
): { pending: Array<{ row: SessionTitleCandidateRow; sourceKey: string }>; cached: number } {
  const pending: Array<{ row: SessionTitleCandidateRow; sourceKey: string }> = [];
  let cached = 0;
  for (const row of rows) {
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

  const provider = options.provider ?? new CloudSessionTitleProvider(options.run);
  for (const { row, sourceKey } of pending) {
    if (options.signal?.aborted) break;
    let title: string | undefined;
    try {
      title = sanitizeGeneratedTitle(await provider.generate(row, options.signal));
    } catch {
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
