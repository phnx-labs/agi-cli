/**
 * Deliver one operator answer to one open attention item (PHNX-3999).
 *
 * The AGI Menu abandons a reply at 30s, so every path here is bounded and every
 * outcome is reported from real evidence:
 *
 *   - **Match before enrichment.** The requested key names its session, so the
 *     candidate set is that session alone and the optional `gh pr view` read
 *     runs only for a key whose generation is a PR review. Enriching every
 *     active session first spent one 15s-bounded `gh` call per session on a
 *     question that never needed one.
 *   - **Unknown stays unknown.** Three outcomes are distinct and never merged: a
 *     confirmed failure (nothing was sent, the claim is released, retry is safe),
 *     an unconfirmed delivery (something may have landed, the claim is KEPT), and
 *     a real receipt. A timeout is unconfirmed, never a failure.
 *   - **Receipts are read, never synthesized, and never over-read.** `queued`
 *     means a rail took the answer and nothing more; only the agent's own
 *     `consumed`/`continued` resolves the item; `dropped`/`expired` are failures.
 *   - **Replay is de-duplicable or refused.** A claim stranded by a kill is
 *     adopted only on the mailbox rail, where the queued message's block id makes
 *     re-delivery detectable, and only through a compare-and-swap on the claim so
 *     two retries cannot both adopt it. A keystroke or resume rail cannot be
 *     replayed safely, so it reports unknown and points at the session.
 *   - **Exact tokens across the hop.** A remote answer is quoted with the
 *     canonical `shellQuote` and run through the canonical bounded `sshExecAsync`,
 *     so newlines and shell metacharacters arrive byte-identical, and the returned
 *     receipt is verified to belong to the key that was asked about.
 *
 *   - **A claim is not a resolution.** The claim is taken `pending`
 *     (`recordAnswer`'s two-phase option): it locks the item against a second
 *     surface but leaves the block `open` and writes no tombstone, so the card
 *     stays in the operator's feed. Only a real receipt calls
 *     `confirmAnswerResolution` and lets the item leave. A delivery that never
 *     confirms can no longer make the request silently disappear.
 */
import { spawn } from 'node:child_process';
import { getActiveSessions, type ActiveSession } from '../session/active.js';
import { resolveAnswerRoute, resumeArgv, type AnswerRoute } from '../answer-router.js';
import { enqueue, mailboxDir, readBox } from '../mailbox.js';
import { backendCarriesPaste, injectIntoTerminal } from '../terminal/index.js';
import { verifyOperatorIdentity } from '../operator.js';
import { machineId, normalizeHost } from '../machine-id.js';
import { shellQuote, sshExecAsync, SSH_CONN_FAILURE_CODE, SSH_TIMEOUT_KILL_GRACE_MS } from '../ssh-exec.js';
import {
  blockGeneration,
  blockIdForSession,
  confirmAnswerResolution,
  getAnswerRecord,
  latestMessageReceipt,
  publishBlock,
  readBlock,
  readResolution,
  recordAnswer,
  recordMessageReceipt,
  rollbackAnswerClaim,
  type ReceiptOrigin,
  type AnswerRecord,
  type AttentionResolution,
  type MessageReceipt,
  type OpenBlock,
} from './feed.js';
import { reconcileAttention, type AttentionItem } from './attention.js';
import { readPullRequestStatus } from './pr-status.js';
import { getAgentsInvocation } from '../daemon/daemon.js';

/**
 * Total budget for one answer. Sits below the AGI Menu's 30s abandon so the
 * operator always gets a typed verdict instead of a timeout.
 */
export const ANSWER_DEADLINE_MS = 20_000;
/** Slice of the budget the optional PR-review enrichment may spend. */
export const PR_ENRICHMENT_BUDGET_MS = 4_000;
/** Budget for the forwarded leg — the remote repeats the local work under its own deadline. */
export const REMOTE_ANSWER_TIMEOUT_MS = 25_000;
/**
 * A claim older than this with no receipt was stranded by a kill, not left in
 * flight: it exceeds a full local deadline plus the remote leg, so no live
 * delivery can still be running behind it.
 */
export const STRANDED_CLAIM_MS = 60_000;
/**
 * How long to watch a `resume` child before giving up on a verdict. A resume
 * runs the agent's whole next turn — minutes — so waiting for exit would blow the
 * operator deadline on every headless answer. Only a clean early exit is booked;
 * a non-zero exit or a still-running child is unknown, because neither proves
 * the agent did or did not accept the prompt.
 */
export const RESUME_SETTLE_MS = 2_000;
/**
 * How long a caller that LOST the claim waits for the holder's receipt before
 * reporting unknown. The holder is mid-delivery — a double-clicked answer is the
 * common case — so a short wait turns "I can't tell" into the real receipt,
 * without ever delivering a second copy.
 */
export const HOLDER_RECEIPT_WAIT_MS = 400;
const HOLDER_RECEIPT_POLL_MS = 20;

/** Why an answer could not be delivered — the discriminant the operator UI branches on. */
export type AnswerFailureCode =
  | 'malformed_key'
  | 'no_session'
  | 'stale'
  | 'unverified'
  | 'unauthorized'
  | 'unknown_choice'
  | 'empty_answer'
  | 'refused'
  | 'rail_failed'
  | 'timeout'
  | 'remote_failed';

/** A CONFIRMED failure: nothing reached a rail, the claim is released, retry is safe. */
export class AnswerError extends Error {
  constructor(message: string, readonly code: AnswerFailureCode) {
    super(message);
    this.name = 'AnswerError';
  }
}

/**
 * An UNCONFIRMED outcome: something may have been delivered. The claim is kept
 * so a retry cannot double-send, and the operator is offered a delivery check
 * rather than a resend.
 */
