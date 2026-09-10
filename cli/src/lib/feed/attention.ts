/**
 * Attention reconciliation — the CLI-owned merge that turns the feed's open-block
 * ledger and the session state engine's lifecycle output into ONE attention
 * lifecycle. This is the canonical contract Tracks B (feed stream + answer) and C
 * (AGI EXT projection) build on: the extension renders {@link AttentionItem}, it
 * never decides authority itself.
 *
 * The rule, strongest evidence first (see {@link reconcileAttention}):
 *   1. An OPEN feed block wins — it is explicit and answerable. Its KIND comes
 *      from what the harness actually raised (`notificationType`): only a
 *      `permission_prompt` is a permission; an `idle_prompt` ("the turn ended and
 *      you have been idle") is not a request at all and yields nothing here; an
 *      unrecorded subtype cannot be answered from a banner and reads as
 *      `unverified` (PHNX-3999). A hook-raised block the transcript has already
 *      moved past — a tool result or new assistant work stamped after the block
 *      was written, or a dead process — is resolved by that later evidence and
 *      yields nothing, whatever the block file still says.
 *   2. Otherwise the session lifecycle candidate (a structural plan handoff or
 *      option question, or a decaying prose question) becomes the attention item.
 *      A lifecycle `permission` claim (only an older peer's state engine still
 *      makes one) is `unverified`, never approvable.
 *   3. Otherwise a CLI-supplied pull-request signal can raise a review item.
 *   4. A resolution tombstone suppresses any candidate whose generation it already
 *      resolved, until the session advances strictly past the recorded cursor —
 *      so an answered item can never silently resurrect (the RUSH-1522 class).
 *
 * The reconciler is PURE: no filesystem, no transcript parsing, and the only
 * clock is the `nowMs` the caller hands in. It does not re-detect anything — it
 * models and reconciles the output the existing question / permission /
 * declared-block / answer / clear paths already produce.
 */
import { createHash } from 'node:crypto';
import type { ActiveSession } from '../session/active.js';
import type { StructuredQuestion } from '../session/state.js';
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

/**
 * What an attention item is asking of the operator. `unverified` is a request
 * record whose pending state this CLI could not confirm — a hook-raised prompt
 * with no transcript cursor to check it against that has aged past
 * {@link UNVERIFIED_PROMPT_AGE_MS}, a notification whose subtype the writer did
 * not record, or a lifecycle `permission` claim from a peer running an older
 * state engine. It carries no choices: the only honest action is to open the
 * session and look (PHNX-3999).
 */
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

/**
 * One answerable choice on an attention item. Extends {@link BlockOption} with a
 * stable `id` the UI echoes back when the operator picks it, and an optional
 * `deliveryKey` (the harness-native keystroke / selection token) that Track B's
 * answer router resolves the reply rail with.
 */
export interface AttentionChoice extends BlockOption {
  id: string;
  deliveryKey?: string;
}

/**
 * The canonical operator-facing attention record. One reconciled thing that needs
 * a human, whatever produced it. This is the public envelope Tracks B and C
 * consume — a stability contract, not an internal shape.
 */
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
  /**
   * Clusters IDENTICAL asks across different agents for batch triage. It is a hash
   * of the RAW question intent (kind + verbatim question text + option labels) —
   * deliberately NOT the UI-normalized display text, so two agents asking the same
   * thing collapse even when the floor renders them differently.
   */
  fingerprint: string;
  /** Where in the source this generation sits — the fence a resolution compares against. */
  sourceCursor?: SourceCursor;
}

/**
 * A pull-request attention signal, supplied BY the CLI (Track B refreshes it on a
 * bounded TTL and hands it in). Track A only consumes the computed `needsHuman`
 * flag — it never reaches into the extension's PR board or recomputes review
 * state. Fields mirror the `gh pr view` projection so Track B can populate it.
 */
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

/**
 * Fingerprint of an ask's raw intent. Uses the verbatim question text and option
 * labels (NOT display-normalized text) so identical asks from different agents
 * share a fingerprint for batch triage.
 */
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
  return { text: sq.text, ...(options ? { options } : {}) };
}

