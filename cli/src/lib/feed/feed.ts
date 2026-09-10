/**
 * Feed store -- structured block records published by agents waiting on user
 * input (AskUserQuestion). The outbound counterpart to the inbound mailbox:
 * the mailbox delivers messages TO agents; the feed surfaces decisions agents
 * need FROM the user.
 *
 * Layout: <feedDir>/<blockId>.json
 *   Each file is one open block -- a question the agent asked. One block per
 *   session: a new AskUserQuestion in the same session replaces the previous
 *   block (an agent can only ask one question at a time). Removed when the
 *   session advances past the block.
 *
 * A block carries enough identity (sessionId, mailboxId, host, runtime) for
 * `agents feed` to aggregate across hosts and for `agents message` to route
 * a reply back to the right agent.
 *
 * Answer lifecycle:
 *   - A block may be answered from any surface (feed, terminal, tmux, cloud).
 *   - The first answer wins: `recordAnswer` atomically checks an answered
 *     marker so exactly one surface can claim the block.
 *   - Answered blocks stay visible until the agent consumes the message and
 *     continues, so the UI can show delivered/consumed/continued receipts.
 */
import * as fs from 'fs';
import * as path from 'path';
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

/**
 * Where an attention record came from, strongest evidence first.
 *   hook      — a harness event (AskUserQuestion / permission / notification).
 *   declared  — the agent said it is stuck (`agents feed post --blocked`).
 *   lifecycle — a structural session signal (plan handoff / permission wait).
 *   heuristic — an inferred prose question that decays.
 *   system    — a synthetic card the feed computed (runaway / needy / PR review).
 */
export type AttentionSource = 'hook' | 'declared' | 'lifecycle' | 'heuristic' | 'system';

/**
 * The lifecycle state of an attention record. A block is `open` until it is
 * answered from some surface, `answered` once a surface claimed it, `consumed`
 * once the agent read the reply, `continued` once the agent moved on, and
 * `resolved` for a terminal clear (the block file is being removed). This is the
 * axis the operator projection ranks on — only `open` needs a human.
 */
export type AttentionState = 'open' | 'answered' | 'consumed' | 'continued' | 'resolved';

/**
 * A cursor into the source that produced a block — the transcript's last write
 * (`lastActivityMs`) or a specific transcript `eventId`. It is what lets a
 * resolution tombstone say "this generation was resolved at THIS point" so a
 * stale lifecycle re-read cannot resurrect it while the session sits still, yet
 * a genuinely newer turn (a strictly later cursor) is allowed through as a new
 * generation. See {@link AttentionResolution} and `reconcileAttention`.
 */
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
  /**
   * Generation key for this block's CURRENT question. A new AskUserQuestion (or a
   * new `--blocked` post) in the same session mints a new generation, so a
   * resolution tombstone for the previous generation cannot suppress the fresh
   * ask. Derived from `ts` when a writer did not stamp it — see {@link blockGeneration}.
   */
  generation?: string;
  /** How this block came to exist. Derived from {@link kind} when absent — see {@link blockSource}. */
  source?: AttentionSource;
  /** Lifecycle state. Derived from the answer/continue markers when absent — see {@link deriveBlockState}. */
  state?: AttentionState;
  /**
   * Where in the source this block's generation sits — stamped at write time
   * (`buildDeclaredBlock`, the feed-publish hook) and carried onto its resolution
   * tombstone. Without a write-time cursor a new generation is suppressed whenever
   * `session.lastActivityMs` is unresolvable (cloud / remote / index-lag).
   */
  sourceCursor?: SourceCursor;
  /** Indexed launch origin, added at read time when the live session is known. */
  origin?: 'cli' | 'routine';
  /** Routine definition name when origin is `routine`. */
  routineName?: string;
  /** Project/repo name this block belongs to (derived from cwd, worktree-aware). */
  project?: string;
  ts: string;
  questions: BlockQuestion[];
  /**
   * How this block came to exist.
   *   question     — an AskUserQuestion the harness surfaced
   *   notification — a prompt the harness raised; `notificationType` names
   *                  which (`permission_prompt`, `elicitation_dialog`). An
   *                  `idle_prompt` is not published — it says the turn ended,
   *                  not that anything is pending (PHNX-3999); a block of that
   *                  type left on disk by an older hook is not a request either.
   *   control      — a synthetic card the feed itself computed (runaway, needy)
   *   declared     — the AGENT decided it is stuck and said so (`feed post --blocked`)
   *
   * `declared` is the only kind that does not depend on the harness noticing
   * anything. Every other kind is inferred from a harness event, and hook events
   * are not portable across harnesses (only Claude fires Notification, only Codex
   * fires PermissionRequest), so a declared block is the one signal every agent
   * can raise — it is just a shell command.
   */
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