export class AnswerUnknownError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AnswerUnknownError';
  }
}

/**
 *   delivered        — this call handed the answer to a rail.
 *   already_answered — another claim owns it; the reported evidence is that claim's.
 *   unknown          — something may have landed; do NOT resend, check delivery.
 *   failed           — confirmed: nothing was delivered.
 */
export type AnswerStatus = 'delivered' | 'already_answered' | 'unknown' | 'failed';

/**
 *   receipt     — a real {@link MessageReceipt} exists on the block.
 *   unconfirmed — no receipt evidence either way. The card must NOT be cleared.
 *   failed      — confirmed failure, including a `dropped`/`expired` receipt.
 */
export type AnswerDelivery = 'receipt' | 'unconfirmed' | 'failed';

export interface FeedAnswerResult {
  status: AnswerStatus;
  /** How much the CLI can actually vouch for. */
  delivery: AnswerDelivery;
  /** The block's real receipt. Absent means no rail ever reported one. */
  receipt?: MessageReceipt;
  /**
   * The AGENT's own evidence that it received the answer — a `consumed` or
   * `continued` receipt. A `queued` receipt is delivery, never resolution, so it
   * leaves this false. Removal of the item from the feed resolves the card on
   * its own; this flag only ever adds evidence, it never withholds it.
   */
  resolved: boolean;
  /** Human explanation for a failure, an unknown, or an unconfirmed delivery. */
  reason?: string;
  /** Set when `status` is `failed`. */
  code?: AnswerFailureCode;
  attentionKey: string;
  blockId?: string;
  /** The device that owns the item — the exact target a delivery check re-queries. */
  host?: string;
  /**
   * Stable identity of the delivery attempt (the claim timestamp). A delivery
   * check correlates its read-only answer with the attempt it is checking, so
   * "still unconfirmed" is distinguishable from "a newer attempt replaced it".
   */
  attempt?: string;
}

interface VerifiedOperator { id?: string; verified: boolean; label?: string }

// --- attention key ----------------------------------------------------------

export interface ParsedAttentionKey { host: string; sessionId: string; generation: string }

/**
 * Split `<host>/<session>/<generation>` (attention.ts `attentionKey`). Fails
 * loud on a malformed key: the old `slice(0, indexOf('/'))` returned a truncated
 * host for a key with no separator, which then routed the answer at random.
 */
export function parseAttentionKey(key: string): ParsedAttentionKey {
  const first = key.indexOf('/');
  const last = key.lastIndexOf('/');
  if (first <= 0 || last <= first || last === key.length - 1) {
    throw new AnswerError(
      `Malformed attention key '${key}' — expected '<host>/<session>/<generation>'.`,
      'malformed_key',
    );
  }
  return { host: key.slice(0, first), sessionId: key.slice(first + 1, last), generation: key.slice(last + 1) };
}

/**
 * Whether THIS machine owns the item. The exact local/remote choice: the key's
 * host is compared through the same {@link normalizeHost} the machine id is
 * minted with, so `Yosemite-M4.local` and `yosemite-m4` are one machine.
 */
export function answerOwnerIsLocal(host: string, self: string = machineId()): boolean {
  return normalizeHost(host) === normalizeHost(self);
}

/** A PR-review generation (`pr<number>:<decision>`) — the only kind a `gh` read can produce. */
function isPullRequestGeneration(generation: string): boolean {
  return /^pr\d+:/.test(generation);
}

// --- receipt semantics ------------------------------------------------------

/**
 * What a stored receipt proves. The lifecycle vocabulary is fixed by
 * `MessageReceipt`, and each member means exactly one thing here:
 *   queued            — a rail took the answer. Delivery, never resolution.
 *   consumed/continued— the agent itself acknowledged it. This resolves the item.
 *   dropped/expired   — terminal failure; it is the newest truth for its message
 *                       (the write rank puts it top precisely so it cannot be
 *                       regressed), which is exactly why it must not read as success.
 */
export function classifyReceipt(receipt: MessageReceipt): { delivery: AnswerDelivery; resolved: boolean } {
  if (receipt.status === 'consumed' || receipt.status === 'continued') return { delivery: 'receipt', resolved: true };
  if (receipt.status === 'queued') return { delivery: 'receipt', resolved: false };
  return { delivery: 'failed', resolved: false };
}

// --- deadline ---------------------------------------------------------------

interface Deadline { endMs: number }
function startDeadline(totalMs: number): Deadline { return { endMs: Date.now() + totalMs }; }
function remainingMs(deadline: Deadline): number { return deadline.endMs - Date.now(); }

/**
 * Bound one delivery await. Expiry is UNKNOWN, not failure: the rail's own child
 * may still land the answer, so the claim stays and the operator is sent to a
 * delivery check.
 */
async function withinDeadline<T>(work: Promise<T>, deadline: Deadline, what: string): Promise<T> {
  const budget = remainingMs(deadline);
  if (budget <= 0) throw new AnswerUnknownError(`${what} had no budget left; delivery is unknown.`);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new AnswerUnknownError(`${what} did not finish in ${budget}ms; delivery is unknown.`)), budget);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// --- resolution -------------------------------------------------------------

