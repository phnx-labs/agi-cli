import { spawn } from 'node:child_process';
import { getActiveSessions, type ActiveSession } from '../session/active.js';
import { resolveAnswerRoute, resumeArgv } from '../answer-router.js';
import { enqueue, mailboxDir } from '../mailbox.js';
import { injectIntoTerminal } from '../terminal/index.js';
import { verifyOperatorIdentity } from '../operator.js';
import {
  blockIdForSession,
  getAnswerRecord,
  publishBlock,
  readBlock,
  readResolution,
  recordAnswer,
  recordMessageReceipt,
  rollbackAnswerClaim,
  type MessageReceipt,
  type OpenBlock,
} from './feed.js';
import { reconcileAttention, type AttentionItem } from './attention.js';
import { readPullRequestStatus } from './pr-status.js';
import { getAgentsInvocation } from '../daemon/daemon.js';

export interface VerifiedOperator { id?: string; verified: boolean; label?: string }
export interface FeedAnswerResult { status: 'delivered' | 'already_answered'; receipt: MessageReceipt }

function sessionForBlock(block: OpenBlock, sessions: ActiveSession[]): ActiveSession | undefined {
  return sessions.find((session) => session.sessionId === block.sessionId || session.agentId === block.mailboxId);
}

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

async function resolveBlock(attentionKey: string, sessions: ActiveSession[], root?: string): Promise<{ block: OpenBlock; attention: AttentionItem }> {
  const ownerHost = attentionKey.slice(0, attentionKey.indexOf('/'));
  for (const session of sessions) {
    if (!session.sessionId) continue;
    let block = readBlock(blockIdForSession(session.sessionId), root);
    const projectedSession = { ...session, host: ownerHost };
    const attention = reconcileAttention({ block, session: projectedSession, pullRequest: await readPullRequestStatus(session), resolution: readResolution(blockIdForSession(session.sessionId), root), nowMs: Date.now() });
    if (attention?.key === attentionKey && attention.kind === 'unverified') {
      // No confirmed prompt to land a reply in: an answer typed into the session
      // could hit an empty prompt line or a different dialog (PHNX-3999).
      throw new Error(`'${attentionKey}' could not be verified as a pending request — open the session and answer it there.`);
    }
    if (attention?.key === attentionKey && block) return { block, attention };
    // The winning caller advances the block to answered before a concurrent
    // loser resolves it. Reconstruct only this block's original generation so
    // the loser can return already_answered without routing a second reply.
    if (block) {
      const original = reconcileAttention({ block: { ...block, state: 'open', answer: undefined }, session: projectedSession, nowMs: Date.now() });
      if (original?.key === attentionKey && getAnswerRecord(block.blockId, root)) return { block, attention: original };
    }
    if (attention?.key === attentionKey) {
      block = blockFromAttention(attention, session);
      publishBlock(block, root);
      return { block, attention };
    }
  }
  throw new Error(`No open attention item matches '${attentionKey}'.`);
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
}): Promise<FeedAnswerResult> {
  if ((input.choiceId == null) === (input.text == null)) throw new Error('Exactly one of choiceId or text is required.');
  const sessions = input.sessions ?? await getActiveSessions();
  const { block, attention } = await resolveBlock(input.attentionKey, sessions, input.feedRoot);
  const choice = input.choiceId == null ? undefined : attention.choices?.find((item) => item.id === input.choiceId);
  if (input.choiceId != null && !choice) throw new Error(`Unknown choice '${input.choiceId}' for '${input.attentionKey}'.`);
  const answer = input.text ?? choice?.deliveryKey ?? choice?.label;
  if (!answer) throw new Error('Answer is empty.');
  const verified = input.operator.verified && verifyOperatorIdentity(input.operator.id);
  const previousResolution = readResolution(block.blockId, input.feedRoot);
  const claim = recordAnswer(block.blockId, {
    answeredBy: input.operator.label,
    answeredFrom: 'feed',
    operatorId: input.operator.id,
    verified,
  }, input.feedRoot);
  if (!claim.ok) {
    if ('unauthorized' in claim) throw new Error(claim.reason);
    const existing = getAnswerRecord(block.blockId, input.feedRoot) ?? claim.existing;
    return { status: 'already_answered', receipt: {
      msgId: `answer-${block.blockId}`,
      status: 'queued',
      at: existing.answeredAt,
      from: existing.answeredBy ?? existing.answeredFrom,
    } };
  }

  const claimed = getAnswerRecord(block.blockId, input.feedRoot);
  if (!claimed) throw new Error(`Answer claim for '${input.attentionKey}' was not persisted.`);

  const session = sessionForBlock(block, sessions);
  const route = resolveAnswerRoute({ mailboxId: block.mailboxId, answer, block, session });
  if (route.kind === 'refuse') {
    rollbackAnswerClaim(block.blockId, claimed.answeredAt, block, previousResolution, input.feedRoot);
    throw new Error(route.reason);
  }
  let msgId: string;
  try {
    if (route.kind === 'mailbox') {
      msgId = enqueue(mailboxDir(block.mailboxId, input.mailboxRoot), {
        to: block.mailboxId, text: answer, from: input.operator.label, blockId: block.blockId,
      });
    } else if (route.kind === 'resume') {
      const invocation = getAgentsInvocation(resumeArgv(route));
      const child = spawn(invocation.command, invocation.args, { stdio: 'inherit', env: process.env });
      const code = await new Promise<number>((resolve) => { child.once('error', () => resolve(1)); child.once('close', (value) => resolve(value ?? 1)); });
      if (code !== 0) throw new Error(`Resume delivery for '${input.attentionKey}' exited ${code}.`);
      msgId = `resume-${Date.now()}`;
    } else {
      if (!route.inject || route.payload == null) throw new Error(`Incomplete ${route.kind} reply rail.`);
      const delivered = await injectIntoTerminal(route.inject, route.payload, { enter: route.enter ?? true, combined: false });
      if (!delivered.ok) throw new Error(delivered.error ?? `Failed to deliver over ${route.kind}.`);
      msgId = `inject-${Date.now()}`;
    }
  } catch (error) {
    rollbackAnswerClaim(block.blockId, claimed.answeredAt, block, previousResolution, input.feedRoot);
    throw error;
  }
  const receipt: MessageReceipt = { msgId, status: 'queued', at: new Date().toISOString(), from: input.operator.label };
  recordMessageReceipt(block.blockId, receipt, input.feedRoot);
  return { status: 'delivered', receipt };
}

