/** Attention reconciliation (canonical; the extension never decides authority): an open feed block
 * wins, kind from `notificationType` (`idle_prompt` yields nothing, PHNX-3999); else the session
 * lifecycle; else a PR signal. A tombstone stops resurrection (RUSH-1522). Pure. */
import { createHash } from 'node:crypto';
import type { ActiveSession } from '../session/active.js';
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

/** What an attention item asks of the operator. `unverified` is a request this CLI could not
 * confirm (aged hook prompt with no cursor, unrecorded subtype, or an old peer's `permission`
 * claim); it carries no choices, so the only action is to open the session (PHNX-3999). */
export type AttentionKind =
  | 'question'
  | 'permission'
  | 'plan_review'
  | 'declared'
  | 'failure'
  | 'stall'
  | 'review'
  | 'unverified';

/** How an answer can be routed back to the waiting agent. */
export type ReplyCapability = 'terminal' | 'tmux' | 'cloud' | 'team' | 'none';

/** One answerable choice: extends BlockOption with a stable `id` the UI echoes back and an
 * optional `deliveryKey` (harness-native selection token) the answer router resolves the reply
 * rail with. */
export interface AttentionChoice extends BlockOption {
  id: string;
  deliveryKey?: string;
}

/** The canonical operator-facing attention record: one reconciled thing that needs a human. A
 * public envelope with a stability contract. */
export interface AttentionItem {
  /** Stable identity: `host/session/generation`. A new generation is a new item. */
  key: string;
  sessionId: string;
  mailboxId: string;
  host: string;
  project?: string;
  kind: AttentionKind;
  source: AttentionSource;
  state: AttentionState;
  /** ISO-8601 timestamp the ask opened. */
  openedAt: string;
  question?: BlockQuestion;
  choices?: AttentionChoice[];
  replyCapability: ReplyCapability;
  safeDefault?: string;
  /** Clusters identical asks across agents for batch triage: a hash of the raw question intent
   * (kind, verbatim text, option labels), deliberately not the UI-normalized display text. */
  fingerprint: string;
  /** Where in the source this generation sits — the fence a resolution compares against. */
  sourceCursor?: SourceCursor;
}

/** A pull-request attention signal supplied by the CLI (refreshed on a bounded TTL). Only the
 * computed `needsHuman` flag is consumed; fields mirror the `gh pr view` projection. */
export interface PullRequestAttentionSignal {
  number: number;
  title?: string;
  url?: string;
  /** True when the PR is in a state that needs a human decision (review / merge). */
  needsHuman: boolean;
  reviewDecision?: string;
  mergeable?: string;
  state?: string;
  isDraft?: boolean;
}

/** A candidate plus the generation the reconciler resolves suppression against. */
interface AttentionCandidate {
  item: AttentionItem;
  generation: string;
}

/** Stable attention key: host + session + generation (see the proposed C4 diagram). */
function attentionKey(host: string, sessionId: string, generation: string): string {
  return `${host}/${sessionId}/${generation}`;
}

/** Fingerprint of an ask's raw intent (verbatim question and option labels, not display text) so
 * identical asks share one for batch triage. */
export function attentionFingerprint(kind: AttentionKind, question?: BlockQuestion): string {
  const optionLabels = (question?.options ?? []).map((o) => o.label).join('\u0001');
  const material = `${kind}\u0000${question?.text ?? ''}\u0000${optionLabels}`;
  return createHash('sha1').update(material).digest('hex').slice(0, 16);
}

/** Convert a session-engine {@link StructuredQuestion} into the feed {@link BlockQuestion} shape. */
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