function blockFromAttention(attention: AttentionItem, session: ActiveSession): OpenBlock {
  return {
    blockId: blockIdForSession(attention.sessionId), sessionId: attention.sessionId,
    mailboxId: attention.mailboxId, host: attention.host, runtime: session.kind,
    generation: attention.key.slice(attention.key.lastIndexOf('/') + 1), source: attention.source,
    state: 'open', sourceCursor: attention.sourceCursor, project: attention.project,
    ts: attention.openedAt, questions: [attention.question ?? { text: 'Continue from this attention item.' }],
    kind: attention.kind === 'permission' ? 'notification' : attention.kind === 'declared' ? 'declared' : attention.source === 'system' ? 'control' : 'question',
    // A notification block is a permission only by its recorded subtype
    // (attention.ts kindFromNotification), so the reconstructed block must carry
    // it or a re-read classifies the same item as unverified.
    ...(attention.kind === 'permission' ? { notificationType: 'permission_prompt' } : {}),
    safeDefault: attention.safeDefault,
  };
}

interface ResolvedTarget { block: OpenBlock; attention: AttentionItem; session: ActiveSession }
interface MatchOutcome { hit?: ResolvedTarget; observed?: AttentionItem }

/**
 * Reconcile one session against the requested key. `pullRequest` is passed only
 * on the enrichment pass — `reconcileAttention` consults it last
 * (`attentionFromPullRequest`), so a block- or session-derived match never needed it.
 */
function matchSession(
  session: ActiveSession,
  key: ParsedAttentionKey,
  attentionKey: string,
  root: string | undefined,
  pullRequest: Awaited<ReturnType<typeof readPullRequestStatus>>,
): MatchOutcome {
  const projected = { ...session, host: key.host };
  const blockId = blockIdForSession(session.sessionId as string);
  const block = readBlock(blockId, root);
  const attention = reconcileAttention({
    block, session: projected, pullRequest,
    resolution: readResolution(blockId, root), nowMs: Date.now(),
  });
  if (attention?.key === attentionKey) {
    if (attention.kind === 'unverified') {
      // No confirmed prompt to land a reply in: an answer typed into the session
      // could hit an empty prompt line or a different dialog (PHNX-3999).
      throw new AnswerError(
        `'${attentionKey}' could not be verified as a pending request — open the session and answer it there.`,
        'unverified',
      );
    }
    if (block) return { hit: { block, attention, session } };
    const reconstructed = blockFromAttention(attention, session);
    publishBlock(reconstructed, root);
    return { hit: { block: reconstructed, attention, session } };
  }
  // The winning caller advances the block to answered before a concurrent loser
  // resolves it. Reconstruct only this block's original generation so the loser
  // reaches the claim check and reports the real outcome, without routing again.
  if (block && getAnswerRecord(blockId, root)) {
    const original = reconcileAttention({
      block: { ...block, state: 'open', answer: undefined }, session: projected, nowMs: Date.now(),
    });
    if (original?.key === attentionKey) return { hit: { block, attention: original, session } };
  }
  return { observed: attention };
}

async function resolveTarget(
  key: ParsedAttentionKey,
  attentionKey: string,
  sessions: ActiveSession[],
  deadline: Deadline,
  root?: string,
): Promise<ResolvedTarget> {
  // The key names its session, so only that session can produce it. Narrowing
  // here is also what keeps an answer off an unrelated operator's pending item.
  const candidates = sessions.filter((session) => session.sessionId && session.sessionId === key.sessionId);
  if (candidates.length === 0) {
    throw new AnswerError(`No live session '${key.sessionId}' here to answer '${attentionKey}'.`, 'no_session');
  }

  let observed: AttentionItem | undefined;
  for (const session of candidates) {
    const outcome = matchSession(session, key, attentionKey, root, undefined);
    if (outcome.hit) return outcome.hit;
    observed ??= outcome.observed;
  }

  // Enrichment pass — only a review key can come from a PR read, and only the
  // named session is fetched, under whatever budget is left.
  if (isPullRequestGeneration(key.generation)) {
    for (const session of candidates) {
      const budget = Math.min(PR_ENRICHMENT_BUDGET_MS, remainingMs(deadline));
      if (budget <= 0) break;
      const pullRequest = await readPullRequestStatus({ ...session, host: key.host }, { timeoutMs: budget });
      if (!pullRequest) continue;
      const outcome = matchSession(session, key, attentionKey, root, pullRequest);
      if (outcome.hit) return outcome.hit;
      observed ??= outcome.observed;
    }
  }

  // The session is live but has moved on — a different generation, or none. That
  // is a STALE request, not a missing one: the operator answered yesterday's card.
  throw new AnswerError(
    observed
      ? `'${attentionKey}' is no longer the open request for '${key.sessionId}' — it is now '${observed.key}'.`
      : `'${attentionKey}' is no longer open — session '${key.sessionId}' has no pending request.`,
    'stale',
  );
}

// --- claim reconciliation ---------------------------------------------------

interface ClaimOutcome {
  /** The claim this call may deliver under, or undefined when another holder owns it. */
  claim?: AnswerRecord;
  /** True when the claim was inherited from a killed run rather than created here. */
  adopted: boolean;
  /** Set when the claim belongs to someone else — the truthful report for the loser. */
  lost?: FeedAnswerResult;
}

/**
 * Take over a claim a kill stranded, atomically.
 *
 * `rollbackAnswerClaim` compares `answeredAt` before releasing, so it IS the
 * compare-and-swap: exactly one racer can release this exact claim, and it
 * re-takes it immediately under `recordAnswer`'s `O_EXCL`. A racer that loses
 * either the release or the re-take finds a live marker and reports
 * `already_answered` instead of delivering a second copy.
 */
function adoptStrandedClaim(
  block: OpenBlock, stranded: AnswerRecord, operator: VerifiedOperator, verified: boolean, root?: string,
): AnswerRecord | undefined {
  let released: boolean;
  try {
    released = rollbackAnswerClaim(
      block.blockId, stranded.answeredAt, { ...block, state: 'open', answer: undefined }, undefined, root,
    );
  } catch {
    // The release is a read-compare-then-unlink, so a racing adopter that got
    // there first leaves this one unlinking a marker that is already gone. That
    // is losing the race, not an error — fall through and let the loser report.
    return undefined;
  }
  if (!released) return undefined;
  const retaken = recordAnswer(block.blockId, {
    answeredBy: operator.label, answeredFrom: 'feed', operatorId: operator.id, verified,
  }, root, { pending: true });
  if (!retaken.ok) return undefined;
  return getAnswerRecord(block.blockId, root);
}

