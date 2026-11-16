
import { createHash } from 'node:crypto';
import { cleanFirstUserMessage, cleanGeneratedSessionLabel } from '@phnx-labs/sessions-cli/reader';
import type { AgentId } from '../types.js';
import type { SessionTitleCandidateRow } from './db.js';

export const SESSION_TITLE_PROMPT_MARKER = 'Generate a concise session headline';

export const SESSION_TITLE_MAX_CHARS = 60;
export const SESSION_TITLE_MAX_WORDS = 8;
export const SESSION_TITLE_INPUT_MAX_CHARS = 2000;

export const SESSION_TITLE_MAX_PER_TICK = 12;
export const SESSION_TITLE_BATCH_SIZE = 12;
export const SESSION_TITLE_BATCH_INPUT_MAX_CHARS = 600;
export const SESSION_WORKSTREAM_MAX_CHARS = 32;
export const SESSION_WORKSTREAM_MAX_WORDS = 4;
export const SESSION_WORKSTREAMS_OFFERED = 30;
export const SESSION_TITLE_CANDIDATE_SCAN = 200;
export const SESSION_TITLE_MAX_AGE_MS = 14 * 24 * 60 * 60_000;
export const SESSION_TITLE_TIMEOUT_MS = 90_000;

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

export interface SessionTitleBatchItem {
  /** Short handle the reply refers back to ("1", "2", …). */
  ref: string;
  input: SessionTitleInput;
  /** The session's name when it already has one: the reply's title is then ignored. */
  currentTitle?: string;
}

