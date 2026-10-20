import { createHash } from 'node:crypto';
import type { ActiveSession } from '../session/active.js';
import type { TurnVerdict } from '../session/hook-sessions.js';
import type { StructuredQuestion } from '@phnx-labs/sessions-cli/reader';
import {
  blockGeneration,
  blockIdForSession,
  blockSource,
  deriveBlockState,
  type AttentionResolution,
  type AttentionSource,
  type AttentionState,
  type BlockOption,
  type BlockQuestion,
  type OpenBlock,
  type SourceCursor,
} from './feed.js';

export type AttentionKind =
  | 'question'
  | 'permission'
  | 'plan_review'
  | 'declared'
  | 'failure'
  | 'stall'
  | 'review'
  | 'unverified';

export type ReplyCapability = 'terminal' | 'tmux' | 'cloud' | 'team' | 'none';

export const ATTENTION_URGENCIES = ['urgent', 'high', 'normal', 'low'] as const;
export type AttentionUrgency = (typeof ATTENTION_URGENCIES)[number];

export interface AttentionChoice extends BlockOption {
  id: string;
  deliveryKey?: string;
}

export interface AttentionItem {
  key: string;
  sessionId: string;
  mailboxId: string;
  host: string;
  project?: string;
  kind: AttentionKind;
  source: AttentionSource;
  state: AttentionState;
  openedAt: string;
  question?: BlockQuestion;
  choices?: AttentionChoice[];
  replyCapability: ReplyCapability;
  safeDefault?: string;
  fingerprint: string;
  sourceCursor?: SourceCursor;
  urgency: AttentionUrgency;
  urgencyReason?: string;
  draft?: { text?: string; choiceId?: string; label: string; at: string };
}

export interface PullRequestAttentionSignal {
  number: number;
  title?: string;
  url?: string;
  needsHuman: boolean;
  reviewDecision?: string;
  mergeable?: string;
  state?: string;
  isDraft?: boolean;
}

type UnrankedAttentionItem = Omit<AttentionItem, 'urgency' | 'urgencyReason'>;

interface AttentionCandidate {
  item: UnrankedAttentionItem;
  generation: string;
}

function attentionKey(host: string, sessionId: string, generation: string): string {
  return `${host}/${sessionId}/${generation}`;
}

export function attentionFingerprint(kind: AttentionKind, question?: BlockQuestion): string {
  const optionLabels = (question?.options ?? []).map((o) => o.label).join('\u0001');
  const material = `${kind}\u0000${question?.text ?? ''}\u0000${optionLabels}`;
  return createHash('sha1').update(material).digest('hex').slice(0, 16);
}

function structuredToBlockQuestion(sq: StructuredQuestion): BlockQuestion {
  const options = sq.options?.length
    ? sq.options.map((o) => ({ label: o.label, ...(o.description ? { description: o.description } : {}) }))
    : undefined;
  return {
    text: sq.text,
    ...(options ? { options } : {}),
    ...(sq.context ? { context: sq.context } : {}),
  };
}

