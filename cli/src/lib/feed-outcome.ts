/**
 * Outcome keys for the agent feed.
 *
 * 1,100 agents is not 1,100 things the operator cares about — dozens of agents
 * map onto each real deliverable (a Linear ticket, a PR, a worktree/epic). The
 * feed groups by **outcome** so one human reasons about initiatives, not
 * processes. Every block is attributed to exactly one outcome; orphans land in
 * the shared "Unassigned" bucket.
 *
 * Precedence (first match wins):
 *   1. ticket   — RUSH-1125 / explicit `ticket` field / ticket-shaped branch
 *   2. pr       — #534 / PR#534 / github.com/.../pull/534
 *   3. worktree — `.agents/worktrees/<slug>` slug (or epic label)
 *   4. unassigned
 *
 * Pure functions, no I/O — unit-testable and shared by `agents feed` rendering
 * and any UI that collapses blocks under deliverables.
 */
import { detectTicket, extractPrUrl } from '@phnx-labs/sessions-cli/reader';
import { deriveBlockState, type OpenBlock } from './feed/feed.js';

type OutcomeKind = 'ticket' | 'pr' | 'worktree' | 'unassigned';

/** Stable attribution of a block (or agent) to one deliverable. */
export interface OutcomeRef {
  /** Map/JSON key, e.g. `ticket:RUSH-1125`, `pr:#534`, `worktree:headless-secrets`, `unassigned`. */
  key: string;
  kind: OutcomeKind;
  /** Human header label, e.g. `RUSH-1125`, `PR#534`, `headless-secrets`, `Unassigned`. */
  label: string;
}

/**
 * Signals used to derive an outcome. All optional — callers pass whatever they
 * already know (block fields, session meta, free-text questions).
 */
interface OutcomeSignals {
  ticket?: string | null;
  pr?: string | null;
  worktreeSlug?: string | null;
  /** Branch name — scanned for `rush-1125`-style ticket slugs. */
  branch?: string | null;
  /** Epic / team label when no ticket/PR/worktree is known. */
  epic?: string | null;
  /** Free text (question headers + bodies) scanned for ticket/PR refs. */
  text?: string | null;
}

const UNASSIGNED: OutcomeRef = {
  key: 'unassigned',
  kind: 'unassigned',
  label: 'Unassigned',
};

/**
 * Normalize a PR ref.
 * - Full GitHub URL → `owner/repo#N` (repo identity included)
 * - Bare `#123` / `PR#123` → `#123` (no repo known)
 */