/**
 * Why an attention generation stopped needing a human — a resolution tombstone.
 *   answered        — a surface recorded an answer.
 *   continued       — the agent consumed the answer and moved on.
 *   tool_completed  — the tool an approval gated finished (permission cleared).
 *   expired         — a decaying heuristic ask aged out.
 *   session_advanced— the transcript moved past the block (Stop/PostToolUse clear).
 */
export type ResolutionReason =
  | 'answered'
  | 'continued'
  | 'tool_completed'
  | 'expired'
  | 'session_advanced';

/**
 * A resolution tombstone. It is recorded BEFORE the open-block view is cleared so
 * a resolved generation can never silently resurrect from a stale lifecycle
 * re-read (the RUSH-1522 stale-flag class): the reconciler suppresses a
 * lifecycle candidate whose generation the tombstone already covers, until the
 * session advances strictly past `sourceCursor`. One tombstone per block id,
 * latest-wins — the block id is stable per session, so this never grows unbounded.
 */
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

/**
 * Canonical generation for a block. A writer that stamped `generation` wins;
 * otherwise the publish timestamp `ts` is the generation, because the feed
 * rewrites `ts` only when a NEW question replaces the old one (an answer/continue
 * update to the same block keeps `ts`). So `ts` changes exactly when the ask
 * changes — which is what a generation must track.
 */
export function blockGeneration(block: OpenBlock): string {
  return block.generation ?? block.ts;
}

/**
 * Canonical source for a block. A writer that stamped `source` wins; otherwise it
 * is derived from `kind`: a declared block is `declared`, a synthetic control card
 * is `system`, everything else (question / notification, written by a harness hook)
 * is `hook`.
 */
export function blockSource(block: OpenBlock): AttentionSource {
  if (block.source) return block.source;
  switch (block.kind) {
    case 'declared': return 'declared';
    case 'control': return 'system';
    default: return 'hook';
  }
}

/**
 * Canonical lifecycle state for a block. A writer that stamped `state` wins;
 * otherwise it is derived from the markers already on the block: `continuedAt`
 * means `continued`, a recorded `answer` means `answered`, and anything else is
 * still `open`. This is the ONE place that turns the historical marker fields into
 * the lifecycle axis, so no consumer re-derives it and drifts.
 */
export function deriveBlockState(block: OpenBlock): AttentionState {
  if (block.state) return block.state;
  if (block.continuedAt) return 'continued';
  if (block.answer) return 'answered';
  return 'open';
}

/**
 * Record a resolution tombstone (latest-wins per block id). Called from the
 * answer / continue / clear paths BEFORE the open-block view is removed, so the
 * reconciler always has the tombstone by the time the block file is gone.
 */
export function recordResolution(resolution: AttentionResolution, root?: string): void {
  const dir = resolutionDir(root ?? getFeedDir());
  ensureDir(dir);
  atomicWriteJsonSync(path.join(dir, `${resolution.blockId}.json`), resolution);
}

/** Read the latest resolution tombstone for a block, if one exists. */
export function readResolution(blockId: string, root?: string): AttentionResolution | undefined {
  return safeReadJson<AttentionResolution>(path.join(resolutionDir(root ?? getFeedDir()), `${blockId}.json`));
}

