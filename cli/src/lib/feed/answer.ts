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

export const ANSWER_DEADLINE_MS = 20_000;
export const PR_ENRICHMENT_BUDGET_MS = 4_000;
export const REMOTE_ANSWER_TIMEOUT_MS = 25_000;
export const STRANDED_CLAIM_MS = 60_000;
export const RESUME_SETTLE_MS = 2_000;
export const HOLDER_RECEIPT_WAIT_MS = 400;
const HOLDER_RECEIPT_POLL_MS = 20;

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

export class AnswerError extends Error {
  constructor(message: string, readonly code: AnswerFailureCode) {
    super(message);
    this.name = 'AnswerError';
  }
}

export class AnswerUnknownError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AnswerUnknownError';
  }
}

export type AnswerStatus = 'delivered' | 'already_answered' | 'unknown' | 'failed';

export type AnswerDelivery = 'receipt' | 'unconfirmed' | 'failed';

export interface FeedAnswerResult {
  status: AnswerStatus;
  delivery: AnswerDelivery;
  receipt?: MessageReceipt;
  resolved: boolean;
  reason?: string;
  code?: AnswerFailureCode;
  attentionKey: string;
  blockId?: string;
  host?: string;
  attempt?: string;
}

interface VerifiedOperator { id?: string; verified: boolean; label?: string }


export interface ParsedAttentionKey { host: string; sessionId: string; generation: string }

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

export function answerOwnerIsLocal(host: string, self: string = machineId()): boolean {
  return normalizeHost(host) === normalizeHost(self);
}

function isPullRequestGeneration(generation: string): boolean {
  return /^pr\d+:/.test(generation);
}


export function classifyReceipt(receipt: MessageReceipt): { delivery: AnswerDelivery; resolved: boolean } {

  if (receipt.status === 'consumed' || receipt.status === 'continued') return { delivery: 'receipt', resolved: true };
  if (receipt.status === 'queued') return { delivery: 'receipt', resolved: false };
  return { delivery: 'failed', resolved: false };
}


interface Deadline { endMs: number }
function startDeadline(totalMs: number): Deadline { return { endMs: Date.now() + totalMs }; }
function remainingMs(deadline: Deadline): number { return deadline.endMs - Date.now(); }

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


function blockFromAttention(attention: AttentionItem, session: ActiveSession): OpenBlock {
  return {
    blockId: blockIdForSession(attention.sessionId), sessionId: attention.sessionId,
    mailboxId: attention.mailboxId, host: attention.host, runtime: session.kind,
    generation: attention.key.slice(attention.key.lastIndexOf('/') + 1), source: attention.source,
    state: 'open', sourceCursor: attention.sourceCursor, project: attention.project,
    ts: attention.openedAt, questions: [attention.question ?? { text: 'Continue from this attention item.' }],
    kind: attention.kind === 'permission' ? 'notification' : attention.kind === 'declared' ? 'declared' : attention.source === 'system' ? 'control' : 'question',
    ...(attention.kind === 'permission' ? { notificationType: 'permission_prompt' } : {}),
    safeDefault: attention.safeDefault,
  };
}

interface ResolvedTarget { block: OpenBlock; attention: AttentionItem; session: ActiveSession }
interface MatchOutcome { hit?: ResolvedTarget; observed?: AttentionItem }

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

  throw new AnswerError(
    observed
      ? `'${attentionKey}' is no longer the open request for '${key.sessionId}' — it is now '${observed.key}'.`
      : `'${attentionKey}' is no longer open — session '${key.sessionId}' has no pending request.`,
    'stale',
  );
}


interface ClaimOutcome {
  claim?: AnswerRecord;
  adopted: boolean;
  lost?: FeedAnswerResult;
}

function adoptStrandedClaim(
  block: OpenBlock, stranded: AnswerRecord, operator: VerifiedOperator, verified: boolean, root?: string,
): AnswerRecord | undefined {

  let released: boolean;
  try {
    released = rollbackAnswerClaim(
      block.blockId, stranded.answeredAt, { ...block, state: 'open', answer: undefined }, undefined, root,
    );
  } catch {
    return undefined;
  }
  if (!released) return undefined;
  const retaken = recordAnswer(block.blockId, {
    answeredBy: operator.label, answeredFrom: 'feed', operatorId: operator.id, verified,
  }, root, { pending: true });
  if (!retaken.ok) return undefined;
  return getAnswerRecord(block.blockId, root);
}

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
  const origin: ReceiptOrigin = { generation, attempt: existing.answeredAt };
  const claimedAtMs = Date.parse(existing.answeredAt);
  const stranded = Number.isFinite(claimedAtMs) && nowMs - claimedAtMs >= STRANDED_CLAIM_MS;

  const receipt = stranded
    ? latestMessageReceipt(block.blockId, root, origin)
    : await awaitHolderReceipt(block.blockId, Math.max(0, Math.min(HOLDER_RECEIPT_WAIT_MS, remainingMs(deadline))), origin, root);
  if (receipt) return { adopted: false, lost: heldClaimResult(block, attentionKey, host, existing, receipt) };

  if (stranded && replayable) {
    const adopted = adoptStrandedClaim(block, existing, operator, verified, root);
    if (adopted) return { claim: adopted, adopted: true };
  }
  return { adopted: false, lost: heldClaimResult(block, attentionKey, host, existing, undefined) };
}


interface DeliveryOutcome { receipt: MessageReceipt; reason?: string }

