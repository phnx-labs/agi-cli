import { detectTicket, extractPrUrl } from '@phnx-labs/sessions-cli/reader';
import { deriveBlockState, type OpenBlock } from './feed/feed.js';

type OutcomeKind = 'ticket' | 'pr' | 'worktree' | 'unassigned';

export interface OutcomeRef {
  key: string;
  kind: OutcomeKind;
  label: string;
}

interface OutcomeSignals {
  ticket?: string | null;
  pr?: string | null;
  worktreeSlug?: string | null;
  branch?: string | null;
  epic?: string | null;
  text?: string | null;
}

const UNASSIGNED: OutcomeRef = {
  key: 'unassigned',
  kind: 'unassigned',
  label: 'Unassigned',
};

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

function repoFromPrUrl(url: string | null | undefined): string | undefined {
  if (!url) return undefined;
  const m = /github\.com\/([^/\s]+)\/([^/\s]+)\/pull\/\d+/i.exec(url);
  if (!m) return undefined;
  return `${m[1]}/${m[2]}`;
}

export function normalizeTicketRef(raw: string | null | undefined): string | undefined {
  if (!raw) return undefined;
  const m = raw.trim().match(/\b([A-Za-z]{2,6}-\d{1,6})\b/);
  if (!m) return undefined;
  const id = m[1].toUpperCase();
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
    const fromUrl = extractPrUrl(s.text);
    if (fromUrl?.number != null) {
      return normalizePrRef(fromUrl.url) ?? `#${fromUrl.number}`;
    }
    const m = /(?:\bpr\s*#?\s*|#)(\d{1,7})\b/i.exec(s.text);
    if (m) return `#${m[1]}`;
  }
  return undefined;
}

export function deriveOutcome(signals: OutcomeSignals): OutcomeRef {
  const ticket = ticketFromSignals(signals);
  if (ticket) {
    return { key: `ticket:${ticket}`, kind: 'ticket', label: ticket };
  }

  const pr = prFromSignals(signals);
  if (pr) {
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
    return { key: `epic:${epic}`, kind: 'worktree', label: epic };
  }

  return UNASSIGNED;
}

function blockScanText(block: Pick<OpenBlock, 'questions'>): string {
  return block.questions
    .map((q) => [q.header, q.text].filter(Boolean).join(' '))
    .filter(Boolean)
    .join('\n');
}

export function outcomeForBlock(block: OpenBlock): OutcomeRef {
  return deriveOutcome({
    ticket: block.ticket,
    pr: block.pr,
    worktreeSlug: block.worktreeSlug,
    epic: block.epic,
    text: blockScanText(block),
  });
}

export interface OutcomeGroup {
  outcome: OutcomeRef;
  blocks: OpenBlock[];
  counts: {
    agents: number;
    open: number;
    answered: number;
    parked: number;
  };
}

function isOpen(block: OpenBlock): boolean {
  return deriveBlockState(block) === 'open' && !block.parkedAt && !block.continuedAt && !block.defaultedAt;
}

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
    if (a.outcome.kind === 'unassigned' && b.outcome.kind !== 'unassigned') return 1;
    if (b.outcome.kind === 'unassigned' && a.outcome.kind !== 'unassigned') return -1;
    if (b.counts.open !== a.counts.open) return b.counts.open - a.counts.open;
    return a.outcome.label.localeCompare(b.outcome.label);
  });
  return groups;
}

export function stampBlockOutcomes(blocks: OpenBlock[]): Array<OpenBlock & { outcome: OutcomeRef }> {
  return blocks.map((b) => ({ ...b, outcome: outcomeForBlock(b) }));
}

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

export function openBlocksForOutcome(group: OutcomeGroup): OpenBlock[] {
  return group.blocks.filter(isOpen);
}

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