/**
 * Wait briefly for the claim holder to record its receipt. Read-only — it polls
 * the block's own receipt list and never claims, routes or resends.
 */
async function awaitHolderReceipt(
  blockId: string, waitMs: number, origin: ReceiptOrigin, root?: string,
): Promise<MessageReceipt | undefined> {
  const until = Date.now() + waitMs;
  for (;;) {
    const receipt = latestMessageReceipt(blockId, root, origin);
    if (receipt || Date.now() >= until) return receipt;
    await new Promise((resolve) => { const t = setTimeout(resolve, HOLDER_RECEIPT_POLL_MS); t.unref?.(); });
  }
}

function heldClaimResult(
  block: OpenBlock, attentionKey: string, host: string, existing: AnswerRecord,
  receipt: MessageReceipt | undefined,
): FeedAnswerResult {
  const base = { attentionKey, blockId: block.blockId, host, attempt: existing.answeredAt };
  if (receipt) {
    const { delivery, resolved } = classifyReceipt(receipt);
    return {
      status: delivery === 'failed' ? 'failed' : 'already_answered',
      delivery, receipt, resolved,
      reason: `Answered by ${existing.answeredBy ?? existing.answeredFrom} at ${existing.answeredAt}; the rail reports '${receipt.status}'.`,
      ...(delivery === 'failed' ? { code: 'rail_failed' as const } : {}),
      ...base,
    };
  }
  return {
    status: 'unknown', delivery: 'unconfirmed', resolved: false,
    reason: `Claimed by ${existing.answeredBy ?? existing.answeredFrom} at ${existing.answeredAt}; no rail has reported a receipt. Check delivery rather than resending.`,
    ...base,
  };
}

/**
 * Take the claim, or reconcile the one already on disk against the block's real
 * receipts. A stranded claim is adopted only when `replayable` — the mailbox rail,
 * where the queued message's block id makes a second enqueue detectable. A
 * keystroke or resume rail may already have landed before the kill and cannot be
 * de-duplicated, so it stays unknown.
 */
async function claimOrReconcile(
  block: OpenBlock,
  attentionKey: string,
  host: string,
  operator: VerifiedOperator,
  verified: boolean,
  replayable: boolean,
  generation: string,
  nowMs: number,
  deadline: Deadline,
  root?: string,
): Promise<ClaimOutcome> {
  // PENDING: claimed, not resolved. The card stays in the operator's feed until
  // a rail reports a receipt, so a claim whose delivery never lands cannot make
  // the request silently disappear.
  const claim = recordAnswer(block.blockId, {
    answeredBy: operator.label, answeredFrom: 'feed', operatorId: operator.id, verified,
  }, root, { pending: true });
  if (claim.ok) {
    const created = getAnswerRecord(block.blockId, root);
    if (!created) throw new AnswerError(`Answer claim for '${attentionKey}' was not persisted.`, 'rail_failed');
    return { claim: created, adopted: false };
  }
  if ('unauthorized' in claim) throw new AnswerError(claim.reason, 'unauthorized');

  const existing = getAnswerRecord(block.blockId, root) ?? claim.existing;
  // Scope every receipt read to THIS ask and THIS attempt, so a leftover receipt
  // from an earlier question on the same session cannot answer for this one.
  const origin: ReceiptOrigin = { generation, attempt: existing.answeredAt };
  const claimedAtMs = Date.parse(existing.answeredAt);
  const stranded = Number.isFinite(claimedAtMs) && nowMs - claimedAtMs >= STRANDED_CLAIM_MS;

  // A fresh claim with no receipt is a delivery IN FLIGHT (the double-clicked
  // answer), so give the holder a moment to record it rather than reporting a
  // scary unknown for what is about to be a receipt.
  const receipt = stranded
    ? latestMessageReceipt(block.blockId, root, origin)
    : await awaitHolderReceipt(block.blockId, Math.max(0, Math.min(HOLDER_RECEIPT_WAIT_MS, remainingMs(deadline))), origin, root);
  if (receipt) return { adopted: false, lost: heldClaimResult(block, attentionKey, host, existing, receipt) };

  // No receipt and the claim predates any possible live delivery: a kill cut it
  // between the claim and the receipt.
  if (stranded && replayable) {
    const adopted = adoptStrandedClaim(block, existing, operator, verified, root);
    if (adopted) return { claim: adopted, adopted: true };
  }
  return { adopted: false, lost: heldClaimResult(block, attentionKey, host, existing, undefined) };
}

// --- delivery ---------------------------------------------------------------

interface DeliveryOutcome { receipt: MessageReceipt; reason?: string }

/** A multiline free-text answer needs a rail that inserts rather than submits per line. */
function isMultilineFreeText(route: AnswerRoute, answer: string): boolean {
  return (route.payload ?? '') === answer && answer.includes('\n');
}

