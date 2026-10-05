/** Feed store: blocks published by agents waiting on user input (outbound twin of the mailbox),
 * one `<feedDir>/<blockId>.json` per session; a new question replaces the old. First answer from
 * any surface wins (recordAnswer is atomic); answered blocks stay visible for receipts. */
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as yaml from 'yaml';
import { stringifyDoc } from '../yaml-io.js';
import { getFeedDir, getUserAgentsDir } from '../state.js';
import { isAdmin, isHighConsequenceAllowed, isKnownOperator } from '../operator.js';
import { projectKeyFromCwd } from '../project-key.js';
import { atomicWriteJsonSync } from '../fs-atomic.js';

export interface BlockOption {
  label: string;
  description?: string;
}

export interface BlockQuestion {
  text: string;
  header?: string;
  options?: BlockOption[];
  multiSelect?: boolean;
  /** Preceding report/explanation for a prose question, Markdown and newlines preserved
   * (PHNX-3999); absent for a structured question. */
  context?: string;
}

export interface MessageReceipt {
  /** The message id this receipt describes. */
  msgId: string;
  /** Delivery lifecycle state. */
  status: 'queued' | 'consumed' | 'continued' | 'dropped' | 'expired';
  /** ISO-8601 timestamp of the state transition. */
  at: string;
  /** Optional sender label for the message. */
  from?: string;
  /** The ask this receipt is about: the block generation live when the answer was sent. A block
   * id is per session, so without this a late acknowledgement for question N would resolve
   * question N+1 (PHNX-3999). Carried durably on the queued message. */
  generation?: string;
  /** The claim (attempt) this receipt is about — `AnswerRecord.answeredAt`. */
  attempt?: string;
}

/** The ask a receipt or queued message belongs to, plus the attempt that sent it. */
export interface ReceiptOrigin {
  generation: string;
  attempt: string;
}

/** Whether a receipt describes this ask. Identity is the generation alone, never the attempt: an
 * adopted stranded claim mints a new attempt and must still recognize its predecessor's message
 * or it enqueues a duplicate. An unbound (pre-field) receipt matches nothing (PHNX-3999). */
export function receiptMatchesOrigin(receipt: MessageReceipt, origin: ReceiptOrigin): boolean {
  if (receipt.generation === undefined) return false;
  return receipt.generation === origin.generation;
}

export interface AnswerRecord {
  /** ISO-8601 timestamp of when the answer was recorded. */
  answeredAt: string;
  /** Surface that recorded the answer (e.g. 'feed', 'terminal', 'tmux', 'cloud', 'policy'). */
  answeredFrom: string;
  /** Optional operator/agent label recorded as the sender. */
  answeredBy?: string;
  /** Operator id from the local registry, if verified. */
  operatorId?: string;
  /** Whether the operator identity was verified against the registry. */
  verified?: boolean;
}

/** Where an attention record came from, strongest first: hook (harness event), declared (`feed
 * post --blocked`), lifecycle (structural session signal), heuristic (decaying prose question),
 * system (synthetic card). */
export type AttentionSource = 'hook' | 'declared' | 'lifecycle' | 'heuristic' | 'system';

/** Lifecycle state of an attention record: `open` until answered, then `answered`, `consumed`
 * (agent read it), `continued` (agent moved on), or `resolved` (terminal clear). The operator
 * projection ranks on this; only `open` needs a human. */
export type AttentionState = 'open' | 'answered' | 'consumed' | 'continued' | 'resolved';

/** A cursor into the producing source (transcript last write or `eventId`). Lets a tombstone say
 * "resolved at this point" so a stale re-read cannot resurrect it, while a strictly later
 * cursor passes as a new generation. */
export interface SourceCursor {
  lastActivityMs?: number;
  eventId?: string;
}

export interface OpenBlock {
  blockId: string;
  sessionId: string;
  mailboxId: string;
  host: string;
  runtime: string;
  /** Generation key for the block's current question. A new AskUserQuestion or `--blocked` post
   * mints a new one, so the previous generation's tombstone cannot suppress it. Derived from
   * `ts` when unstamped (blockGeneration). */
  generation?: string;
  /** How this block came to exist. Derived from {@link kind} when absent — see {@link blockSource}. */
  source?: AttentionSource;
  /** Lifecycle state. Derived from the answer/continue markers when absent — see {@link deriveBlockState}. */
  state?: AttentionState;
  /** Where in the source this generation sits, stamped at write time and carried onto its
   * tombstone. Without it a new generation is suppressed whenever `session.lastActivityMs` is
   * unresolvable (cloud, remote, index lag). */
  sourceCursor?: SourceCursor;
  /** Indexed launch origin, added at read time when the live session is known. */
  origin?: 'cli' | 'routine';
  /** Routine definition name when origin is `routine`. */
  routineName?: string;
  /** Project/repo name this block belongs to (derived from cwd, worktree-aware). */
  project?: string;
  ts: string;
  questions: BlockQuestion[];
  /** How a block came to exist: question (AskUserQuestion), notification (`notificationType`;
   * `idle_prompt` is never published, PHNX-3999), control (synthetic feed card), or declared
   * (the agent says it is stuck via `feed post --blocked`). */
  kind?: 'question' | 'notification' | 'control' | 'declared';
  notificationType?: string;
  ticket?: string;
  pr?: string;
  /** Worktree slug under `.agents/worktrees/` — soft outcome when no ticket/PR. */
  worktreeSlug?: string;
  /** Epic / initiative label when no ticket/PR/worktree is known. */
  epic?: string;
  /** Block class: approval has a safe default; decision requires human choice. */
  blockClass?: 'approval' | 'decision';
  /** Consequence tag for authz. 'high' gates merge/deploy/admin-style answers. */
  consequence?: 'normal' | 'high' | string;
  /** Operator ids allowed to answer a high-consequence block. Admins always pass. */
  allowedOperators?: string[];
  /** Timeout in minutes before default-on-no-answer policy fires. */
  timeoutMinutes?: number;
  /** Safe default answer for approval-class blocks. */
  safeDefault?: string;
  /** Cost-of-delay for notification routing: low/medium/high. */
  costOfDelay?: 'low' | 'medium' | 'high';
  /** Number of agents downstream of this blocked agent, when known. */
  downstreamAgents?: number;
  /** Computed cost-of-delay rank metadata, stamped by `agents feed`. */
  delayRank?: {
    score: number;
    idleMinutes: number;
    blastRadius: number;
    burnUsdPerHour: number;
    decisionIrreducibility: number;
  };
  /** Token/cost runaway signal for synthetic feed control cards. */
  runaway?: {
    reason: string;
    tokPerSec?: number;
    burnUsdPerHour?: number;
    relaunchesPerTenMinutes?: number;
  };
  /** Chronic-ask signal for synthetic feed control cards. */
  needy?: {
    askCountLastHour: number;
    threshold: number;
    totalAskCount: number;
  };
  /** Set once the block has been answered; see `recordAnswer`. */
  answer?: AnswerRecord;
  /** Per-message delivery receipts for answers to this block. */
  receipts?: MessageReceipt[];
  /** ISO-8601 timestamp when the agent continued past the block. */
  continuedAt?: string;
  /** ISO-8601 timestamp when an urgent block was paged to the phone. */
  notifiedAt?: string;
  /** ISO-8601 timestamp when the approval safe-default was applied. */
  defaultedAt?: string;
  /** ISO-8601 timestamp when a decision block was hard-parked. */
  parkedAt?: string;
}