/** Read every resolution tombstone. Returns them sorted by stable block filename. */
export function listResolutions(root?: string): AttentionResolution[] {
  const dir = resolutionDir(root ?? getFeedDir());
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const out: AttentionResolution[] = [];
  for (const name of names.filter(n => n.endsWith('.json')).sort()) {
    const parsed = safeReadJson<Partial<AttentionResolution>>(path.join(dir, name));
    if (parsed?.blockId && parsed.generation && parsed.reason) out.push(parsed as AttentionResolution);
  }
  return out;
}

/**
 * Stable block id for a session. One block per session -- a new question
 * replaces the previous one (the agent can only ask one question at a time).
 */
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

export type RecordAnswerResult =
  | { ok: true }
  | { ok: false; existing: AnswerRecord }
  | { ok: false; unauthorized: true; reason: string };

/**
 * Atomically claim the first answer for a block. Returns `{ ok: true }` when
 * this call is the first to answer; returns `{ ok: false, existing }` when a
 * different surface already answered the block. The marker file is created
 * with `O_EXCL` so two concurrent claimers cannot both succeed.
 *
 * High-consequence blocks require a verified operator identity. Unverified
 * answers (no operatorId or not in the registry/allowed list) are refused.
 */
export function recordAnswer(
  blockId: string,
  answer: { answeredBy?: string; answeredFrom: string; operatorId?: string; verified?: boolean },
  root?: string,
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

  // Marker created successfully -- mirror the answer into the block file and
  // advance the lifecycle to `answered`. The resolution tombstone is written
  // first, so if a stale lifecycle re-read races the block-file update the
  // reconciler already refuses to resurrect this generation.
  if (block) {
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
  }
  return { ok: true };
}

/** Read the answer record for a block, if one exists. */
export function getAnswerRecord(blockId: string, root?: string): AnswerRecord | undefined {
  return safeReadJson<AnswerRecord>(path.join(answeredDir(root ?? getFeedDir()), `${blockId}.json`));
}

/**
 * Release one specific answer claim after its reply rail failed. The compare on
 * `answeredAt` makes this a conditional rollback: it can never erase a newer
 * claimant. The caller supplies the exact pre-claim block/resolution snapshots,
 * restoring the attention lifecycle to the state another surface observed.
 */
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
  fs.unlinkSync(marker);
  return true;
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

/**
 * Record a delivery-receipt transition for a message tied to a block.
 * Updates the receipts list in the block file. Status is monotonic
 * (queued → consumed → continued): a late `queued` write cannot overwrite
 * an already-recorded `consumed`/`continued` (race with mailbox drain).
 */
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
}