async function deliverMailbox(
  block: OpenBlock, answer: string, operator: VerifiedOperator, adopted: boolean,
  origin: ReceiptOrigin, mailboxRoot?: string,
): Promise<DeliveryOutcome> {
  const dir = mailboxDir(block.mailboxId, mailboxRoot);
  // An adopted claim may already have enqueued before it was killed. The whole
  // spool is scanned — inbox, processing AND consumed (`readBox`, not `peek`) —
  // because a kill AFTER the agent drained the message would otherwise look
  // like nothing was ever sent and enqueue the answer a second time.
  //
  // The match is on the ASK and the ATTEMPT, not just the block id: a block id
  // is per SESSION, so an already-consumed message answering question N would
  // otherwise suppress a genuine delivery for question N+1.
  const existing = adopted
    ? readBox(dir).find((msg) => msg.blockId === block.blockId
      && msg.generation === origin.generation && msg.attempt === origin.attempt)
    : undefined;
  const msgId = existing?.msgId ?? enqueue(dir, {
    to: block.mailboxId, text: answer, from: operator.label, blockId: block.blockId,
    generation: origin.generation, attempt: origin.attempt,
  });
  return {
    receipt: { msgId, status: 'queued', at: new Date().toISOString(), from: operator.label, ...origin },
    ...(existing ? { reason: 'Re-used the message a stranded claim had already enqueued.' } : {}),
  };
}

/**
 * Re-enter a headless agent with the answer as its next user turn.
 *
 * Nothing here can prove non-delivery. A non-zero exit does NOT mean the prompt
 * never ran — the agent may have acted on it and then crashed — and a process
 * still running is not evidence the prompt was accepted either. Both are
 * therefore UNKNOWN, which keeps the claim and sends the operator to a delivery
 * check instead of a resend. Only a clean exit is booked, as `queued`: the
 * resume command completed, which is the rail taking the answer — not the agent
 * acknowledging it, which is what `consumed`/`continued` mean.
 */
async function deliverResume(
  route: AnswerRoute, block: OpenBlock, claimedAt: string, operator: VerifiedOperator,
  attentionKey: string, deadline: Deadline, origin: ReceiptOrigin,
): Promise<DeliveryOutcome> {
  const invocation = getAgentsInvocation(resumeArgv(route));
  const settleMs = Math.max(0, Math.min(RESUME_SETTLE_MS, remainingMs(deadline)));
  const child = spawn(invocation.command, invocation.args, {
    detached: true, stdio: ['ignore', 'ignore', 'pipe'], env: process.env,
  });
  let stderr = '';
  child.stderr?.setEncoding('utf-8');
  child.stderr?.on('data', (chunk) => { stderr += String(chunk); });
  const exit = await new Promise<number | undefined>((resolve) => {
    const timer = setTimeout(() => resolve(undefined), settleMs);
    timer.unref?.();
    child.once('error', () => { clearTimeout(timer); resolve(1); });
    child.once('close', (code) => { clearTimeout(timer); resolve(code ?? 1); });
  });
  // Detach either way — the agent's turn outlives the operator's deadline.
  child.stderr?.destroy();
  child.unref();
  if (exit !== undefined && exit !== 0) {
    throw new AnswerUnknownError(
      `Resume for '${attentionKey}' exited ${exit}${stderr.trim() ? `: ${stderr.trim()}` : ''} — it may have taken the answer before failing.`,
    );
  }
  if (exit === undefined) {
    throw new AnswerUnknownError(
      `Resume for '${attentionKey}' is still running after ${settleMs}ms; it has the answer but has not acknowledged it.`,
    );
  }
  return { receipt: { msgId: `resume-${block.blockId}-${claimedAt}`, status: 'queued', at: new Date().toISOString(), from: operator.label, ...origin } };
}

/**
 * Drive a keystroke rail.
 *
 * A failure here is UNKNOWN, not a confirmed failure: the tmux/iTerm path writes
 * the text and its Enter as two separate sends (terminal/inject.ts, the Ink-safe
 * split), so a reported error can mean the text already landed in the composer
 * and only the submit failed. Every check that can prove nothing was sent —
 * rail completeness, paste capability — runs BEFORE the claim instead.
 */
async function deliverInject(
  route: AnswerRoute, block: OpenBlock, answer: string, claimedAt: string, operator: VerifiedOperator,
  origin: ReceiptOrigin, deadline: Deadline,
): Promise<DeliveryOutcome> {
  // The rail gets the remaining budget, so it cancels its own process group and
  // never starts a write the deadline can no longer cover.
  const delivered = await injectIntoTerminal(route.inject as NonNullable<AnswerRoute['inject']>, route.payload as string, {
    enter: route.enter ?? true, combined: false, deadlineMs: Math.max(0, remainingMs(deadline)),
    ...(isMultilineFreeText(route, answer) ? { paste: true } : {}),
  });
  if (!delivered.ok) {
    // `writes === 0` means no write was even issued, so nothing landed and the
    // item is cleanly retryable. Anything past the first write is ambiguous: the
    // text may sit in the composer with only its submit missing.
    if (delivered.writes === 0) {
      throw new AnswerError(
        `${delivered.error ?? `Failed to deliver over ${route.kind}`} — no keystroke was sent.`,
        'rail_failed',
      );
    }
    throw new AnswerUnknownError(
      `${delivered.error ?? `Failed to deliver over ${route.kind}`} — ${delivered.writes} of the keystroke sequence already landed; open the session before resending.`,
    );
  }
  if (!delivered.confirmed) {
    throw new AnswerUnknownError(
      `${delivered.backend} accepted the hand-off but cannot confirm the agent received it.`,
    );
  }
  return { receipt: { msgId: `inject-${block.blockId}-${claimedAt}`, status: 'queued', at: new Date().toISOString(), from: operator.label, ...origin } };
}

/**
 * Everything provable BEFORE a claim is taken. Each of these means nothing was
 * sent, so raising here keeps the item cleanly retryable instead of parking it
 * in an unknown state.
 */