export interface FeedAskStats {
  sessionId: string;
  mailboxId: string;
  firstAskAt: string;
  lastAskAt: string;
  totalAskCount: number;
  recentAskTimestamps: string[];
}

/** Why an attention generation stopped needing a human: answered, continued (agent moved on),
 * tool_completed (approval cleared), expired (heuristic aged out), or session_advanced
 * (transcript moved past it). */
export type ResolutionReason =
  | 'answered'
  | 'continued'
  | 'tool_completed'
  | 'expired'
  | 'session_advanced';

/** A resolution tombstone, recorded before the open-block view is cleared so a resolved
 * generation cannot resurrect from a stale lifecycle re-read (RUSH-1522) until the session
 * advances past `sourceCursor`. One per block id, latest wins, so it never grows unbounded. */
export interface AttentionResolution {
  blockId: string;
  /** The generation this tombstone resolved — matched against a fresh candidate's generation. */
  generation: string;
  /** ISO-8601 timestamp of the resolution. */
  resolvedAt: string;
  /** Where in the source the resolved generation sat; the reconciler compares a candidate's cursor against it. */
  sourceCursor?: SourceCursor;
  reason: ResolutionReason;
}

function resolutionDir(root: string): string { return path.join(root, 'resolutions'); }

/** Canonical generation for a block: the stamped `generation`, else the publish `ts`, which the
 * feed rewrites only when a new question replaces the old, so it changes exactly when the ask
 * does. */
export function blockGeneration(block: OpenBlock): string {
  return block.generation ?? block.ts;
}

/** Canonical source for a block: the stamped `source`, else derived from `kind` (declared,
 * system, or hook). */
export function blockSource(block: OpenBlock): AttentionSource {
  if (block.source) return block.source;
  switch (block.kind) {
    case 'declared': return 'declared';
    case 'control': return 'system';
    default: return 'hook';
  }
}

/** Canonical lifecycle state: the stamped `state`, else derived from `continuedAt` (continued),
 * a recorded `answer` (answered), or open. The one place that maps the historical marker
 * fields, so no consumer re-derives it. */
export function deriveBlockState(block: OpenBlock): AttentionState {
  if (block.state) return block.state;
  if (block.continuedAt) return 'continued';
  if (block.answer) return 'answered';
  return 'open';
}

/** Records a resolution tombstone (latest wins per block id), called from answer/continue/clear
 * paths before the block view is removed. */
export function recordResolution(resolution: AttentionResolution, root?: string): void {
  const dir = resolutionDir(root ?? getFeedDir());
  ensureDir(dir);
  atomicWriteJsonSync(path.join(dir, `${resolution.blockId}.json`), resolution);
}

/** Read the latest resolution tombstone for a block, if one exists. */
export function readResolution(blockId: string, root?: string): AttentionResolution | undefined {
  return safeReadJson<AttentionResolution>(path.join(resolutionDir(root ?? getFeedDir()), `${blockId}.json`));
}

/** Stable block id for a session: one block per session, since an agent asks one question at a
 * time. */
export function blockIdForSession(sessionId: string): string {
  const safeSessionId = sessionId.replace(/[^A-Za-z0-9._-]/g, '-');
  return `block-${safeSessionId}`;
}

function blockPath(root: string, blockId: string): string {
  if (!/^[A-Za-z0-9._-]+$/.test(blockId)) {
    throw new Error(`Invalid feed block id: ${blockId}`);
  }
  return path.join(root, `${blockId}.json`);
}

function answeredDir(root: string): string { return path.join(root, 'answered'); }
function receiptDir(root: string): string { return path.join(root, 'receipts'); }
function askStatsDir(root: string): string { return path.join(root, 'asks'); }

function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

function safeReadJson<T>(file: string): T | undefined {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf-8')) as T;
  } catch {
    return undefined;
  }
}

/** Read one block record. Returns undefined when missing or corrupt. */
export function readBlock(blockId: string, root?: string): OpenBlock | undefined {
  const parsed = safeReadJson<Partial<OpenBlock>>(blockPath(root ?? getFeedDir(), blockId));
  if (!parsed || !parsed.blockId || !parsed.sessionId || !parsed.questions?.length) return undefined;
  return parsed as OpenBlock;
}

type RecordAnswerResult =
  | { ok: true }
  | { ok: false; existing: AnswerRecord }
  | { ok: false; unauthorized: true; reason: string };

/** Atomically claims the first answer for a block: `{ ok: true }` for the first, `{ ok: false,
 * existing }` otherwise. The marker is created with `O_EXCL`. High-consequence blocks require a
 * verified operator identity; unverified answers are refused. */