/** Forward a fleet attention answer to the device that owns its scope. */
export async function forwardFeedAnswer(input: { host: string; attentionKey: string; choiceId?: string; text?: string; operatorId?: string }): Promise<FeedAnswerResult> {
  const remoteArgs = ['feed', 'answer', input.attentionKey, '--json'];
  if (input.choiceId != null) remoteArgs.push('--choice', input.choiceId);
  if (input.text != null) remoteArgs.push('--text', input.text);
  if (input.operatorId) remoteArgs.push('--as', input.operatorId);
  const invocation = getAgentsInvocation(['ssh', input.host, 'agents', ...remoteArgs]);
  const child = spawn(invocation.command, invocation.args, { stdio: ['ignore', 'pipe', 'pipe'], env: process.env });
  let stdout = ''; let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += String(chunk); });
  child.stderr.on('data', (chunk) => { stderr += String(chunk); });
  const code = await new Promise<number>((resolve) => { child.once('error', () => resolve(1)); child.once('close', (value) => resolve(value ?? 1)); });
  if (code !== 0) throw new Error(stderr.trim() || `Remote feed answer on '${input.host}' exited ${code}.`);
  const line = stdout.trim().split('\n').reverse().find((value: string) => value.startsWith('{'));
  if (!line) throw new Error(`Remote feed answer on '${input.host}' returned no JSON receipt.`);
  return JSON.parse(line) as FeedAnswerResult;
}