function preflightRoute(route: AnswerRoute, answer: string, attentionKey: string): void {
  if (route.kind === 'refuse') throw new AnswerError(route.reason, 'refused');
  if (route.kind === 'mailbox' || route.kind === 'resume') return;
  if (!route.inject || route.payload == null) throw new AnswerError(`Incomplete ${route.kind} reply rail.`, 'refused');
  if (isMultilineFreeText(route, answer) && !backendCarriesPaste(route.inject.backend)) {
    throw new AnswerError(
      `A multiline answer cannot be typed into the ${route.inject.backend} rail for '${attentionKey}' — only tmux carries bracketed paste. Open the session and paste it there.`,
      'refused',
    );
  }
}

// --- entry points -----------------------------------------------------------

/**
 * Read-only reconciliation of an attention item's delivery state — what powers
 * "Check delivery" on an unconfirmed answer. It NEVER claims, routes, adopts or
 * resends; it reports the stored claim and the block's real receipt so an
 * operator can tell "still unconfirmed" from "the agent has it".
 */
export function checkAnswerDelivery(
  attentionKey: string, feedRoot?: string, expectedAttempt?: string,
): FeedAnswerResult {
  const key = parseAttentionKey(attentionKey);
  const blockId = blockIdForSession(key.sessionId);
  const base = { attentionKey, blockId, host: key.host };
  const claim = getAnswerRecord(blockId, feedRoot);
  // Scoped to the requested ask AND the attempt being checked, so a receipt left
  // by a different question or a superseded attempt is never read as this one's.
  const receipt = claim
    ? latestMessageReceipt(blockId, feedRoot, {
      generation: key.generation, attempt: expectedAttempt ?? claim.answeredAt,
    })
    : undefined;

  // A block id is per SESSION, so its claim and receipts belong to whatever
  // generation the session is on NOW. Checking an older card against them would
  // report the NEXT question's receipt as this question's answer, which is the
  // one way a read-only check can still lie.
  const block = readBlock(blockId, feedRoot);
  const resolution = readResolution(blockId, feedRoot);
  const liveGeneration = block ? blockGeneration(block) : resolution?.generation;
  if (liveGeneration !== undefined && liveGeneration !== key.generation) {
    return {
      status: 'unknown', delivery: 'unconfirmed', resolved: false,
      reason: `'${attentionKey}' is not the generation this session is on ('${liveGeneration}'), so its claim and receipts describe a different request.`,
      ...base,
    };
  }
  // An attempt the caller did not ask about is a DIFFERENT delivery — say so
  // rather than answering about someone else's.
  if (expectedAttempt !== undefined && claim && claim.answeredAt !== expectedAttempt) {
    return {
      status: 'unknown', delivery: 'unconfirmed', resolved: false,
      reason: `Attempt '${expectedAttempt}' was replaced by one at ${claim.answeredAt}.`,
      ...base, attempt: claim.answeredAt,
    };
  }

  if (receipt) {
    const { delivery, resolved } = classifyReceipt(receipt);
    return {
      status: delivery === 'failed' ? 'failed' : 'already_answered',
      delivery, receipt, resolved,
      reason: `The rail reports '${receipt.status}' for ${receipt.msgId}.`,
      ...(delivery === 'failed' ? { code: 'rail_failed' as const } : {}),
      ...base, ...(claim ? { attempt: claim.answeredAt } : {}),
    };
  }
  if (claim) {
    return {
      status: 'unknown', delivery: 'unconfirmed', resolved: false,
      reason: `Claimed by ${claim.answeredBy ?? claim.answeredFrom} at ${claim.answeredAt}; no rail has reported a receipt.`,
      ...base, attempt: claim.answeredAt,
    };
  }
  // No claim at all is the one state that IS a confirmed non-delivery: nothing
  // ever took the item, so the operator can safely answer it again.
  return {
    status: 'failed', delivery: 'failed', resolved: false, code: 'rail_failed',
    reason: `No answer has been claimed for '${attentionKey}'.`,
    ...base,
  };
}