export function recordAnswer(
  blockId: string,
  answer: { answeredBy?: string; answeredFrom: string; operatorId?: string; verified?: boolean },
  root?: string,
  options: { pending?: boolean } = {},
): RecordAnswerResult {
  const dir = root ?? getFeedDir();
  const block = readBlock(blockId, dir);
  const operatorId = answer.operatorId;

  if (block?.consequence && block.consequence !== 'normal') {
    // Operators live in ~/.agents/operators.yaml — never the feed store root.
    if (!operatorId || answer.verified !== true || !isKnownOperator(operatorId)) {
      return {
        ok: false,
        unauthorized: true,
        reason: `High-consequence block '${block.consequence}' requires a verified, authorized operator.`,
      };
    }
    const allowedByBlock = block.allowedOperators?.includes(operatorId) ?? false;
    const allowedByCapability = isHighConsequenceAllowed(block.consequence, operatorId);
    if (!allowedByBlock && !allowedByCapability) {
      return {
        ok: false,
        unauthorized: true,
        reason: `High-consequence block '${block.consequence}' requires a verified, authorized operator.`,
      };
    }
    if (block.allowedOperators?.length && !allowedByBlock && !isAdmin(operatorId)) {
      return {
        ok: false,
        unauthorized: true,
        reason: `High-consequence block '${block.consequence}' is restricted to: ${block.allowedOperators.join(', ')}.`,
      };
    }
  }

  ensureDir(answeredDir(dir));
  const marker = path.join(answeredDir(dir), `${blockId}.json`);
  const record: AnswerRecord = {
    answeredAt: new Date().toISOString(),
    answeredFrom: answer.answeredFrom,
    answeredBy: answer.answeredBy,
    operatorId: answer.operatorId,
    verified: answer.verified,
  };

  // Try to create the answered marker atomically.
  try {
    const fd = fs.openSync(marker, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o644);
    try {
      const buf = Buffer.from(JSON.stringify(record, null, 2), 'utf-8');
      fs.writeSync(fd, buf, 0, buf.length);
    } finally {
      fs.closeSync(fd);
    }
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'EEXIST') {
      const existing = safeReadJson<AnswerRecord>(marker);
      return { ok: false, existing: existing ?? { answeredAt: '', answeredFrom: 'unknown' } };
    }
    throw err;
  }

  // Marker created: mirror the answer into the block file. A `pending` claim stops there, leaving
  // the generation unresolved and state `open`, so the card stays until a rail reports a real
  // receipt (`confirmAnswerResolution`, PHNX-3999); `state` beats `answer` in deriveBlockState.
  if (block) {
    if (!options.pending) {
      recordResolution({
        blockId,
        generation: blockGeneration(block),
        resolvedAt: record.answeredAt,
        sourceCursor: block.sourceCursor,
        reason: 'answered',
      }, dir);
    }
    block.answer = record;
    block.state = options.pending ? 'open' : 'answered';
    publishBlock(block, dir);
  }
  return { ok: true };
}

/** Promotes a pending claim to a resolved answer (second half of the two-phase protocol). Called
 * only once a rail reports a real MessageReceipt, which is when the tombstone is written and
 * the card may leave; an unconfirmed delivery never reaches here. */
export function confirmAnswerResolution(
  blockId: string,
  root?: string,
  expected?: { generation: string; answeredAt: string },
): boolean {
  const dir = root ?? getFeedDir();
  const block = readBlock(blockId, dir);
  const record = getAnswerRecord(blockId, dir);
  if (!block || !record) return false;
  // One block id serves every generation, so a slow delivery for the previous question must not
  // resolve the current one: a caller naming the ask gets a no-op on mismatch. Bound to the
  // generation, not the attempt, since adopting a stranded claim mints a new attempt.
  if (expected && blockGeneration(block) !== expected.generation) return false;
  recordResolution({
    blockId,
    generation: blockGeneration(block),
    resolvedAt: record.answeredAt,
    sourceCursor: block.sourceCursor,
    reason: 'answered',
  }, dir);
  block.answer = record;
  block.state = 'answered';
  publishBlock(block, dir);
  return true;
}

/** Read the answer record for a block, if one exists. */
export function getAnswerRecord(blockId: string, root?: string): AnswerRecord | undefined {
  return safeReadJson<AnswerRecord>(path.join(answeredDir(root ?? getFeedDir()), `${blockId}.json`));
}

/** Releases one answer claim after its reply rail failed. The compare on `answeredAt` makes it a
 * conditional rollback that never erases a newer claimant; the caller supplies the pre-claim
 * block/resolution snapshots to restore. */