/** Read the receipt list for a block. */
export function getBlockReceipts(blockId: string, root?: string): MessageReceipt[] {
  return readBlock(blockId, root)?.receipts ?? [];
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

/** Convenience: record that a terminal answer closed the block. */
export function recordTerminalAnswer(blockId: string, root?: string): void {
  recordAnswer(blockId, { answeredFrom: 'terminal' }, root);
}

/** Remove answered marker and receipts for a block (used by block removal/GC). */
export function clearBlockLifecycle(blockId: string, root?: string): void {
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

export interface DeclareBlockInput {
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

/**
 * Build the block record for `agents feed post --blocked` — pure, so the shape is testable
 * without touching the store or the broadcast layer.
 *
 * Class is derived, not asked for: a `--default` means the user could be absent
 * and policy could still resolve it (approval); no default means only a human can
 * choose (decision). `feed-policy.ts` reads exactly that distinction, so deriving
 * it here keeps one rule in one place instead of letting a caller set a class that
 * contradicts its own safeDefault.
 *
 * `costOfDelay: high` because a declared block is, by definition, an agent that
 * has already stopped making progress — that is what makes it worth interrupting
 * someone over, and what `feed --dispatch`'s urgency filter keys off.
 *
 * `sourceCursor` is stamped from `ts` at write time so a fresh generation is
 * comparable even when the live session's `lastActivityMs` is unresolvable.
 */
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
  // Record a resolution tombstone BEFORE the block file and answered marker are
  // gone, so a stale lifecycle re-read of the same session cannot resurrect this
  // cleared generation. The reason names how it closed: an answered marker means
  // the operator answered, `continuedAt` means the agent moved on, otherwise the
  // transcript advanced past it (a Stop/PostToolUse clear). The tombstone itself
  // is deliberately NOT cleared — it must outlive the block to do its job.
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

/**
 * The feed-publish PreToolUse hook script (Python, mirroring 09-mailbox-inject.py).
 * Embedded so it ships with the compiled CLI and can be installed to the
 * CLI-writable user hooks dir without a separate file in the npm tarball.
 */
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

/** Manifest entry for the feed-publish hook, matching the ManifestHook shape. */
export const FEED_PUBLISH_HOOK_MANIFEST = {
  name: 'feed-publish',
  events: ['PreToolUse'],
  matcher: 'AskUserQuestion',
  script: '10-feed-publish.py',
  timeout: 5,
};

export const FEED_NOTIFICATION_HOOK_MANIFEST = {
  name: 'feed-publish-notification',
  events: ['Notification'],
  matcher: 'permission_prompt|elicitation_dialog',
  script: '10-feed-publish.py',
  timeout: 5,
};

// Codex fires PermissionRequest (not Claude's Notification) when it blocks on an
// approval prompt. The same script handles it, publishing a high-cost approval
// block so the feed dispatch pages the phone. PermissionRequest has no matcher.
export const FEED_PERMISSION_HOOK_MANIFEST = {
  name: 'feed-publish-permission',
  events: ['PermissionRequest'],
  script: '10-feed-publish.py',
  timeout: 5,
};

export const FEED_ANSWERED_HOOK_MANIFEST = {
  name: 'feed-clear-answered',
  events: ['PostToolUse'],
  matcher: 'AskUserQuestion',
  script: '10-feed-publish.py',
  timeout: 5,
};

export const FEED_LIFECYCLE_HOOK_MANIFEST = {
  name: 'feed-clear-lifecycle',
  events: ['Stop', 'UserPromptSubmit', 'SessionEnd'],
  script: '10-feed-publish.py',
  timeout: 5,
};

/**
 * Install the feed-publish hook script into the user hooks dir and add its
 * manifest entry to the user agents.yaml. The system repo is an auto-pulled,
 * read-only mirror, so runtime-managed hooks must never write there.
 * Idempotent -- skips if the script is already present and up to date.
 */
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
      // Matcher-less PostToolUse clear: after Codex runs an approved tool, the
      // approval card is stale, so clear it. Codex-only on purpose -- Claude
      // never fires PermissionRequest, so it has no approval card to clear here,
      // and a matcher-less PostToolUse for Claude would (1) re-run the script on
      // every tool completion and (2) wipe Claude's notification-kind blocks
      // (permission_prompt/elicitation_dialog) the moment any later
      // tool runs, instead of letting them persist to Stop/SessionEnd like they
      // did before RUSH-2039. Registering it for codex alone keeps Claude's
      // card lifetime exactly as it was.
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
      // `flowCollectionPadding: false` matches the committed formatting. The yaml
      // emitter defaults to padded flow sequences (`[ a, b ]`), but the tracked
      // `agents.yaml` uses `[a, b]`. Re-emitting a committed flow node (e.g. a
      // notify hook's `command: [agents, notify, "{message}"]`) with padding left
      // the git-backed `~/.agents` tree permanently dirty on this file, so
      // `agents repo pull` refused and seven boxes silently fell 37-52 commits
      // behind fleet-wide (RUSH-2505). Preserve each node's committed block/flow
      // style — do NOT force `collectionStyle`, which would flatten a committed
      // flow hook to a block list and reintroduce a diff.
      fs.writeFileSync(tmpYaml, stringifyDoc(yamlDoc));
      fs.renameSync(tmpYaml, agentsYamlPath);
    }

    return { installed };
  } catch (err) {
    return { installed: false, error: (err as Error).message };
  }
}