/** One line, bounded: every field the batch prompt quotes, so none can open a new `[n]` block. */
function promptLine(raw: string | null | undefined, max: number): string {
  return (raw ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

export function renderSessionTitleBatchPrompt(items: SessionTitleBatchItem[], workstreams: string[]): string {
  const sessions = items.flatMap(({ ref, input, currentTitle: named }) => {
    const text = sessionTitleSourceText(input).slice(0, SESSION_TITLE_BATCH_INPUT_MAX_CHARS);
    const context = [
      input.project ? `repository ${promptLine(input.project, 80)}` : null,
      input.ticketId ? `ticket ${promptLine(input.ticketId, 80)}` : null,
      input.gitBranch ? `branch ${promptLine(input.gitBranch, 80)}` : null,
    ].filter(Boolean).join(', ');
    const currentTitle = promptLine(named, 120);
    return [
      `[${ref}]${context ? ` (${context})` : ''}`,
      ...(currentTitle ? [`Current title: ${currentTitle}`] : []),
      `Request: ${text}`,
      '',
    ];
  });
  return [
    `${SESSION_TITLE_PROMPT_MARKER} and a workstream for each coding session below.`,
    'title: an ACTION + OBJECT headline of 4 to 8 words naming the concrete task,',
    'e.g. "Triage the AGI board" or "Rename browser profile — default confusion".',
    'Not a single noun, not a full sentence, not the person, not the pleasantries.',
    'workstream: 1 to 3 words naming the larger effort the session belongs to, the same name for',
    'every session about that effort, e.g. "Rush Mac", "Ahrefs SEO", "Fundraising".',
    workstreams.length
      ? `Reuse one of these existing workstreams whenever it fits; coin a new one only when none does: ${workstreams.map((w) => promptLine(w, SESSION_WORKSTREAM_MAX_CHARS)).join(' | ')}`
      : 'Name workstreams so that related sessions share one.',
    'Respond IMMEDIATELY with only a JSON array, one object per session, in this exact shape:',
    '[{"ref": "1", "title": "...", "workstream": "..."}]',
    'Do NOT investigate, do NOT read files, do NOT use any tools. No prose, no code fences.',
    '',
    ...sessions,
  ].join('\n');
}

export function sanitizeWorkstream(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  let name = raw.replace(/["'`*_]/g, '').replace(/[.!?,;:]+$/, '').replace(/\s+/g, ' ').trim();
  const words = name.split(' ');
  if (words.length > SESSION_WORKSTREAM_MAX_WORDS) name = words.slice(0, SESSION_WORKSTREAM_MAX_WORDS).join(' ');
  if (name.length > SESSION_WORKSTREAM_MAX_CHARS) name = name.slice(0, SESSION_WORKSTREAM_MAX_CHARS).trimEnd();
  return name || undefined;
}

/** Reads the model's JSON array reply; an unparseable reply yields an empty map
 *  (every session in the batch then counts as failed and is retried next tick). */
export function parseSessionTitleBatch(raw: string): Map<string, { title?: string; workstream?: string }> {
  const out = new Map<string, { title?: string; workstream?: string }>();
  const open = raw.indexOf('[');
  const close = raw.lastIndexOf(']');
  if (open < 0 || close <= open) return out;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.slice(open, close + 1));
  } catch {
    return out;
  }
  if (!Array.isArray(parsed)) return out;
  for (const entry of parsed) {
    if (!entry || typeof entry !== 'object') continue;
    const { ref, title, workstream } = entry as Record<string, unknown>;
    if (typeof ref !== 'string' && typeof ref !== 'number') continue;
    out.set(String(ref), {
      title: typeof title === 'string' ? sanitizeGeneratedTitle(title) : undefined,
      workstream: sanitizeWorkstream(workstream),
    });
  }
  return out;
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

type CarriesTitleRung<T> = 'generatedTitle' extends keyof T ? T : never;

export function sessionHeadline<
  T extends { label?: string | null; generatedTitle?: string | null; topic?: string | null; cwd?: string | null },
>(row: CarriesTitleRung<T>): string | undefined {
  const label = isPlaceholderSessionName(row.label, row.cwd) ? undefined : row.label;
  return label || row.generatedTitle || row.topic || undefined;
}

const HOST_FALLBACK_LABEL_RE = /^\[host\/[^\]]+\]$/;
const PLACEHOLDER_SUFFIX_RE = /^(?:\d+|(?=[0-9a-f]*\d)[0-9a-f]{1,4})$/i;

export function isPlaceholderSessionName(name: string | null | undefined, cwd?: string | null): boolean {
  const n = name?.trim();
  if (!n) return false;
  if (HOST_FALLBACK_LABEL_RE.test(n)) return true;
  const dir = cwd?.replace(/[/\\]+$/, '').split(/[/\\]/).pop();
  if (!dir || n.length <= dir.length + 1) return false;
  return n.slice(0, dir.length + 1).toLowerCase() === `${dir.toLowerCase()}-` && PLACEHOLDER_SUFFIX_RE.test(n.slice(dir.length + 1));
}

const INJECTED_NOTE_RE = /^another \w+ session sent a message:?\s*/i;

export function cleanDisplayTitle(raw: string | null | undefined): string | undefined {
  if (!raw || /^\s*<(?:task-notification|system-reminder)/i.test(raw)) return undefined;
  const t = raw
    .replace(/<\/?agent-message[^>]*>/gi, ' ')
    .replace(INJECTED_NOTE_RE, '')
    .replace(/\[([^\]]+)\]\([^)]*(?:\)|$)/g, '$1')
    .replace(/[`*]+/g, '')
    .replace(/^[#>\s]+/, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[…. ]+$/, '');
  if (!t || /^\[subagent hand-back\]/i.test(t) || /^\/[\w:-]+(?:\s|$)/.test(t)) return undefined;
  return t;
}

export interface SessionRecap {
  text: string;
  at: string;
}

const CLAUDE_RECAP_HINT_RE = /\s*\(disable recaps in \/config\)\s*$/i;

export function claudeRecapFromLine(parsed: { type?: unknown; subtype?: unknown; content?: unknown; timestamp?: unknown }): SessionRecap | undefined {
  if (parsed.type !== 'system' || parsed.subtype !== 'away_summary') return undefined;
  if (typeof parsed.content !== 'string' || typeof parsed.timestamp !== 'string') return undefined;
  const text = parsed.content.replace(CLAUDE_RECAP_HINT_RE, '').trim();
  return text ? { text, at: parsed.timestamp } : undefined;
}

export interface LiveSessionName {
  name: string;
  source?: string;
}

export interface SessionNameSources {
  customTitle?: string | null;
  live?: LiveSessionName | null;
  indexed?: string | null;
  launchName?: string | null;
  aiTitle?: string | null;
}

function nonEmpty(s: string | null | undefined): string | undefined {
  return s?.trim() || undefined;
}

export function resolveSessionName(n: SessionNameSources): string | undefined {
  const liveName = n.live && n.live.source !== 'derived' ? nonEmpty(n.live.name) : undefined;
  return (n.live?.source === 'user' ? liveName : undefined)
    ?? nonEmpty(n.customTitle)
    ?? liveName
    ?? nonEmpty(n.indexed)
    ?? nonEmpty(n.launchName)
    ?? cleanGeneratedSessionLabel(n.aiTitle ?? undefined);
}

export const STARTED_AS_MAX_CHARS = 280;

const COMMAND_RE = /<command-name>\s*(\/[^<\s]+)\s*<\/command-name>[\s\S]*?(?:<command-args>([\s\S]*?)<\/command-args>|$)/;

export function startedAsFromUserTurn(text: string): string | undefined {
  const command = COMMAND_RE.exec(text);
  let prompt: string | undefined;
  if (command) {
    const args = command[2]?.trim();
    if (!args) return undefined;
    prompt = command[1] === '/goal' ? args : `${command[1]} ${args}`;
  } else {
    prompt = cleanFirstUserMessage(text);
  }
  const flat = prompt?.replace(/\s+/g, ' ').trim();
  if (!flat) return undefined;
  return flat.length > STARTED_AS_MAX_CHARS ? `${flat.slice(0, STARTED_AS_MAX_CHARS - 1).trimEnd()}…` : flat;
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
  /** One model call for the whole batch; returns the raw reply. */
  generateBatch(items: SessionTitleBatchItem[], workstreams: string[], signal?: AbortSignal): Promise<string>;
}

export class CloudSessionTitleProvider implements SessionTitleProvider {
  readonly name = 'cloud';
  constructor(private readonly runner: SessionTitleRunner = defaultSessionTitleRunner) {}
  generateBatch(items: SessionTitleBatchItem[], workstreams: string[], signal?: AbortSignal): Promise<string> {
    return this.runner(renderSessionTitleBatchPrompt(items, workstreams), signal);
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
  /** Sessions that got a workstream this tick (with or without a new title). */
  grouped: number;
  failed: number;
  /** Why a model call failed (missing harness, timeout, …), each once, so the service can say it. */
  errors: string[];
  titles: Array<{ id: string; title: string; workstream?: string }>;
}

export interface PendingSessionTitle {
  row: SessionTitleCandidateRow;
  sourceKey: string;
  /** False when the session already has a current name and only lacks a workstream. */
  needsTitle: boolean;
}

export function selectSessionsNeedingTitle(
  rows: SessionTitleCandidateRow[],
  opts: { limit: number; force?: boolean } = { limit: SESSION_TITLE_MAX_PER_TICK },
): { pending: PendingSessionTitle[]; cached: number } {
  const pending: PendingSessionTitle[] = [];
  let cached = 0;
  for (const row of rows) {
    if (isSessionTitlePrompt(row.firstUserMessage, row.topic)) continue;
    const sourceKey = sessionTitleSourceKey(row);
    if (!sourceKey) continue;
    const named = Boolean(row.label?.trim());
    const titleCurrent = named || (!opts.force && Boolean(row.generatedTitle) && row.generatedTitleKey === sourceKey);
    const needsTitle = !titleCurrent;
    if (!needsTitle && row.workstream) {
      cached++;
      continue;
    }
    if (pending.length < opts.limit) pending.push({ row, sourceKey, needsTitle });
  }
  return { pending, cached };
}

export async function runSessionTitleTick(
  options: SessionTitleTickOptions = {},
): Promise<SessionTitleTickResult> {
  const limit = options.limit ?? SESSION_TITLE_MAX_PER_TICK;
  const now = options.nowMs ?? Date.now();
  const maxAgeMs = options.maxAgeMs ?? SESSION_TITLE_MAX_AGE_MS;
  const result: SessionTitleTickResult = { scanned: 0, cached: 0, generated: 0, grouped: 0, failed: 0, errors: [], titles: [] };
  const { querySessionTitleCandidates, setSessionGeneratedTitle, setSessionWorkstream, listRecentWorkstreams } = await import('./db.js');
  const rows = querySessionTitleCandidates(
    options.id ? 1 : SESSION_TITLE_CANDIDATE_SCAN,
    options.id ? { id: options.id } : { sinceMs: now - maxAgeMs },
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
  const known = listRecentWorkstreams(now - maxAgeMs, SESSION_WORKSTREAMS_OFFERED);
  // A name that differs from a known one only in case is that name, so "rush mac" never splits a group.
  const canonical = (name: string | undefined): string | undefined => {
    if (!name) return undefined;
    const hit = known.find((k) => k.toLowerCase() === name.toLowerCase());
    if (hit) return hit;
    known.push(name);
    return name;
  };
  const apply = (batch: PendingSessionTitle[], reply: Map<string, { title?: string; workstream?: string }>) => {
    batch.forEach(({ row, sourceKey, needsTitle }, n) => {
      const answer = reply.get(String(n + 1));
      const workstream = canonical(answer?.workstream);
      if (needsTitle) {
        const title = answer?.title;
        if (!title) {
          result.failed++;
          return;
        }
        if (setSessionGeneratedTitle(row.id, title, sourceKey, now, workstream)) {
          result.generated++;
          if (workstream) result.grouped++;
          result.titles.push({ id: row.id, title, ...(workstream ? { workstream } : {}) });
        }
        return;
      }
      if (!workstream) {
        result.failed++;
        return;
      }
      if (setSessionWorkstream(row.id, workstream)) result.grouped++;
    });
  };
  // One call per batch. A reply that is not the JSON array (one session's request can pull the
  // model into prose) is retried once, as two halves, so one bad session never holds the rest of
  // the queue and a model that only answers prose costs at most three calls a batch.
  const run = async (batch: PendingSessionTitle[], split = false): Promise<void> => {
    if (options.signal?.aborted) return;
    const items: SessionTitleBatchItem[] = batch.map(({ row, needsTitle }, n) => ({
      ref: String(n + 1),
      input: row,
      ...(needsTitle ? {} : { currentTitle: (row.label?.trim() || row.generatedTitle) ?? undefined }),
    }));
    let raw: string;
    try {
      raw = await provider.generateBatch(items, known, options.signal);
    } catch (error) {
      if (options.signal?.aborted) return;
      const message = error instanceof Error ? error.message.split('\n')[0] : String(error);
      if (!result.errors.includes(message)) result.errors.push(message);
      result.failed += batch.length;
      return;
    }
    const reply = parseSessionTitleBatch(raw);
    if (reply.size === 0 && batch.length > 1 && !split) {
      const half = Math.ceil(batch.length / 2);
      await run(batch.slice(0, half), true);
      await run(batch.slice(half), true);
      return;
    }
    apply(batch, reply);
  };
  for (let i = 0; i < pending.length; i += SESSION_TITLE_BATCH_SIZE) {
    if (options.signal?.aborted) break;
    await run(pending.slice(i, i + SESSION_TITLE_BATCH_SIZE));
  }
  return result;
}