/** A label slugged to the `[a-z0-9-]+` id shape the notify argv and UIs echo back. */
function slugId(label: string): string {
  return label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

/**
 * Choices for a `question` item: the harness's own option list, each with a
 * stable `id` (the label slug, else its selection key, else the 1-based index).
 * A session lifecycle question carries per-option keys from the
 * {@link StructuredQuestion} the state engine parsed, which become the choice's
 * `deliveryKey`; a feed block carries none, so `deliveryKey` stays absent and the
 * answer router matches the label back to the TUI digit — the same value, but it
 * also stays readable in the mailbox fallback rather than a bare digit.
 */
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

/**
 * Harness-native keystrokes for a permission prompt's canonical choices. Claude
 * Code's permission prompt is a numbered select-list — option 1 is "Yes", option
 * 2 is "Yes, and don't ask again for this session", and Esc is "No". The
 * session-scoped option 2 is added here from the live prompt ordering; the
 * state detector no longer models permission prompts itself (PHNX-3999). A harness whose permission prompt exposes no
 * verified session-scoped option omits `approve-session`.
 *
 * ASSUMPTION — `approve-session`'s `deliveryKey: '2'` is asserted for every Claude
 * permission item, not derived from the live prompt. Claude renders a 3-option
 * select-list for most tool permissions, but a few prompt shapes offer only
 * "Yes" / "No" (no per-session variant). We do NOT capture the prompt over a PTY
 * to count its options — that read is not on the reconcile path — so on a
 * 2-option prompt this still offers "Approve for session", and answering it
 * types `2`+Enter, which Claude treats as a plain one-time approve rather than
 * erroring. The safe degradation (a session-scope answer falling back to a
 * one-time approve) is why this is asserted rather than gated: it never denies or
 * mis-routes, only under-delivers the "don't ask again" scope on the rare 2-option
 * prompt. Gating on real option count would require a per-item PTY capture; that
 * is the follow-up if the under-delivery proves to matter (PHNX-4004).
 */
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

/**
 * The answerable choices for one attention item. Permission and plan-review
 * carry canonical harness-native choices regardless of the question text;
 * everything else (question, declared, review) derives from the option list the
 * source supplied. An `unverified` record carries none — there is no confirmed
 * prompt for a choice to land in, so a banner must not invent approval buttons.
 */
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

/**
 * How long a hook-raised permission prompt is trusted on the hook's word alone
 * when the session offers no transcript cursor to verify it against (a cloud or
 * remote row, or a peer running an older CLI). Past this age with nothing to
 * check, the record is `unverified`: the banner keeps the session findable but
 * offers no Approve.
 */
export const UNVERIFIED_PROMPT_AGE_MS = 30 * 60_000;

/**
 * What a harness Notification actually asked for. The hook records the event's
 * `notification_type`; that subtype — not the fact that a notification fired — is
 * the evidence. `idle_prompt` means "the turn ended and the user has been idle for
 * a minute": nothing is pending, so it yields no request (the live bug behind
 * PHNX-3999 was rendering it with Approve/Deny). An `elicitation_dialog` is the
 * harness asking for input on a tool's behalf — a question whose reply contract
 * the block does not carry, so it exposes no invented choices. A block whose
 * writer recorded no subtype cannot say what it asked; it is `unverified`.
 */
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

/**
 * Whether the session has produced evidence that a hook-raised prompt was
 * answered or is moot, whatever the block file still says: a dead process cannot
 * be showing a dialog, and a transcript event stamped strictly after the block
 * was written (a tool result, a new assistant turn) means the agent moved past
 * the prompt. The comparison is against {@link ActiveSession.lastEventMs} — the
 * harness stamp on the last meaningful event — never the file mtime, which every
 * hook firing (including the one that wrote this block) advances.
 */
function resolvedByLaterEvidence(block: OpenBlock, session: ActiveSession): boolean {
  if (session.pidAlive === false) return true;
  const cursor = block.sourceCursor?.lastActivityMs;
  const eventMs = session.lastEventMs;
  return cursor != null && eventMs != null && eventMs > cursor;
}

/**
 * Whether a permission block can be confirmed as still pending. With both cursors
 * in hand the answer is exact: {@link resolvedByLaterEvidence} already ruled out
 * later work, so an unadvanced transcript IS the pending dialog. Without a
 * cursor to compare, the hook's own word is trusted only while the block is
 * younger than {@link UNVERIFIED_PROMPT_AGE_MS}.
 */
function permissionVerifiable(block: OpenBlock, session: ActiveSession, nowMs: number): boolean {
  if (block.sourceCursor?.lastActivityMs != null && session.lastEventMs != null) return true;
  const openedMs = Date.parse(block.ts);
  return Number.isFinite(openedMs) && nowMs - openedMs < UNVERIFIED_PROMPT_AGE_MS;
}

/**
 * An open feed block — the strongest, answerable evidence — or undefined when the
 * block is not a request (an idle reminder) or the session has already moved past
 * it. A permission the session cannot confirm degrades to `unverified` rather than
 * offering an Approve that may land in an empty prompt.
 */
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

/**
 * The session lifecycle fallback. It reads ONLY the state engine's already-computed
 * output ({@link ActiveSession.activity}/`awaitingReason`/`question`) — it does not
 * parse a transcript. A structural signal (plan handoff, or a question the harness
 * surfaced with discrete options) is `lifecycle`; a bare prose question the engine
 * inferred is the decaying `heuristic`. A `permission` reason is a claim only an
 * older peer's state engine still makes, from elapsed time rather than a harness
 * event; it is projected as `unverified` (heuristic, no choices) so the operator
 * is pointed at the session, never handed an Approve for a dialog that may not
 * exist.
 */
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

/**
 * Whether a resolution tombstone already covers this candidate — the
 * anti-resurrection gate. It covers when the tombstone is for this session AND
 * either the exact generation was already resolved, or the candidate's source
 * cursor has not advanced strictly past the tombstone's fence. When advancement
 * cannot be proven (no comparable cursor) it covers, the conservative default:
 * a resolved item stays gone rather than flicker back (RUSH-1522).
 */
function coveredByResolution(candidate: AttentionCandidate, resolution?: AttentionResolution): boolean {
  if (!resolution) return false;
  if (resolution.blockId !== blockIdForSession(candidate.item.sessionId)) return false;
  if (candidate.generation === resolution.generation) return true;
  const candidateCursor = candidate.item.sourceCursor?.lastActivityMs;
  const fence = resolutionFenceMs(resolution);
  if (candidateCursor != null && fence != null) return candidateCursor <= fence;
  return true;
}

/**
 * Reconcile the feed block ledger, the session lifecycle, a CLI-supplied PR
 * signal, and the latest resolution tombstone into one attention item — or
 * `undefined` when nothing needs a human. Pure; the extension never chooses
 * authority.
 */
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