export function normalizePrRef(raw: string | null | undefined): string | undefined {
  if (!raw) return undefined;
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  const fromUrl = extractPrUrl(trimmed);
  if (fromUrl?.number != null) {
    const repo = repoFromPrUrl(fromUrl.url);
    return repo ? `${repo}#${fromUrl.number}` : `#${fromUrl.number}`;
  }
  const m = /(?:^|\bpr\s*#?\s*|pull\/|#)(\d{1,7})\b/i.exec(trimmed);
  if (m) return `#${m[1]}`;
  return undefined;
}

/** `https://github.com/owner/repo/pull/N` → `owner/repo`. */
function repoFromPrUrl(url: string | null | undefined): string | undefined {
  if (!url) return undefined;
  const m = /github\.com\/([^/\s]+)\/([^/\s]+)\/pull\/\d+/i.exec(url);
  if (!m) return undefined;
  return `${m[1]}/${m[2]}`;
}

/** Canonical ticket id (uppercase team key). */
export function normalizeTicketRef(raw: string | null | undefined): string | undefined {
  if (!raw) return undefined;
  const m = raw.trim().match(/\b([A-Za-z]{2,6}-\d{1,6})\b/);
  if (!m) return undefined;
  const id = m[1].toUpperCase();
  // Reuse the session state's denylist via detectTicket on the id alone.
  return detectTicket(id)?.id ?? id;
}

function ticketFromSignals(s: OutcomeSignals): string | undefined {
  const direct = normalizeTicketRef(s.ticket ?? undefined);
  if (direct) return direct;
  const fromText = detectTicket(s.text ?? undefined, s.branch ?? undefined)?.id;
  return fromText;
}

function prFromSignals(s: OutcomeSignals): string | undefined {
  const direct = normalizePrRef(s.pr ?? undefined);
  if (direct) return direct;
  if (s.text) {
    // Prefer full URL so keys include owner/repo (RUSH-1630).
    const fromUrl = extractPrUrl(s.text);
    if (fromUrl?.number != null) {
      return normalizePrRef(fromUrl.url) ?? `#${fromUrl.number}`;
    }
    const m = /(?:\bpr\s*#?\s*|#)(\d{1,7})\b/i.exec(s.text);
    if (m) return `#${m[1]}`;
  }
  return undefined;
}

/**
 * Derive the single outcome a block/agent belongs to.
 * Exactly one outcome per call — never ambiguous, never empty.
 */
export function deriveOutcome(signals: OutcomeSignals): OutcomeRef {
  const ticket = ticketFromSignals(signals);
  if (ticket) {
    return { key: `ticket:${ticket}`, kind: 'ticket', label: ticket };
  }

  const pr = prFromSignals(signals);
  if (pr) {
    // pr is either `owner/repo#N` or `#N`
    const hash = pr.includes('#') ? pr.slice(pr.indexOf('#')) : pr;
    const n = hash.replace(/^#/, '');
    const label = pr.includes('/') ? `PR ${pr}` : `PR#${n}`;
    return { key: `pr:${pr}`, kind: 'pr', label };
  }

  const wt = (signals.worktreeSlug ?? '').trim();
  if (wt) {
    return { key: `worktree:${wt}`, kind: 'worktree', label: wt };
  }

  const epic = (signals.epic ?? '').trim();
  if (epic) {
    // Epic folds into the worktree kind: both are soft deliverable labels
    // without a tracker id. Key prefix keeps them disjoint from worktree slugs.
    return { key: `epic:${epic}`, kind: 'worktree', label: epic };
  }

  return UNASSIGNED;
}

/** Join question headers + bodies into one scan target for ticket/PR detection. */
function blockScanText(block: Pick<OpenBlock, 'questions'>): string {
  return block.questions
    .map((q) => [q.header, q.text].filter(Boolean).join(' '))
    .filter(Boolean)
    .join('\n');
}

/** Outcome for a stored open block (uses stamped fields + question text). */
export function outcomeForBlock(block: OpenBlock): OutcomeRef {
  return deriveOutcome({
    ticket: block.ticket,
    pr: block.pr,
    worktreeSlug: block.worktreeSlug,
    epic: block.epic,
    text: blockScanText(block),
  });
}

/** Per-outcome rollup used by the default `agents feed` view. */
export interface OutcomeGroup {
  outcome: OutcomeRef;
  blocks: OpenBlock[];
  counts: {
    /** Distinct mailbox ids under this outcome. */
    agents: number;
    /** Still open: unanswered and not hard-parked. */
    open: number;
    answered: number;
    parked: number;
  };
}

/**
 * Openness is the canonical {@link deriveBlockState}, never a raw `block.answer`
 * test: a PENDING claim carries an answer record while the block is still
 * `open`, so reading the field directly showed a claimed-but-undelivered
 * question as answered in the operator's own feed (PHNX-3999).
 */
function isOpen(block: OpenBlock): boolean {
  return deriveBlockState(block) === 'open' && !block.parkedAt && !block.continuedAt && !block.defaultedAt;
}

/**
 * Collapse blocks under their outcome. Order: needs-you outcomes first
 * (open count desc), then by label. Unassigned always last among ties of 0 open.
 */
export function groupBlocksByOutcome(blocks: OpenBlock[]): OutcomeGroup[] {
  const byKey = new Map<string, { outcome: OutcomeRef; blocks: OpenBlock[] }>();
  for (const block of blocks) {
    const outcome = outcomeForBlock(block);
    const bucket = byKey.get(outcome.key);
    if (bucket) bucket.blocks.push(block);
    else byKey.set(outcome.key, { outcome, blocks: [block] });
  }

  const groups: OutcomeGroup[] = [];
  for (const { outcome, blocks: members } of byKey.values()) {
    const mailboxes = new Set(members.map((b) => b.mailboxId));
    const states = new Map<string, 'open' | 'parked' | 'answered'>();
    for (const b of members) {
      const next = b.parkedAt
        ? 'parked'
        : isOpen(b) ? 'open' : 'answered';
      const current = states.get(b.mailboxId);
      // One agent occupies one state. Its most actionable block wins.
      if (!current || next === 'open' || (next === 'parked' && current === 'answered')) {
        states.set(b.mailboxId, next);
      }
    }
    const count = (state: 'open' | 'parked' | 'answered') =>
      [...states.values()].filter((value) => value === state).length;
    groups.push({
      outcome,
      blocks: members,
      counts: { agents: mailboxes.size, open: count('open'), answered: count('answered'), parked: count('parked') },
    });
  }

  groups.sort((a, b) => {
    // Unassigned always last.
    if (a.outcome.kind === 'unassigned' && b.outcome.kind !== 'unassigned') return 1;
    if (b.outcome.kind === 'unassigned' && a.outcome.kind !== 'unassigned') return -1;
    if (b.counts.open !== a.counts.open) return b.counts.open - a.counts.open;
    return a.outcome.label.localeCompare(b.outcome.label);
  });
  return groups;
}

/**
 * Stamp each block with its derived outcome for JSON consumers.
 * Does not mutate the input records.
 */
export function stampBlockOutcomes(blocks: OpenBlock[]): Array<OpenBlock & { outcome: OutcomeRef }> {
  return blocks.map((b) => ({ ...b, outcome: outcomeForBlock(b) }));
}

/**
 * True when every still-open block under the outcome asks the same question
 * (same cluster of header+text). Fan-out answers are only safe when this holds
 * — otherwise the operator must pick a specific agent.
 */
export function isUnambiguousOutcomeAnswer(group: OutcomeGroup): boolean {
  const open = group.blocks.filter(isOpen);
  if (open.length <= 1) return open.length === 1;
  const keys = new Set(
    open.map((b) =>
      b.questions.map((q) => `${q.header ?? ''}\0${q.text}`).join('\n'),
    ),
  );
  return keys.size === 1;
}

/** Still-open blocks under an outcome (candidates for a fan-out reply). */
export function openBlocksForOutcome(group: OutcomeGroup): OpenBlock[] {
  return group.blocks.filter(isOpen);
}

/**
 * Lightweight session signals used to fill missing ticket/PR/worktree on a
 * block at list time (the publish hook may not have had them yet).
 */
export interface SessionOutcomeHint {
  sessionId?: string | null;
  agentId?: string | null;
  mailboxId?: string | null;
  ticketId?: string | null;
  prNumber?: number | null;
  prUrl?: string | null;
  worktreeSlug?: string | null;
  branch?: string | null;
  project?: string | null;
  host?: string | null;
  origin?: 'cli' | 'routine' | null;
  routineName?: string | null;
}

/**
 * Overlay session meta onto a block when the block itself is missing ticket/PR/
 * worktree. Never overwrites a field the block already carries.
 */
export function enrichBlockFromSession(block: OpenBlock, hint: SessionOutcomeHint): OpenBlock {
  const next: OpenBlock = { ...block };
  if (!next.ticket && hint.ticketId) next.ticket = hint.ticketId;
  if (!next.pr) {
    if (hint.prUrl) next.pr = hint.prUrl;
    else if (hint.prNumber != null) next.pr = `#${hint.prNumber}`;
  }
  if (!next.worktreeSlug && hint.worktreeSlug) next.worktreeSlug = hint.worktreeSlug;
  if (!next.project && hint.project) next.project = hint.project;
  if (hint.host && hint.host !== 'terminal' && next.runtime === 'terminal') next.runtime = hint.host;
  if (hint.origin === 'routine') {
    next.origin = 'routine';
    if (hint.routineName) next.routineName = hint.routineName;
  }
  return next;
}

/**
 * Build a mailboxId → session-hint index and enrich every block. Pure.
 * Matching order: mailboxId, then sessionId, then agentId.
 */
export function enrichBlocksFromSessions(
  blocks: OpenBlock[],
  sessions: SessionOutcomeHint[],
): OpenBlock[] {
  const byMailbox = new Map<string, SessionOutcomeHint>();
  const bySession = new Map<string, SessionOutcomeHint>();
  for (const s of sessions) {
    if (s.mailboxId) byMailbox.set(s.mailboxId, s);
    if (s.sessionId) bySession.set(s.sessionId, s);
    if (s.agentId) bySession.set(s.agentId, s);
  }
  return blocks.map((b) => {
    const hint = byMailbox.get(b.mailboxId) ?? bySession.get(b.sessionId);
    return hint ? enrichBlockFromSession(b, hint) : b;
  });
}