function slugId(label: string): string {
  return label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

function questionChoices(question?: BlockQuestion, structured?: StructuredQuestion): AttentionChoice[] | undefined {
  const options = question?.options;
  if (!options?.length) return undefined;
  return options.map((o, i) => {
    const key = structured?.options?.[i]?.key;
    const choice: AttentionChoice = { ...o, id: slugId(o.label) || key || String(i + 1) };
    if (key) choice.deliveryKey = key;
    return choice;
  });
}

function permissionChoices(harness: string): AttentionChoice[] {
  const choices: AttentionChoice[] = [{ id: 'approve', label: 'Approve', deliveryKey: '1' }];
  if (harness === 'claude') choices.push({ id: 'approve-session', label: 'Approve for session', deliveryKey: '2' });
  choices.push({ id: 'deny', label: 'Deny', deliveryKey: 'esc' });
  return choices;
}

function planReviewChoices(): AttentionChoice[] {
  return [
    { id: 'approve', label: 'Approve plan', deliveryKey: '1' },
    { id: 'send-back', label: 'Send back', deliveryKey: 'esc' },
  ];
}

function choicesForItem(
  kind: AttentionKind,
  harness: string,
  question?: BlockQuestion,
  structured?: StructuredQuestion,
): AttentionChoice[] | undefined {
  if (kind === 'permission') return permissionChoices(harness);
  if (kind === 'plan_review') return planReviewChoices();
  if (kind === 'unverified') return undefined;
  return questionChoices(question, structured);
}

export function harnessOf(session: Partial<Pick<ActiveSession, 'harness' | 'kind'>>): string {
  return session.harness ?? session.kind ?? '';
}

function replyCapabilityForSession(session: ActiveSession): ReplyCapability {
  if (session.host === 'tmux') return 'tmux';
  switch (session.context) {
    case 'cloud':
      return 'cloud';
    case 'teams':
      return 'team';
    case 'terminal':
      return 'terminal';
    default:
      return 'none';
  }
}

function sessionCursor(session: ActiveSession): SourceCursor | undefined {
  return session.lastActivityMs != null ? { lastActivityMs: session.lastActivityMs } : undefined;
}

function openedAtForSession(session: ActiveSession, nowMs: number): string {
  const ms = session.lastActivityMs ?? session.startedAtMs ?? nowMs;
  return new Date(ms).toISOString();
}

function generationForSession(session: ActiveSession): string {
  return session.lastActivityMs != null ? `t${session.lastActivityMs}` : `s${session.sessionId ?? ''}`;
}

export const UNVERIFIED_PROMPT_AGE_MS = 30 * 60_000;

function kindFromNotification(notificationType: string | undefined): AttentionKind | undefined {
  switch (notificationType) {
    case 'permission_prompt':
      return 'permission';
    case 'elicitation_dialog':
      return 'question';
    case 'idle_prompt':

      return undefined;
    default:
      return 'unverified';
  }
}

function kindFromBlock(block: OpenBlock): AttentionKind | undefined {
  switch (block.kind) {
    case 'declared':
      return 'declared';
    case 'notification':
      return kindFromNotification(block.notificationType);
    case 'control':
      return 'stall';
    case 'question':
    default:
      return 'question';
  }
}

function resolvedByLaterEvidence(block: OpenBlock, session: ActiveSession): boolean {
  if (session.pidAlive === false) return true;
  const cursor = block.sourceCursor?.lastActivityMs;
  const eventMs = session.lastEventMs;
  return cursor != null && eventMs != null && eventMs > cursor;
}

function permissionVerifiable(block: OpenBlock, session: ActiveSession, nowMs: number): boolean {

  if (block.sourceCursor?.lastActivityMs != null && session.lastEventMs != null) return true;
  const openedMs = Date.parse(block.ts);
  return Number.isFinite(openedMs) && nowMs - openedMs < UNVERIFIED_PROMPT_AGE_MS;
}

function attentionFromBlock(block: OpenBlock, session: ActiveSession, nowMs: number): AttentionCandidate | undefined {
  const question = block.questions[0];
  let kind = kindFromBlock(block);
  if (!kind) return undefined;
  if (blockSource(block) === 'hook' && resolvedByLaterEvidence(block, session)) return undefined;
  if (kind === 'permission' && !permissionVerifiable(block, session, nowMs)) kind = 'unverified';
  const generation = blockGeneration(block);
  const item: UnrankedAttentionItem = {
    key: attentionKey(block.host, block.sessionId, generation),
    sessionId: block.sessionId,
    mailboxId: block.mailboxId,
    host: block.host,
    project: block.project ?? session.project ?? undefined,
    kind,
    source: blockSource(block),
    state: deriveBlockState(block),
    openedAt: block.ts,
    question,
    choices: choicesForItem(kind, harnessOf(session), question),
    replyCapability: replyCapabilityForSession(session),
    safeDefault: kind === 'unverified' ? undefined : block.safeDefault,
    fingerprint: attentionFingerprint(kind, question),
    sourceCursor: block.sourceCursor ?? sessionCursor(session),
  };
  return { item, generation };
}

export function currentTurnVerdict(session: ActiveSession): TurnVerdict | undefined {
  const v = session.turnVerdict;
  if (!v || session.activity === 'working') return undefined;
  if (session.lastEventMs != null && session.lastEventMs > v.atMs) return undefined;
  return v;
}

function attentionFromTurnVerdict(session: ActiveSession): AttentionCandidate | undefined {
  const v = currentTurnVerdict(session);
  if (!v || (v.kind !== 'asks' && v.kind !== 'not_done')) return undefined;
  const question: BlockQuestion = v.kind === 'asks'
    ? { text: v.quote || 'The agent is waiting for your answer.', ...(v.choices.length ? { options: v.choices.map((label) => ({ label })) } : {}) }
    : { text: v.quote || 'The agent stopped before finishing.', header: 'Not done' };
  const host = session.host ?? 'unknown';
  const sessionId = session.sessionId ?? '';
  const generation = `v${v.atMs}`;
  const item: UnrankedAttentionItem = {
    key: attentionKey(host, sessionId, generation),
    sessionId,
    mailboxId: sessionId,
    host,
    project: session.project ?? undefined,
    kind: 'question',
    source: 'lifecycle',
    state: 'open',
    openedAt: new Date(v.atMs).toISOString(),
    question,
    choices: questionChoices(question),
    replyCapability: replyCapabilityForSession(session),
    fingerprint: attentionFingerprint('question', question),
    sourceCursor: { lastActivityMs: v.atMs },
  };
  return { item, generation };
}

function attentionFromSession(session: ActiveSession, nowMs: number): AttentionCandidate | undefined {
  if (session.activity !== 'waiting_input') return undefined;
  const reason = session.awaitingReason;
  if (!reason) return undefined;

  const kind: AttentionKind =
    reason === 'plan_review' ? 'plan_review' : reason === 'permission' ? 'unverified' : 'question';
  const sq = session.question;
  const structural = kind === 'plan_review' || (kind === 'question' && (sq?.options?.length ?? 0) > 0);
  if (!structural && kind === 'question' && harnessOf(session) === 'claude') return undefined;
  const source: AttentionSource = structural ? 'lifecycle' : 'heuristic';
  const question = sq ? structuredToBlockQuestion(sq) : undefined;

  const host = session.host ?? 'unknown';
  const sessionId = session.sessionId ?? '';
  const generation = generationForSession(session);
  const item: UnrankedAttentionItem = {
    key: attentionKey(host, sessionId, generation),
    sessionId,
    mailboxId: sessionId,
    host,
    project: session.project ?? undefined,
    kind,
    source,
    state: 'open',
    openedAt: openedAtForSession(session, nowMs),
    question,
    choices: choicesForItem(kind, harnessOf(session), question, sq),
    replyCapability: replyCapabilityForSession(session),
    fingerprint: attentionFingerprint(kind, question),
    sourceCursor: sessionCursor(session),
  };
  return { item, generation };
}

function attentionFromPullRequest(
  session: ActiveSession,
  nowMs: number,
  pr?: PullRequestAttentionSignal,
): AttentionCandidate | undefined {
  if (!pr?.needsHuman) return undefined;
  const host = session.host ?? 'unknown';
  const sessionId = session.sessionId ?? '';
  const question: BlockQuestion = {
    text: `Review PR #${pr.number}${pr.title ? `: ${pr.title}` : ''}`,
    header: 'Review',
  };
  const generation = `pr${pr.number}:${pr.reviewDecision ?? pr.state ?? ''}`;
  const item: UnrankedAttentionItem = {
    key: attentionKey(host, sessionId, generation),
    sessionId,
    mailboxId: sessionId,
    host,
    project: session.project ?? undefined,
    kind: 'review',
    source: 'system',
    state: 'open',
    openedAt: openedAtForSession(session, nowMs),
    question,
    replyCapability: replyCapabilityForSession(session),
    fingerprint: attentionFingerprint('review', question),
    sourceCursor: sessionCursor(session),
  };
  return { item, generation };
}

function resolutionFenceMs(resolution: AttentionResolution): number | undefined {
  const cursor = resolution.sourceCursor?.lastActivityMs;
  if (cursor != null) return cursor;
  const parsed = Date.parse(resolution.resolvedAt);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function coveredByResolution(candidate: AttentionCandidate, resolution?: AttentionResolution): boolean {

  if (!resolution) return false;
  if (resolution.blockId !== blockIdForSession(candidate.item.sessionId)) return false;
  if (candidate.generation === resolution.generation) return true;
  const candidateCursor = candidate.item.sourceCursor?.lastActivityMs;
  const fence = resolutionFenceMs(resolution);
  if (candidateCursor != null && fence != null) return candidateCursor <= fence;
  return true;
}

const TICKET_PRIORITY: Record<number, { urgency: AttentionUrgency; name: string }> = {
  1: { urgency: 'urgent', name: 'Urgent' },
  2: { urgency: 'high', name: 'High' },
  3: { urgency: 'normal', name: 'Medium' },
  4: { urgency: 'low', name: 'Low' },
};

const RELEASE_COMMAND = new RegExp([
  String.raw`(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:publish|release|deploy)`,
  String.raw`(?:cargo|vsce|ovsx)\s+publish`,
  String.raw`twine\s+upload`,
  String.raw`gh\s+pr\s+merge`,
  String.raw`gh\s+release\s+create`,
  String.raw`release\.sh`,
  String.raw`(?:wrangler|fly|flyctl|railway|vercel)\s+deploy`,
  String.raw`terraform\s+apply`,
  String.raw`kubectl\s+apply`,
  String.raw`helm\s+(?:upgrade|install)`,
  String.raw`docker\s+push`,
].map((p) => String.raw`\b${p}\b`).join('|'), 'i');
const RELEASE_WORD = /\b(?:publish(?:es|ing)?|releas(?:e|es|ing)|deploy(?:s|ing)?|merg(?:e|es|ing))\b/i;
// A command ask is matched on its command only: a path such as src/merge.ts is not a merge.
const COMMAND_KINDS: ReadonlySet<AttentionKind> = new Set(['permission', 'unverified']);
const PROSE_KINDS: ReadonlySet<AttentionKind> = new Set(['question', 'plan_review', 'declared']);

function releaseNoun(match: string): string {
  const m = match.toLowerCase();
  if (/deploy|terraform|kubectl|helm|docker/.test(m)) return 'a deploy';
  if (/merg/.test(m)) return 'a merge';
  return 'a release';
}

function releaseBlocker(item: UnrankedAttentionItem): string | undefined {
  const text = item.question?.text ?? '';
  if (!COMMAND_KINDS.has(item.kind) && !PROSE_KINDS.has(item.kind)) return undefined;
  const command = RELEASE_COMMAND.exec(text);
  if (command) return `Blocks ${releaseNoun(command[0])} (${command[0].replace(/\s+/g, ' ')})`;
  if (!PROSE_KINDS.has(item.kind)) return undefined;
  const word = RELEASE_WORD.exec(text);
  return word ? `Blocks ${releaseNoun(word[0])}` : undefined;
}

// costOfDelay is not an input: every declared block carries `high`, so it cannot single out a release.
export function attentionUrgency(
  item: UnrankedAttentionItem,
  ticket?: { id: string; priority?: number },
): { urgency: AttentionUrgency; urgencyReason?: string } {
  const release = releaseBlocker(item);
  if (release) return { urgency: 'urgent', urgencyReason: release };
  const known = ticket?.priority !== undefined ? TICKET_PRIORITY[ticket.priority] : undefined;
  if (ticket && known) {
    return known.urgency === 'normal'
      ? { urgency: 'normal' }
      : { urgency: known.urgency, urgencyReason: `${known.name} ticket ${ticket.id}` };
  }
  return { urgency: 'normal' };
}

export function attentionTicketId(session: ActiveSession, block?: OpenBlock): string | undefined {
  return session.ticket?.id ?? block?.ticket ?? undefined;
}

export function reconcileAttention(input: {
  block?: OpenBlock;
  session: ActiveSession;
  pullRequest?: PullRequestAttentionSignal;
  resolution?: AttentionResolution;
  ticketPriority?: (ticketId: string) => number | undefined;
  nowMs: number;
}): AttentionItem | undefined {
  const fromBlock =
    input.block && deriveBlockState(input.block) === 'open'
      ? attentionFromBlock(input.block, input.session, input.nowMs)
      : undefined;
  const candidate =
    fromBlock ??
    attentionFromSession(input.session, input.nowMs) ??
    attentionFromTurnVerdict(input.session) ??
    attentionFromPullRequest(input.session, input.nowMs, input.pullRequest);
  if (!candidate) return undefined;
  if (coveredByResolution(candidate, input.resolution)) return undefined;
  const ticketId = attentionTicketId(input.session, input.block);
  const ticket = ticketId ? { id: ticketId, priority: input.ticketPriority?.(ticketId) } : undefined;
  return { ...candidate.item, ...attentionUrgency(candidate.item, ticket) };
}