function isMultilineFreeText(route: AnswerRoute, answer: string): boolean {
  return (route.payload ?? '') === answer && answer.includes('\n');
}

async function deliverMailbox(
  block: OpenBlock, answer: string, operator: VerifiedOperator, adopted: boolean,
  origin: ReceiptOrigin, mailboxRoot?: string,
): Promise<DeliveryOutcome> {
  const dir = mailboxDir(block.mailboxId, mailboxRoot);
  const existing = adopted
    ? readBox(dir).find((msg) => msg.blockId === block.blockId && msg.generation === origin.generation)
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

async function deliverInject(
  route: AnswerRoute, block: OpenBlock, answer: string, claimedAt: string, operator: VerifiedOperator,
  origin: ReceiptOrigin, deadline: Deadline,
): Promise<DeliveryOutcome> {
  const delivered = await injectIntoTerminal(route.inject as NonNullable<AnswerRoute['inject']>, route.payload as string, {
    enter: route.enter ?? true, combined: false, deadlineMs: Math.max(0, remainingMs(deadline)),
    ...(isMultilineFreeText(route, answer) ? { paste: true } : {}),
  });
  if (!delivered.ok) {
    if (delivered.started === 0) {
      throw new AnswerError(
        `${delivered.error ?? `Failed to deliver over ${route.kind}`} — no keystroke was sent.`,
        'rail_failed',
      );
    }
    throw new AnswerUnknownError(
      `${delivered.error ?? `Failed to deliver over ${route.kind}`} — ${delivered.started} of ${delivered.specs?.length ?? '?'} keystroke write(s) had already begun; open the session before resending.`,
    );
  }
  if (!delivered.confirmed) {
    throw new AnswerUnknownError(
      `${delivered.backend} accepted the hand-off but cannot confirm the agent received it.`,
    );
  }
  return { receipt: { msgId: `inject-${block.blockId}-${claimedAt}`, status: 'queued', at: new Date().toISOString(), from: operator.label, ...origin } };
}

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


export function checkAnswerDelivery(
  attentionKey: string, feedRoot?: string, expectedAttempt?: string,
): FeedAnswerResult {
  const key = parseAttentionKey(attentionKey);
  const blockId = blockIdForSession(key.sessionId);
  const base = { attentionKey, blockId, host: key.host };
  const claim = getAnswerRecord(blockId, feedRoot);
  const receipt = claim
    ? latestMessageReceipt(blockId, feedRoot, {
      generation: key.generation, attempt: expectedAttempt ?? claim.answeredAt,
    })
    : undefined;

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
  return {
    status: 'failed', delivery: 'failed', resolved: false, code: 'rail_failed',
    reason: `No answer has been claimed for '${attentionKey}'.`,
    ...base,
  };
}

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
  const origin: ReceiptOrigin = { generation: key.generation, attempt: claim.answeredAt };
  const base = { attentionKey: input.attentionKey, blockId: block.blockId, host: key.host, attempt: claim.answeredAt };

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
    if (resolved) {
      confirmAnswerResolution(block.blockId, input.feedRoot, {
        generation: key.generation, answeredAt: claim.answeredAt,
      });
    }
  } catch (error) {
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
  const remoteCmd = remoteAnswerArgv(input).map(shellQuote).join(' ');
  const unknown = (reason: string): FeedAnswerResult => ({
    status: 'unknown', delivery: 'unconfirmed', resolved: false,
    reason: `${reason} Check delivery rather than resending.`,
    attentionKey: input.attentionKey, host: input.host,
  });

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

  if (result.code === SSH_CONN_FAILURE_CODE) {
    return unknown(`ssh to '${input.host}' failed (exit 255)${result.stderr.trim() ? `: ${result.stderr.trim()}` : ''}; whether the answer ran there is unknown.`);
  }
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
  if (requestedAttempt !== undefined && parsed.attempt !== undefined && parsed.attempt !== requestedAttempt) {
    return `reported attempt '${parsed.attempt}', not the requested '${requestedAttempt}'`;
  }
  if (parsed.delivery === 'receipt') {
    if (!parsed.receipt?.msgId) return 'claimed a receipt without one';
    if (!RECEIPT_STATUSES.includes(parsed.receipt.status)) {
      return `reported an unknown receipt status '${parsed.receipt.status}'`;
    }
    if (parsed.receipt.status === 'dropped' || parsed.receipt.status === 'expired') {
      return `reported delivery 'receipt' for a '${parsed.receipt.status}' message`;
    }
    const generation = parseAttentionKey(attentionKey).generation;
    if (parsed.receipt.generation !== undefined && parsed.receipt.generation !== generation) {
      return `returned a receipt for ask '${parsed.receipt.generation}', not '${generation}'`;
    }
    if (parsed.attempt !== undefined && parsed.receipt.attempt !== undefined
      && parsed.receipt.attempt !== parsed.attempt) {
      return `returned a receipt for attempt '${parsed.receipt.attempt}', not its own '${parsed.attempt}'`;
    }
    const acknowledged = parsed.receipt.status === 'consumed' || parsed.receipt.status === 'continued';
    if (parsed.resolved !== acknowledged) {
      return `reported resolved=${parsed.resolved} for a '${parsed.receipt.status}' receipt`;
    }
  } else if (parsed.resolved) {
    return `reported resolved=true with delivery '${parsed.delivery}'`;
  }
  return undefined;
}