/** A label slugged to the `[a-z0-9-]+` id shape the notify argv and UIs echo back. */
function slugId(label: string): string {
  return label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

/** Choices for a `question` item from the harness's option list, each with a stable `id` (label
 * slug, else selection key, else index). */
function questionChoices(question?: BlockQuestion, structured?: StructuredQuestion): AttentionChoice[] | undefined {
  const options = question?.options;
  if (!options?.length) return undefined;
  return options.map((o, i) => {
    // The harness-native selection key, when the state engine parsed one. A feed
    // block carries no per-option key, so `deliveryKey` stays absent and the
    // router matches the label to a TUI digit (readable in the mailbox fallback).
    const key = structured?.options?.[i]?.key;
    const choice: AttentionChoice = { ...o, id: slugId(o.label) || key || String(i + 1) };
    if (key) choice.deliveryKey = key;
    return choice;
  });
}

/** Harness-native keystrokes for a permission prompt: Claude's list is 1 Yes, 2 Yes for this
 * session, Esc No (PHNX-3999). `approve-session` asserts key `2`; on a rare 2-option prompt it
 * degrades to a one-time approve, never a deny (gating needs a PTY capture, PHNX-4004). */
function permissionChoices(harness: string): AttentionChoice[] {
  const choices: AttentionChoice[] = [{ id: 'approve', label: 'Approve', deliveryKey: '1' }];
  if (harness === 'claude') choices.push({ id: 'approve-session', label: 'Approve for session', deliveryKey: '2' });
  choices.push({ id: 'deny', label: 'Deny', deliveryKey: 'esc' });
  return choices;
}

/** Plan-review canonical choices: approve the plan (option 1) or send it back (Esc/keep planning). */
function planReviewChoices(): AttentionChoice[] {
  return [
    { id: 'approve', label: 'Approve plan', deliveryKey: '1' },
    { id: 'send-back', label: 'Send back', deliveryKey: 'esc' },
  ];
}

/** Answerable choices for one item. Permission and plan-review use canonical harness-native
 * choices; others derive from the source's option list. An `unverified` record carries none,
 * since no confirmed prompt exists to land a choice in. */
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

/** Harness id behind a session — the profile name when set, else the host process. */
export function harnessOf(session: ActiveSession): string {
  return session.harness ?? session.kind ?? '';
}

/** Which reply rail reaches the agent behind this session. */
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
      // A headless run with no tmux pane has no addressable reply rail. Say so
      // loudly rather than pretend 'terminal' — Track B routes on this verdict.
      return 'none';
  }
}

function sessionCursor(session: ActiveSession): SourceCursor | undefined {
  return session.lastActivityMs != null ? { lastActivityMs: session.lastActivityMs } : undefined;
}

/** Best-available ISO stamp for when the ask opened. */
function openedAtForSession(session: ActiveSession, nowMs: number): string {
  const ms = session.lastActivityMs ?? session.startedAtMs ?? nowMs;
  return new Date(ms).toISOString();
}

/** A session's generation tracks its transcript cursor, so a newer turn is a new generation. */
function generationForSession(session: ActiveSession): string {
  return session.lastActivityMs != null ? `t${session.lastActivityMs}` : `s${session.sessionId ?? ''}`;
}

/** How long a hook-raised permission prompt is trusted on the hook's word alone when no
 * transcript cursor can verify it (cloud, remote, or older CLI). Past this age it is
 * `unverified`: findable, but no Approve. */
export const UNVERIFIED_PROMPT_AGE_MS = 30 * 60_000;

/** What a Notification asked for, from the hook's `notification_type`. `idle_prompt` means
 * nothing is pending and yields no request (the PHNX-3999 bug rendered it with Approve/Deny).
 * `elicitation_dialog` exposes no invented choices; a block with no subtype is `unverified`. */
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

/** The attention kind an open block carries, or undefined when the block is not a request. */
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

/** Whether the session shows a hook-raised prompt was answered or moot: a dead process, or a
 * transcript event stamped after the block. Compares against ActiveSession.lastEventMs, never
 * file mtime, which every hook firing advances. */
function resolvedByLaterEvidence(block: OpenBlock, session: ActiveSession): boolean {
  if (session.pidAlive === false) return true;
  const cursor = block.sourceCursor?.lastActivityMs;
  const eventMs = session.lastEventMs;
  return cursor != null && eventMs != null && eventMs > cursor;
}

/** Whether a permission block is confirmably pending. With both cursors, an unadvanced
 * transcript is the pending dialog; without one, the hook's word is trusted only while younger
 * than UNVERIFIED_PROMPT_AGE_MS. */
function permissionVerifiable(block: OpenBlock, session: ActiveSession, nowMs: number): boolean {
  if (block.sourceCursor?.lastActivityMs != null && session.lastEventMs != null) return true;
  const openedMs = Date.parse(block.ts);
  return Number.isFinite(openedMs) && nowMs - openedMs < UNVERIFIED_PROMPT_AGE_MS;
}

/** An open feed block (the strongest, answerable evidence), or undefined when it is not a
 * request or the session moved past it. An unconfirmable permission degrades to `unverified`
 * rather than offering an Approve that may hit an empty prompt. */