/** Atomically claim the first answer, then route it over the session's recorded reply rail. */
export async function claimAndRouteAttentionAnswer(input: {
  attentionKey: string;
  choiceId?: string;
  text?: string;
  operator: VerifiedOperator;
  feedRoot?: string;
  mailboxRoot?: string;
  sessions?: ActiveSession[];
  deadlineMs?: number;
}): Promise<FeedAnswerResult> {
  if ((input.choiceId == null) === (input.text == null)) {
    throw new AnswerError('Exactly one of choiceId or text is required.', 'empty_answer');
  }
  const deadline = startDeadline(input.deadlineMs ?? ANSWER_DEADLINE_MS);
  const key = parseAttentionKey(input.attentionKey);
  const sessions = input.sessions ?? await withinDeadline(getActiveSessions(), deadline, 'Reading live sessions');
  const { block, attention, session } = await resolveTarget(key, input.attentionKey, sessions, deadline, input.feedRoot);

  const choice = input.choiceId == null ? undefined : attention.choices?.find((item) => item.id === input.choiceId);
  if (input.choiceId != null && !choice) {
    throw new AnswerError(`Unknown choice '${input.choiceId}' for '${input.attentionKey}'.`, 'unknown_choice');
  }
  const answer = input.text ?? choice?.deliveryKey ?? choice?.label;
  if (!answer) throw new AnswerError('Answer is empty.', 'empty_answer');

  // The route is pure, so it is resolved BEFORE the claim: a refusal or an
  // incapable rail then fails with nothing claimed and nothing delivered.
  const route = resolveAnswerRoute({ mailboxId: block.mailboxId, answer, block, session });
  preflightRoute(route, answer, input.attentionKey);

  const verified = input.operator.verified && verifyOperatorIdentity(input.operator.id);
  const previousResolution = readResolution(block.blockId, input.feedRoot);
  const outcome = await claimOrReconcile(
    block, input.attentionKey, key.host, input.operator, verified,
    route.kind === 'mailbox', key.generation, Date.now(), deadline, input.feedRoot,
  );
  if (outcome.lost) return outcome.lost;
  const claim = outcome.claim as AnswerRecord;
  // Every receipt this delivery writes names the ask and the attempt it belongs
  // to, so a late acknowledgement can never be read against a different question.
  const origin: ReceiptOrigin = { generation: key.generation, attempt: claim.answeredAt };
  const base = { attentionKey: input.attentionKey, blockId: block.blockId, host: key.host, attempt: claim.answeredAt };

  // An adopted claim was created by the killed run, so releasing it means
  // restoring the pre-claim OPEN state, not the tombstone that claim wrote.
  const restoreBlock: OpenBlock = outcome.adopted ? { ...block, state: 'open', answer: undefined } : block;
  const restoreResolution: AttentionResolution | undefined = outcome.adopted ? undefined : previousResolution;

  let delivered: DeliveryOutcome;
  try {
    delivered = await withinDeadline(
      route.kind === 'mailbox'
        ? deliverMailbox(block, answer, input.operator, outcome.adopted, origin, input.mailboxRoot)
        : route.kind === 'resume'
          ? deliverResume(route, block, claim.answeredAt, input.operator, input.attentionKey, deadline, origin)
          : deliverInject(route, block, answer, claim.answeredAt, input.operator, origin, deadline),
      deadline,
      `Delivering '${input.attentionKey}' over ${route.kind}`,
    );
  } catch (error) {
    // Only a CONFIRMED failure releases the claim. Past this point the code is
    // inside a rail that may already have written bytes, so anything unexpected
    // is UNKNOWN too — keeping the claim is what stops a retry double-sending
    // behind a delivery that may have landed.
    if (error instanceof AnswerError) {
      rollbackAnswerClaim(block.blockId, claim.answeredAt, restoreBlock, restoreResolution, input.feedRoot);
      throw error;
    }
    const reason = error instanceof Error ? error.message : String(error);
    return { status: 'unknown', delivery: 'unconfirmed', resolved: false, reason, ...base };
  }
  const { delivery, resolved } = classifyReceipt(delivered.receipt);
  try {
    recordMessageReceipt(block.blockId, delivered.receipt, input.feedRoot);
    // Only the AGENT's own acknowledgement resolves the item. A `queued` receipt
    // says a rail took the answer and nothing more, so the card stays up until
    // the mailbox drain records `consumed` (which promotes it through
    // `recordMessageReceipt`) or the transcript moves past the block. The
    // generation + attempt binding stops a slow delivery from resolving the ask
    // the agent has since moved on to.
    if (resolved) {
      confirmAnswerResolution(block.blockId, input.feedRoot, {
        generation: key.generation, answeredAt: claim.answeredAt,
      });
    }
  } catch (error) {
    // The answer IS on the rail; only the bookkeeping failed. Reporting a
    // failure here would invite a resend of something already delivered.
    return {
      status: 'unknown', delivery: 'unconfirmed', resolved: false,
      reason: `Delivered over ${route.kind}, but the receipt could not be recorded: ${error instanceof Error ? error.message : String(error)}.`,
      ...base,
    };
  }
  return {
    status: 'delivered', delivery, receipt: delivered.receipt, resolved,
    ...(delivered.reason ? { reason: delivered.reason } : {}),
    ...base,
  };
}

/**
 * The remote `agents feed answer` argv for a forwarded answer. Exported so the
 * exact tokens that cross the hop are asserted directly.
 */
export function remoteAnswerArgv(input: {
  attentionKey: string; choiceId?: string; text?: string; operatorId?: string;
  check?: boolean; attempt?: string;
}): string[] {
  const argv = ['agents', 'feed', 'answer', input.attentionKey, '--json'];
  if (input.check) argv.push('--check');
  if (input.attempt != null) argv.push('--attempt', input.attempt);
  if (input.choiceId != null) argv.push('--choice', input.choiceId);
  if (input.text != null) argv.push('--text', input.text);
  if (input.operatorId) argv.push('--as', input.operatorId);
  return argv;
}

/**
 * Forward a fleet attention answer to the device that owns its scope.
 *
 * Every token is POSIX-quoted with the canonical {@link shellQuote} before the
 * remote login shell parses it, so a multiline answer or one carrying `$`, `"`,
 * `` ` ``, `;` or a newline arrives byte-identical. The transport is the
 * canonical bounded {@link sshExecAsync} — it disables ControlMaster whenever a
 * timeout is set, so the bound actually tears the remote command down instead of
 * orphaning it behind a control socket.
 *
 * A timeout is reported UNKNOWN: the remote may well have delivered before the
 * link was cut, so the operator is offered a delivery check, never an implicit
 * resend. The returned receipt is verified to be about the key that was asked
 * for, so a mismatched or truncated remote reply cannot be trusted as one.
 */