export function rollbackAnswerClaim(
  blockId: string,
  answeredAt: string,
  previousBlock: OpenBlock,
  previousResolution: AttentionResolution | undefined,
  root?: string,
): boolean {
  const dir = root ?? getFeedDir();
  const marker = path.join(answeredDir(dir), `${blockId}.json`);
  const current = safeReadJson<AnswerRecord>(marker);
  if (!current || current.answeredAt !== answeredAt) return false;

  // Read-compare-unlink is not atomic: two callers releasing the same claim can both pass the
  // compare, then the second unlinks the first's fresh marker and both hold a claim. So release
  // is gated on an O_EXCL token per exact claim, as recordAnswer does (PHNX-3999).
  const release = path.join(answeredDir(dir), `${blockId}.${answeredAt.replace(/[^0-9A-Za-z]/g, '')}.release`);
  if (!acquireReleaseToken(release)) return false;
  const dropToken = (): void => {
    try { fs.unlinkSync(release); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  };
  // Re-read INSIDE the token: a racer that released-and-re-claimed between our
  // first read and the token acquisition would otherwise be clobbered.
  const held = safeReadJson<AnswerRecord>(marker);
  if (!held || held.answeredAt !== answeredAt) { dropToken(); return false; }

  // Restore while the O_EXCL marker still excludes every other claimant. The
  // marker is removed LAST; once another writer can win recordAnswer, this
  // rollback has no state left to overwrite.
  publishBlock(previousBlock, dir);
  const resolutionFile = path.join(resolutionDir(dir), `${blockId}.json`);
  if (previousResolution) recordResolution(previousResolution, dir);
  else {
    try { fs.unlinkSync(resolutionFile); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  try { fs.unlinkSync(marker); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  // The token has done its job: this exact claim can never be released again,
  // because the claim it names no longer exists. Leaving it would accumulate one
  // dead file per released claim forever.
  dropToken();
  return true;
}

/** How long a release token may sit before it is treated as abandoned; a release is a few
 * synchronous file operations, so older belongs to a dead process. */
export const RELEASE_TOKEN_STALE_MS = 60_000;

/** Takes the O_EXCL token serialising release of one claim. It must be recoverable, or a process
 * killed mid-release wedges the claim forever. The token records owner and age; one whose owner
 * is provably gone (same host, no such pid) or which is stale is reclaimed once. */
function acquireReleaseToken(release: string): boolean {
  const mine = { pid: process.pid, host: os.hostname(), at: Date.now() };
  // Publish the token with its owner already in it: write a private temp file,
  // then link() it into place. link fails with EEXIST atomically, like O_EXCL, but
  // a peer can never observe the token empty. With O_EXCL-then-write, a peer that
  // read between the two saw no owner, judged the token stale, deleted it and
  // released the same claim too (PHNX-4131: two processes adopted one claim).
  const create = (): boolean => {
    const staged = `${release}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
    try {
      fs.writeFileSync(staged, JSON.stringify(mine), { mode: 0o644 });
      fs.linkSync(staged, release);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
      throw error;
    } finally {
      fs.rmSync(staged, { force: true });
    }
  };
  if (create()) return true;

  const held = safeReadJson<{ pid?: number; host?: string; at?: number }>(release);
  // A token whose owner cannot be read (left by an older writer, or a crash
  // mid-write) is aged by its mtime, never treated as infinitely old.
  let ageMs: number;
  if (held?.at) ageMs = Date.now() - held.at;
  else {
    try { ageMs = Date.now() - fs.statSync(release).mtimeMs; } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return create();
      throw error;
    }
  }
  let ownerGone = false;
  if (held?.host === mine.host && typeof held.pid === 'number') {
    // Signal 0 probes liveness without delivering anything.
    try { process.kill(held.pid, 0); } catch { ownerGone = true; }
  }
  if (!ownerGone && ageMs < RELEASE_TOKEN_STALE_MS) return false; // a live peer owns it
  try { fs.unlinkSync(release); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  // Exactly one reclaimer wins the re-create; the rest see EEXIST and back off.
  return create();
}

/** True when the block has already been answered. */
export function isBlockAnswered(blockId: string, root?: string): boolean {
  return fs.existsSync(path.join(answeredDir(root ?? getFeedDir()), `${blockId}.json`));
}

/** Receipt lifecycle rank — higher means further along; never regress. */
const RECEIPT_STATUS_RANK: Record<MessageReceipt['status'], number> = {
  queued: 0,
  consumed: 1,
  continued: 2,
  dropped: 3,
  expired: 3,
};

/** Records a delivery-receipt transition for a block's message. Status is monotonic (queued,
 * consumed, continued), so a late `queued` cannot overwrite `consumed`/`continued` (race with
 * mailbox drain). */
export function recordMessageReceipt(
  blockId: string,
  receipt: MessageReceipt,
  root?: string,
): void {
  const dir = root ?? getFeedDir();
  const block = readBlock(blockId, dir);
  if (!block) return;
  const receipts = block.receipts ?? [];
  const idx = receipts.findIndex((r) => r.msgId === receipt.msgId);
  if (idx >= 0) {
    const prev = receipts[idx];
    if (RECEIPT_STATUS_RANK[receipt.status] < RECEIPT_STATUS_RANK[prev.status]) {
      return; // do not regress
    }
    receipts[idx] = receipt;
  } else {
    receipts.push(receipt);
  }
  block.receipts = receipts;
  publishBlock(block, dir);

  // Only the agent's own acknowledgement resolves a pending claim; `queued` must never remove the
  // card (PHNX-3999). Promotion is bound to the receipt's own origin, since checking `block.answer`
  // alone let a late ack for question N resolve a claimed question N+1.
  if ((receipt.status === 'consumed' || receipt.status === 'continued')
    && receipt.generation !== undefined && block.answer) {
    confirmAnswerResolution(blockId, dir, {
      generation: receipt.generation, answeredAt: block.answer.answeredAt,
    });
  }
}

/** Read the receipt list for a block. */
export function getBlockReceipts(blockId: string, root?: string): MessageReceipt[] {
  return readBlock(blockId, root)?.receipts ?? [];
}

/** The furthest-along receipt for a block, or undefined. The only truthful evidence an answer
 * reached a rail: an answer marker proves only a claim, so callers reporting on a block they
 * did not deliver must read this, not synthesize a receipt (PHNX-3999). */
export function latestMessageReceipt(
  blockId: string, root?: string, origin?: ReceiptOrigin,
): MessageReceipt | undefined {
  const all = getBlockReceipts(blockId, root);
  // A block id is per session, so its receipts accumulate across generations; a caller that knows
  // which ask passes the origin and sees only that ask's evidence, so question N's receipt cannot
  // answer for N+1.
  const receipts = origin ? all.filter((receipt) => receiptMatchesOrigin(receipt, origin)) : all;
  let best: MessageReceipt | undefined;
  for (const receipt of receipts) {
    if (!best) { best = receipt; continue; }
    const rank = RECEIPT_STATUS_RANK[receipt.status] - RECEIPT_STATUS_RANK[best.status];
    if (rank > 0 || (rank === 0 && receipt.at >= best.at)) best = receipt;
  }
  return best;
}

/** Mark a block as "continued" -- the agent consumed the answer and moved on. */
export function recordContinued(blockId: string, root?: string): void {
  const dir = root ?? getFeedDir();
  const block = readBlock(blockId, dir);
  if (!block) return;
  const now = new Date().toISOString();
  block.continuedAt = now;
  block.state = 'continued';
  recordResolution({
    blockId,
    generation: blockGeneration(block),
    resolvedAt: now,
    sourceCursor: block.sourceCursor,
    reason: 'continued',
  }, dir);
  publishBlock(block, dir);
}

/** Mark a decision-class block as hard-parked (no safe default existed). */
export function recordParked(blockId: string, root?: string): void {
  const dir = root ?? getFeedDir();
  const block = readBlock(blockId, dir);
  if (!block) return;
  block.parkedAt = new Date().toISOString();
  publishBlock(block, dir);
}

/** Mark that the approval safe-default was applied by policy. */
export function recordDefaulted(blockId: string, root?: string): void {
  const dir = root ?? getFeedDir();
  const block = readBlock(blockId, dir);
  if (!block) return;
  block.defaultedAt = new Date().toISOString();
  publishBlock(block, dir);
}

/** Mark that an urgent block was paged to the phone. */
export function recordNotified(blockId: string, root?: string): void {
  const dir = root ?? getFeedDir();
  const block = readBlock(blockId, dir);
  if (!block) return;
  block.notifiedAt = new Date().toISOString();
  publishBlock(block, dir);
}

/** Remove answered marker and receipts for a block (used by block removal/GC). */
function clearBlockLifecycle(blockId: string, root?: string): void {
  const dir = root ?? getFeedDir();
  for (const sub of [answeredDir(dir), receiptDir(dir)]) {
    try {
      fs.unlinkSync(path.join(sub, `${blockId}.json`));
    } catch {
      // ignore missing
    }
  }
}

/** Identity of the agent declaring a block — the subset of `PostIdentity` it needs. */
export interface DeclaringAgent {
  sessionId: string;
  mailboxId: string;
  host: string;
  runtime: string;
  cwd?: string;
}

interface DeclareBlockInput {
  /** What the agent needs from the user, front-loaded. */
  text: string;
  /** Answerable choices, if the ask is a pick-one. */
  options?: string[];
  /** A safe default makes this an approval; without one it is a decision. */
  safeDefault?: string;
  /** Minutes before the default-on-no-answer policy may fire. */
  timeoutMinutes?: number;
  ts?: string;
}

/** Builds the block record for `agents feed post --blocked`, pure so the shape is testable.
 * Class is derived: a `--default` means policy can resolve it (approval), none means only a
 * human can (decision), as `feed-policy.ts` reads. */
export function buildDeclaredBlock(agent: DeclaringAgent, input: DeclareBlockInput): OpenBlock {
  const text = input.text.trim().replace(/\s+/g, ' ');
  if (!text) {
    throw new Error('Block text is empty. Usage: agents feed post --title "Short subject" "what you need from the user" --blocked');
  }
  const options = (input.options ?? [])
    .map((label) => label.trim())
    .filter(Boolean)
    .map((label) => ({ label }));

  const project = projectKeyFromCwd(agent.cwd);
  const ts = input.ts ?? new Date().toISOString();
  return {
    blockId: blockIdForSession(agent.sessionId),
    sessionId: agent.sessionId,
    mailboxId: agent.mailboxId,
    host: agent.host,
    runtime: agent.runtime,
    ts,
    // A declared block is an explicit, agent-raised attention record: it opens the
    // lifecycle here, sourced `declared`, with `ts` as its generation so a later
    // `--blocked` in the same session mints a fresh generation past any tombstone.
    generation: ts,
    source: 'declared',
    state: 'open',
    // Write-time cursor so a new generation is not suppressed when
    // session.lastActivityMs is unresolvable (cloud / remote / index-lag).
    sourceCursor: { lastActivityMs: Date.parse(ts) },
    kind: 'declared',
    questions: [{ text, header: 'Needs you', ...(options.length ? { options } : {}) }],
    blockClass: input.safeDefault ? 'approval' : 'decision',
    costOfDelay: 'high',
    ...(project ? { project } : {}),
    ...(input.safeDefault ? { safeDefault: input.safeDefault } : {}),
    ...(input.timeoutMinutes !== undefined ? { timeoutMinutes: input.timeoutMinutes } : {}),
  };
}

/** Atomic write a block record to the feed store. Clears stale lifecycle state. */
export function publishBlock(block: OpenBlock, root?: string): void {
  const dir = root ?? getFeedDir();
  fs.mkdirSync(dir, { recursive: true });
  const target = blockPath(dir, block.blockId);
  atomicWriteJsonSync(target, block);
}

/** Read all block records. Returns them sorted by stable block filename. */
export function listBlocks(root?: string): OpenBlock[] {
  const dir = root ?? getFeedDir();
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const blocks: OpenBlock[] = [];
  for (const name of names.filter(n => n.endsWith('.json')).sort()) {
    try {
      const raw = fs.readFileSync(path.join(dir, name), 'utf-8');
      const parsed = JSON.parse(raw) as Partial<OpenBlock>;
      if (parsed.blockId && parsed.sessionId && parsed.questions?.length) {
        blocks.push(parsed as OpenBlock);
      }
    } catch {
      // skip corrupt / partial files
    }
  }
  return blocks;
}

/** Read per-session ask history written by the feed publish hook. */
export function listAskStats(root?: string): FeedAskStats[] {
  const dir = askStatsDir(root ?? getFeedDir());
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const stats: FeedAskStats[] = [];
  for (const name of names.filter(n => n.endsWith('.json')).sort()) {
    const parsed = safeReadJson<Partial<FeedAskStats>>(path.join(dir, name));
    if (!parsed?.sessionId || !parsed.mailboxId || !parsed.lastAskAt) continue;
    stats.push({
      sessionId: parsed.sessionId,
      mailboxId: parsed.mailboxId,
      firstAskAt: parsed.firstAskAt ?? parsed.lastAskAt,
      lastAskAt: parsed.lastAskAt,
      totalAskCount: parsed.totalAskCount ?? parsed.recentAskTimestamps?.length ?? 0,
      recentAskTimestamps: Array.isArray(parsed.recentAskTimestamps) ? parsed.recentAskTimestamps : [],
    });
  }
  return stats;
}

/** Remove a block record and its lifecycle sidecars. Returns true if the file was deleted. */
export function removeBlock(blockId: string, root?: string): boolean {
  const dir = root ?? getFeedDir();
  // Record a resolution tombstone before the block file and answered marker go, so a stale
  // lifecycle re-read cannot resurrect the cleared generation. Reason: answered marker,
  // `continuedAt` (agent moved on), else transcript advanced. Tombstone must outlive the block.
  const block = readBlock(blockId, dir);
  if (block) {
    const reason: ResolutionReason = isBlockAnswered(blockId, dir)
      ? 'answered'
      : block.continuedAt ? 'continued' : 'session_advanced';
    recordResolution({
      blockId,
      generation: blockGeneration(block),
      resolvedAt: new Date().toISOString(),
      sourceCursor: block.sourceCursor,
      reason,
    }, dir);
  }
  clearBlockLifecycle(blockId, dir);
  try {
    fs.unlinkSync(blockPath(dir, blockId));
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Hook installation
// ---------------------------------------------------------------------------

/** The feed-publish PreToolUse hook script (Python), embedded so it ships with the compiled CLI
 * and installs to the user hooks dir. */
export const FEED_PUBLISH_HOOK_SCRIPT = `#!/usr/bin/env python3
"""Publish and clear open-block records for \`agents feed\`.

The manifest invokes this script for top-level AskUserQuestion calls, waiting
notifications, question answers, and session lifecycle events. One atomic file
per session means a new block replaces the previous block. Answer/resume/stop
events remove it so \`agents feed\` only lists decisions that are still open.

Sub-agent gate: when the PreToolUse payload carries \`agent_type\`, this is a
Task/Agent subagent -- skip. Only the top-level agent publishes. Verified on
Claude Code 2.1.170 (2026-07).

Fail-open: ANY error is swallowed so a feed hiccup never blocks a tool call.
"""
import os
import sys
import json
import re
import socket
import tempfile
from datetime import datetime, timezone

# Notification subtypes that mean something is PENDING. Claude's idle_prompt is
# deliberately absent: it fires a minute after the turn ended with the operator
# idle, which is a finished turn, not a request -- publishing it put an
# Approve/Deny banner on a session that had already answered "pong" (PHNX-3999).
WAITING_NOTIFICATION_TYPES = {
    "permission_prompt",
    "elicitation_dialog",
}
CLEAR_EVENTS = {
    "PostToolUse",
    "Stop",
    "SessionEnd",
}
# Codex emits a PermissionRequest event (not Claude's Notification) when it
# blocks on an approval prompt. Claude never fires PermissionRequest, so the
# same script handles both: PermissionRequest maps to an approval-class block
# with a high cost-of-delay so 'agents feed --dispatch' pages it as urgent.


def read_json(path):
    try:
        with open(path) as f:
            return json.load(f)
    except Exception:
        return None


def write_json(path, value):
    dir_name = os.path.dirname(path)
    os.makedirs(dir_name, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=dir_name, suffix=".tmp")
    try:
        with os.fdopen(fd, "w") as f:
            json.dump(value, f, indent=2)
        os.replace(tmp, path)
    except Exception:
        try:
            os.unlink(tmp)
        except Exception:
            pass


def project_from_cwd(cwd):
    """Basename of cwd, with worktree paths resolved to their repo name."""
    if not cwd:
        return None
    norm = cwd.replace("\\\\", "/").rstrip("/")
    if not norm:
        return None
    marker = "/.agents/worktrees/"
    idx = norm.find(marker)
    if idx > 0:
        repo_path = norm[:idx]
        base = repo_path[repo_path.rfind("/") + 1:]
        if base:
            return base
    base = norm[norm.rfind("/") + 1:]
    return base or None


def main():
    raw = sys.stdin.read()
    try:
        payload = json.loads(raw) if raw.strip() else {}
    except Exception:
        return

    # Sub-agent gate.
    if payload.get("agent_type"):
        return

    session_id = payload.get("session_id", "")
    if not session_id:
        return

    safe_session_id = re.sub(r"[^A-Za-z0-9._-]", "-", session_id)
    block_id = f"block-{safe_session_id}"
    home = os.environ.get("HOME") or os.path.expanduser("~")
    feed_dir = os.path.join(home, ".agents", ".history", "feed")
    answered_dir = os.path.join(feed_dir, "answered")
    asks_dir = os.path.join(feed_dir, "asks")
    target = os.path.join(feed_dir, f"{block_id}.json")
    hook_event = payload.get("hook_event_name", "PreToolUse")

    if hook_event in CLEAR_EVENTS:
        # A declared block (\`agents feed post --blocked\`) is the agent explicitly
        # saying it is stuck. Unlike a question/notification/approval block -- which
        # tracks an in-flight harness prompt that a lifecycle event resolves -- a
        # declared block stays open until it is actually ANSWERED. So while it is
        # still UNANSWERED, Stop/SessionEnd/PostToolUse must never silently drop it:
        # otherwise the needs-you record vanishes the moment the agent parks the block
        # and its turn ends -- exactly when the owner still needs to see and answer it.
        # Once it IS answered (an answered marker exists), it clears like any other
        # block by falling through below -- which frees that marker too, so a later
        # \`--blocked\` in the same session is not falsely locked as already-answered
        # (recordAnswer creates the marker with O_EXCL).
        try:
            with open(target) as existing_file:
                existing = json.load(existing_file)
            answered = os.path.exists(os.path.join(answered_dir, f"{block_id}.json"))
            if existing.get("kind") == "declared" and not answered:
                return
        except Exception:
            pass
        # A matcher-less PostToolUse clear (registered for Codex so an approved
        # tool clears its approval card) must NOT wipe an open AskUserQuestion
        # while an unrelated tool runs mid-question -- those are cleared only by
        # the AskUserQuestion-matched PostToolUse. So on PostToolUse, keep a
        # 'question' block; approval/notification blocks clear once the tool runs.
        if hook_event == "PostToolUse":
            try:
                with open(target) as existing_file:
                    existing = json.load(existing_file)
                if existing.get("kind") == "question" and payload.get("tool_name") != "AskUserQuestion":
                    return
            except Exception:
                pass
        try:
            os.unlink(target)
        except FileNotFoundError:
            pass
        except Exception:
            pass
        # Also clear the answered marker so a future question for this session
        # is not permanently locked.
        try:
            os.unlink(os.path.join(answered_dir, f"{block_id}.json"))
        except FileNotFoundError:
            pass
        except Exception:
            pass
        return

    # Terminal answers (human typed in the TUI) record an answered marker and
    # remove the block file so the feed stops showing it within one poll cycle.
    # The marker stays behind so a concurrent surface cannot double-answer.
    # A resolution tombstone is written BEFORE unlink (matching TS recordAnswer)
    # so a stale lifecycle re-read cannot resurrect this generation.
    if hook_event == "UserPromptSubmit":
        os.makedirs(answered_dir, exist_ok=True)
        marker = os.path.join(answered_dir, f"{block_id}.json")
        now_iso = datetime.now(timezone.utc).isoformat()
        try:
            fd = os.open(marker, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o644)
            record = {
                "answeredAt": now_iso,
                "answeredFrom": "terminal",
            }
            with os.fdopen(fd, "w") as f:
                json.dump(record, f, indent=2)
        except FileExistsError:
            pass
        except Exception:
            pass
        # Tombstone first, then drop the open-block view. A missing/corrupt
        # block means there is nothing to resolve; fail open.
        existing = read_json(target)
        if isinstance(existing, dict):
            generation = existing.get("generation") or existing.get("ts")
            if generation:
                tombstone = {
                    "blockId": block_id,
                    "generation": generation,
                    "resolvedAt": now_iso,
                    "reason": "answered",
                }
                source_cursor = existing.get("sourceCursor")
                if source_cursor:
                    tombstone["sourceCursor"] = source_cursor
                write_json(
                    os.path.join(feed_dir, "resolutions", f"{block_id}.json"),
                    tombstone,
                )
        # Remove the visible block so the feed drops the answered question.
        try:
            os.unlink(target)
        except FileNotFoundError:
            pass
        except Exception:
            pass
        return

    notification_type = None
    codex_approval = False
    if hook_event == "Notification":
        notification_type = payload.get("notification_type", "")
        if notification_type not in WAITING_NOTIFICATION_TYPES:
            return
        # Claude emits a generic permission notification after presenting an
        # AskUserQuestion. Keep the structured questions and options already
        # published for this session instead of replacing them with that less
        # useful notification text.
        try:
            with open(target) as existing_file:
                existing = json.load(existing_file)
            if existing.get("kind") == "question":
                return
        except Exception:
            pass
        message = payload.get("message", "")
        if not message:
            return
        normalized_questions = [{
            "text": message,
            "header": payload.get("title") or notification_type.replace("_", " ").title(),
            "multiSelect": False,
        }]
        kind = "notification"
    elif hook_event == "PermissionRequest":
        # Codex approval prompt. The payload mirrors PreToolUse (tool_name,
        # tool_input) but carries no questions -- Codex is asking to run a tool,
        # not asking the operator a multiple-choice question. Publish it as a
        # notification-kind approval block naming the tool so the feed and the
        # phone notifier can surface it, and so AGI EXT can bridge
        # it to a VS Code notification.
        tool_name = payload.get("tool_name") or "a tool"
        tool_input = payload.get("tool_input", {})
        command = ""
        if isinstance(tool_input, dict):
            command = (
                tool_input.get("command")
                or tool_input.get("cmd")
                or tool_input.get("path")
                or ""
            )
            if isinstance(command, list):
                command = " ".join(str(c) for c in command)
        detail = f": {command}" if command else ""
        normalized_questions = [{
            "text": f"Codex needs approval to run {tool_name}{detail}",
            "header": "Approval needed",
            "multiSelect": False,
        }]
        kind = "notification"
        notification_type = "permission_prompt"
        codex_approval = True
    else:
        tool_input = payload.get("tool_input", {})
        questions = tool_input.get("questions", [])
        if not questions:
            return
        normalized_questions = []
        for q in questions:
            if not isinstance(q, dict):
                continue
            question = {
                "text": q.get("question", q.get("header", "")),
                "header": q.get("header"),
                "multiSelect": q.get("multiSelect", False),
            }
            raw_opts = q.get("options", [])
            if raw_opts:
                question["options"] = [
                    {"label": o.get("label", ""), "description": o.get("description")}
                    for o in raw_opts
                    if isinstance(o, dict)
                ]
            normalized_questions.append(question)
        if not normalized_questions:
            return
        kind = "question"

    # Identity from env (set by agents-cli at spawn).
    mailbox_id = os.path.basename(
        os.environ.get("AGENTS_MAILBOX_DIR", "").rstrip("/")
    ) or session_id

    now = datetime.now(timezone.utc)
    now_iso = now.isoformat()
    now_ms = int(now.timestamp() * 1000)
    stats_path = os.path.join(asks_dir, f"{safe_session_id}.json")
    stats = read_json(stats_path) or {}
    recent = stats.get("recentAskTimestamps") if isinstance(stats, dict) else []
    if not isinstance(recent, list):
        recent = []
    recent.append(now_iso)
    # Keep enough history for rolling one-hour needy detection without unbounded
    # per-session files. The TypeScript reader applies the exact time window.
    recent = recent[-200:]
    write_json(stats_path, {
        "sessionId": session_id,
        "mailboxId": mailbox_id,
        "firstAskAt": stats.get("firstAskAt") or now_iso,
        "lastAskAt": now_iso,
        "totalAskCount": int(stats.get("totalAskCount") or 0) + 1,
        "recentAskTimestamps": recent,
    })

    hostname = os.environ.get("AGENTS_SYNC_MACHINE_ID") or socket.gethostname()
    host = hostname.split(".")[0].strip().lower()
    host = re.sub(r"[^a-z0-9_-]", "-", host) or "unknown"

    runtime = os.environ.get("AGENTS_RUNTIME", "headless")
    cwd = payload.get("cwd") or os.environ.get("AGENTS_CWD")
    project = project_from_cwd(cwd)

    block = {
        "blockId": block_id,
        "sessionId": session_id,
        "mailboxId": mailbox_id,
        "host": host,
        "runtime": runtime,
        "ts": now_iso,
        # Write-time cursor so a new generation is not suppressed when
        # session.lastActivityMs is unresolvable (cloud / remote / index-lag).
        "sourceCursor": {"lastActivityMs": now_ms},
        "questions": normalized_questions,
        "kind": kind,
    }
    if project:
        block["project"] = project
    if notification_type:
        block["notificationType"] = notification_type

    # A Codex PermissionRequest is a real approval gate: mark it approval-class
    # with a high cost-of-delay so 'agents feed --dispatch' classifies it urgent
    # (isPhoneUrgent gates on costOfDelay >= phoneNotifyThreshold, default
    # 'medium') and pages the phone. A plain 'deny' is the safe default.
    if codex_approval:
        block["blockClass"] = "approval"
        block["costOfDelay"] = "high"
        block["safeDefault"] = "deny"

    # Optional multi-operator control metadata passed by the agent in the
    # AskUserQuestion tool_input. Defaults keep the existing behavior. A Codex
    # PermissionRequest carries tool ARGS in tool_input (command/path), not
    # operator controls, so it is excluded here -- its class/cost is stamped
    # above from codex_approval.
    controls = payload.get("tool_input", {}) if hook_event not in ("Notification", "PermissionRequest") else {}
    block_class = controls.get("blockClass") if isinstance(controls, dict) else None
    if block_class in ("approval", "decision"):
        block["blockClass"] = block_class
    consequence = controls.get("consequence") if isinstance(controls, dict) else None
    if consequence:
        block["consequence"] = consequence
    allowed = controls.get("allowedOperators") if isinstance(controls, dict) else None
    if isinstance(allowed, list):
        block["allowedOperators"] = [str(a) for a in allowed]
    timeout = controls.get("timeoutMinutes") if isinstance(controls, dict) else None
    if isinstance(timeout, (int, float)) and timeout > 0:
        block["timeoutMinutes"] = int(timeout)
    safe_default = controls.get("safeDefault") if isinstance(controls, dict) else None
    if isinstance(safe_default, str):
        block["safeDefault"] = safe_default
    cost = controls.get("costOfDelay") if isinstance(controls, dict) else None
    if cost in ("low", "medium", "high"):
        block["costOfDelay"] = cost

    # Publishing a new question clears any stale answered marker from the
    # previous question in this session.
    try:
        os.unlink(os.path.join(answered_dir, f"{block_id}.json"))
    except FileNotFoundError:
        pass
    except Exception:
        pass

    # Python's expanduser() ignores HOME on Windows, while agents-cli honors a
    # HOME override on every platform. Use the same anchor so hooks and the CLI
    # always read/write one feed store (including temp-home and sandbox runs).
    os.makedirs(feed_dir, exist_ok=True)

    fd, tmp = tempfile.mkstemp(dir=feed_dir, suffix=".tmp")
    try:
        with os.fdopen(fd, "w") as f:
            json.dump(block, f, indent=2)
        os.replace(tmp, target)
    except Exception:
        try:
            os.unlink(tmp)
        except Exception:
            pass


if __name__ == "__main__":
    try:
        main()
    except Exception:
        pass  # fail open
`;

/** Installs the feed-publish hook script into the user hooks dir and its manifest entry into the
 * user agents.yaml; the system repo is a read-only mirror, so runtime hooks never write there.
 * Idempotent. */
export function ensureFeedPublishHook(userAgentsDir: string = getUserAgentsDir()): { installed: boolean; error?: string } {
  try {
    const hooksDir = path.join(userAgentsDir, 'hooks');
    const scriptPath = path.join(hooksDir, '10-feed-publish.py');

    fs.mkdirSync(hooksDir, { recursive: true });
    let installed = false;
    if (!fs.existsSync(scriptPath) || fs.readFileSync(scriptPath, 'utf-8') !== FEED_PUBLISH_HOOK_SCRIPT) {
      const tmpScript = `${scriptPath}.${process.pid}.tmp`;
      fs.writeFileSync(tmpScript, FEED_PUBLISH_HOOK_SCRIPT, { mode: 0o755 });
      fs.renameSync(tmpScript, scriptPath);
      installed = true;
    }

    const agentsYamlPath = path.join(userAgentsDir, 'agents.yaml');
    const yamlDoc = fs.existsSync(agentsYamlPath)
      ? yaml.parseDocument(fs.readFileSync(agentsYamlPath, 'utf-8'))
      : new yaml.Document({});
    if (yamlDoc.errors.length > 0) {
      throw new Error(`Cannot install feed hook: ${agentsYamlPath} is invalid YAML`);
    }
    const desiredHooks: Record<string, Record<string, unknown>> = {
      'feed-publish': {
        agents: ['claude', 'codex'],
        events: ['PreToolUse'],
        matcher: 'AskUserQuestion',
        script: '10-feed-publish.py',
        timeout: 5,
      },
      // idle_prompt is not matched: an idle reminder is a finished turn, not a
      // pending request (PHNX-3999). An installed agents.yaml that still carries
      // the old matcher is harmless -- the script drops the subtype itself.
      'feed-publish-notification': {
        agents: ['claude', 'codex'],
        events: ['Notification'],
        matcher: 'permission_prompt|elicitation_dialog',
        script: '10-feed-publish.py',
        timeout: 5,
      },
      // Codex-specific approval gate: Codex emits PermissionRequest (Claude does
      // not), so this hook is where a blocked Codex agent surfaces to the feed.
      'feed-publish-permission': {
        agents: ['claude', 'codex'],
        events: ['PermissionRequest'],
        script: '10-feed-publish.py',
        timeout: 5,
      },
      'feed-clear-answered': {
        agents: ['claude', 'codex'],
        events: ['PostToolUse'],
        matcher: 'AskUserQuestion',
        script: '10-feed-publish.py',
        timeout: 5,
      },
      // Matcher-less PostToolUse clear for Codex only: after an approved tool runs, its approval
      // card is stale. Claude fires no PermissionRequest, and a matcher-less PostToolUse for it
      // would run on every tool and wipe its notification-kind blocks early (RUSH-2039).
      'feed-clear-permission': {
        agents: ['codex'],
        events: ['PostToolUse'],
        script: '10-feed-publish.py',
        timeout: 5,
      },
      'feed-clear-lifecycle': {
        agents: ['claude', 'codex'],
        events: ['Stop', 'UserPromptSubmit', 'SessionEnd'],
        script: '10-feed-publish.py',
        timeout: 5,
      },
    };
    for (const [name, definition] of Object.entries(desiredHooks)) {
      if (!yamlDoc.getIn(['hooks', name])) {
        yamlDoc.setIn(['hooks', name], definition);
        installed = true;
      }
    }
    if (installed) {
      const tmpYaml = `${agentsYamlPath}.${process.pid}.tmp`;
      // `flowCollectionPadding: false` matches the committed `[a, b]`; padded re-emits left the
      // git-backed ~/.agents dirty; `agents repo pull` refused fleet-wide (RUSH-2505). Keep each
      // node's committed style; do NOT force `collectionStyle`.
      fs.writeFileSync(tmpYaml, stringifyDoc(yamlDoc));
      fs.renameSync(tmpYaml, agentsYamlPath);
    }

    return { installed };
  } catch (err) {
    return { installed: false, error: (err as Error).message };
  }
}