function attentionFromBlock(block: OpenBlock, session: ActiveSession, nowMs: number): AttentionCandidate | undefined {
  const question = block.questions[0];
  let kind = kindFromBlock(block);
  if (!kind) return undefined;
  if (blockSource(block) === 'hook' && resolvedByLaterEvidence(block, session)) return undefined;
  if (kind === 'permission' && !permissionVerifiable(block, session, nowMs)) kind = 'unverified';
  const generation = blockGeneration(block);
  const item: AttentionItem = {
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
    // A safe default is an automatic answer; an unconfirmed prompt gets none.
    safeDefault: kind === 'unverified' ? undefined : block.safeDefault,
    fingerprint: attentionFingerprint(kind, question),
    sourceCursor: block.sourceCursor ?? sessionCursor(session),
  };
  return { item, generation };
}

/** The session lifecycle fallback; reads only the state engine's computed output and parses no
 * transcript. Structural signals are `lifecycle`, an inferred prose question the decaying
 * `heuristic`. An older peer's `permission` claim is projected `unverified`, never approvable. */
function attentionFromSession(session: ActiveSession, nowMs: number): AttentionCandidate | undefined {
  if (session.activity !== 'waiting_input') return undefined;
  const reason = session.awaitingReason;
  if (!reason) return undefined;

  const kind: AttentionKind =
    reason === 'plan_review' ? 'plan_review' : reason === 'permission' ? 'unverified' : 'question';
  const sq = session.question;
  const structural = kind === 'plan_review' || (kind === 'question' && (sq?.options?.length ?? 0) > 0);
  const source: AttentionSource = structural ? 'lifecycle' : 'heuristic';
  const question = sq ? structuredToBlockQuestion(sq) : undefined;

  const host = session.host ?? 'unknown';
  const sessionId = session.sessionId ?? '';
  const generation = generationForSession(session);
  const item: AttentionItem = {
    key: attentionKey(host, sessionId, generation),
    sessionId,
    // No mailbox rides an ActiveSession row; the feed store's own default is
    // `mailbox = session id`, so mirror it here rather than invent a second rule.
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

/** A CLI-supplied PR signal that a human decision is pending. */
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
  // A review's generation is its PR number + decision/state, so a state change
  // (review requested -> approved) is a new generation, not a stuck one.
  const generation = `pr${pr.number}:${pr.reviewDecision ?? pr.state ?? ''}`;
  const item: AttentionItem = {
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

/** The temporal fence a resolution tombstone draws: its own cursor, else its wall-clock time. */
function resolutionFenceMs(resolution: AttentionResolution): number | undefined {
  const cursor = resolution.sourceCursor?.lastActivityMs;
  if (cursor != null) return cursor;
  const parsed = Date.parse(resolution.resolvedAt);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/** Whether a resolution tombstone already covers this candidate (anti-resurrection): same
 * session and either the generation was resolved or the cursor has not advanced strictly past
 * the fence. With no comparable cursor it covers, so a resolved item stays gone (RUSH-1522). */
function coveredByResolution(candidate: AttentionCandidate, resolution?: AttentionResolution): boolean {
  if (!resolution) return false;
  if (resolution.blockId !== blockIdForSession(candidate.item.sessionId)) return false;
  if (candidate.generation === resolution.generation) return true;
  const candidateCursor = candidate.item.sourceCursor?.lastActivityMs;
  const fence = resolutionFenceMs(resolution);
  if (candidateCursor != null && fence != null) return candidateCursor <= fence;
  return true;
}

/** Reconciles the block ledger, session lifecycle, CLI-supplied PR signal and latest tombstone
 * into one attention item, or undefined. Pure. */
export function reconcileAttention(input: {
  block?: OpenBlock;
  session: ActiveSession;
  pullRequest?: PullRequestAttentionSignal;
  resolution?: AttentionResolution;
  nowMs: number;
}): AttentionItem | undefined {
  // An open block that is not a request (an idle reminder) or that the session
  // has moved past yields nothing, and the lifecycle then speaks for itself — a
  // finished turn reads as idle, a trailing prose question as the inferred ask.
  const fromBlock =
    input.block && deriveBlockState(input.block) === 'open'
      ? attentionFromBlock(input.block, input.session, input.nowMs)
      : undefined;
  const candidate =
    fromBlock ??
    attentionFromSession(input.session, input.nowMs) ??
    attentionFromPullRequest(input.session, input.nowMs, input.pullRequest);
  if (!candidate) return undefined;
  if (coveredByResolution(candidate, input.resolution)) return undefined;
  return candidate.item;
}