export async function forwardFeedAnswer(input: {
  host: string;
  attentionKey: string;
  choiceId?: string;
  text?: string;
  operatorId?: string;
  check?: boolean;
  attempt?: string;
  timeoutMs?: number;
}): Promise<FeedAnswerResult> {
  const timeoutMs = input.timeoutMs ?? REMOTE_ANSWER_TIMEOUT_MS;
  // The sentinel is echoed BEFORE the answer command runs, so its absence is
  // positive proof the remote never began executing. Without it an ssh exit 255
  // is ambiguous: it is equally "could not connect" and "connection dropped
  // after the answer was already delivered".
  const remoteCmd = `echo ${REMOTE_START_SENTINEL}; ${remoteAnswerArgv(input).map(shellQuote).join(' ')}`;
  const unknown = (reason: string): FeedAnswerResult => ({
    status: 'unknown', delivery: 'unconfirmed', resolved: false,
    reason: `${reason} Check delivery rather than resending.`,
    attentionKey: input.attentionKey, host: input.host,
  });

  // The caller enforces the bound, not the transport. `sshExecAsync` resolves on
  // the child's `close`, which a remote peer still holding the pipe can delay
  // past the kill it already issued — so the operator's verdict is raced against
  // the deadline directly and returns on time regardless.
  const settled = await Promise.race([
    sshExecAsync(input.host, remoteCmd, { timeoutMs }).then((value) => ({ value })),
    new Promise<{ value?: undefined }>((resolve) => {
      const timer = setTimeout(() => resolve({}), timeoutMs + SSH_TIMEOUT_KILL_GRACE_MS + 500);
      timer.unref?.();
    }),
  ]);
  const result = settled.value;
  if (!result || result.timedOut) {
    return unknown(`Answering on '${input.host}' did not finish in ${timeoutMs}ms — it may already have been delivered.`);
  }

  // A confirmed non-delivery needs POSITIVE proof that nothing ran, not merely
  // an ssh failure code: a link dropped AFTER the remote executed also exits
  // 255. The sentinel is that proof — ssh failed AND the remote never reached
  // the echo, so the answer command never started and a retry is safe.
  const started = result.stdout.includes(REMOTE_START_SENTINEL);
  if (result.code === SSH_CONN_FAILURE_CODE && !started) {
    throw new AnswerError(
      result.stderr.trim() || `Could not reach '${input.host}' to answer '${input.attentionKey}'.`,
      'remote_failed',
    );
  }
  if (result.code === SSH_CONN_FAILURE_CODE) {
    return unknown(`The link to '${input.host}' dropped after the answer command had already started (exit 255).`);
  }

  // Everything past a live connection is ambiguous on failure: the remote may
  // have delivered and then crashed, or had its stdout truncated. Absent an
  // affirmative non-delivery, that is unknown — never a retry-safe failure.
  const line = result.stdout.trim().split('\n').reverse().find((value: string) => value.startsWith('{'));
  if (!line) {
    return unknown(`Remote answer on '${input.host}' returned no JSON receipt (exit ${result.code}${result.stderr.trim() ? `: ${result.stderr.trim()}` : ''}).`);
  }
  let parsed: FeedAnswerResult;
  try {
    parsed = JSON.parse(line) as FeedAnswerResult;
  } catch {
    return unknown(`Remote answer on '${input.host}' returned unreadable JSON.`);
  }
  const shapeProblem = remoteResultProblem(parsed, input.attentionKey, input.attempt);
  if (shapeProblem) return unknown(`Remote answer on '${input.host}' ${shapeProblem}.`);
  return { ...parsed, host: input.host };
}

const ANSWER_STATUSES: readonly AnswerStatus[] = ['delivered', 'already_answered', 'unknown', 'failed'];
const ANSWER_DELIVERIES: readonly AnswerDelivery[] = ['receipt', 'unconfirmed', 'failed'];
const RECEIPT_STATUSES: readonly MessageReceipt['status'][] = ['queued', 'consumed', 'continued', 'dropped', 'expired'];
/**
 * Echoed by the remote BEFORE the answer command runs. Its absence alongside an
 * ssh failure is the only positive proof that nothing executed on the far side.
 */
const REMOTE_START_SENTINEL = '__agents_answer_started__';

/**
 * Validate a forwarded result as a whole, not just its key: an off-key, truncated
 * or shape-invalid reply is not evidence about THIS request, and a caller that
 * trusted one would report another item's outcome as this one's.
 */
function remoteResultProblem(
  parsed: FeedAnswerResult, attentionKey: string, requestedAttempt?: string,
): string | undefined {
  if (parsed?.attentionKey !== attentionKey) {
    return `reported '${parsed?.attentionKey ?? 'no key'}', not '${attentionKey}'`;
  }
  if (!ANSWER_STATUSES.includes(parsed.status)) return `reported an unknown status '${parsed.status}'`;
  if (!ANSWER_DELIVERIES.includes(parsed.delivery)) return `reported an unknown delivery '${parsed.delivery}'`;
  if (typeof parsed.resolved !== 'boolean') return 'omitted the resolved flag';
  if (parsed.blockId !== undefined && parsed.blockId !== blockIdForSession(parseAttentionKey(attentionKey).sessionId)) {
    return `reported block '${parsed.blockId}', which is not this key's block`;
  }
  // An answer about a DIFFERENT attempt than the one asked about is not evidence
  // for this one, even though the key matches.
  if (requestedAttempt !== undefined && parsed.attempt !== undefined && parsed.attempt !== requestedAttempt) {
    return `reported attempt '${parsed.attempt}', not the requested '${requestedAttempt}'`;
  }
  if (parsed.delivery === 'receipt') {
    if (!parsed.receipt?.msgId) return 'claimed a receipt without one';
    if (!RECEIPT_STATUSES.includes(parsed.receipt.status)) {
      return `reported an unknown receipt status '${parsed.receipt.status}'`;
    }
    // `resolved` means the agent itself acknowledged — only consumed/continued
    // can support it. A `queued` receipt claiming resolution is inconsistent.
    const acknowledged = parsed.receipt.status === 'consumed' || parsed.receipt.status === 'continued';
    if (parsed.resolved !== acknowledged) {
      return `reported resolved=${parsed.resolved} for a '${parsed.receipt.status}' receipt`;
    }
  } else if (parsed.resolved) {
    return `reported resolved=true with delivery '${parsed.delivery}'`;
  }
  return undefined;
}
