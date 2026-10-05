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
  context?: string;
}

export interface MessageReceipt {
  msgId: string;
  status: 'queued' | 'consumed' | 'continued' | 'dropped' | 'expired';
  at: string;
  from?: string;
  generation?: string;
  attempt?: string;
}

export interface ReceiptOrigin {
  generation: string;
  attempt: string;
}

export function receiptMatchesOrigin(receipt: MessageReceipt, origin: ReceiptOrigin): boolean {

  if (receipt.generation === undefined) return false;
  return receipt.generation === origin.generation;
}

export interface AnswerRecord {
  answeredAt: string;
  answeredFrom: string;
  answeredBy?: string;
  operatorId?: string;
  verified?: boolean;
}

export type AttentionSource = 'hook' | 'declared' | 'lifecycle' | 'heuristic' | 'system';

export type AttentionState = 'open' | 'answered' | 'consumed' | 'continued' | 'resolved';

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
  generation?: string;
  source?: AttentionSource;
  state?: AttentionState;
  sourceCursor?: SourceCursor;
  origin?: 'cli' | 'routine';
  routineName?: string;
  project?: string;
  ts: string;
  questions: BlockQuestion[];
  kind?: 'question' | 'notification' | 'control' | 'declared';
  notificationType?: string;
  ticket?: string;
  pr?: string;
  worktreeSlug?: string;
  epic?: string;
  blockClass?: 'approval' | 'decision';
  consequence?: 'normal' | 'high' | string;
  allowedOperators?: string[];
  timeoutMinutes?: number;
  safeDefault?: string;
  costOfDelay?: 'low' | 'medium' | 'high';
  downstreamAgents?: number;
  delayRank?: {
    score: number;
    idleMinutes: number;
    blastRadius: number;
    burnUsdPerHour: number;
    decisionIrreducibility: number;
  };
  runaway?: {
    reason: string;
    tokPerSec?: number;
    burnUsdPerHour?: number;
    relaunchesPerTenMinutes?: number;
  };
  needy?: {
    askCountLastHour: number;
    threshold: number;
    totalAskCount: number;
  };
  answer?: AnswerRecord;
  receipts?: MessageReceipt[];
  continuedAt?: string;
  notifiedAt?: string;
  defaultedAt?: string;
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

export type ResolutionReason =
  | 'answered'
  | 'continued'
  | 'tool_completed'
  | 'expired'
  | 'session_advanced';

export interface AttentionResolution {
  blockId: string;
  generation: string;
  resolvedAt: string;
  sourceCursor?: SourceCursor;
  reason: ResolutionReason;
}

function resolutionDir(root: string): string { return path.join(root, 'resolutions'); }

export function blockGeneration(block: OpenBlock): string {
  return block.generation ?? block.ts;
}

export function blockSource(block: OpenBlock): AttentionSource {
  if (block.source) return block.source;
  switch (block.kind) {
    case 'declared': return 'declared';
    case 'control': return 'system';
    default: return 'hook';
  }
}

export function deriveBlockState(block: OpenBlock): AttentionState {
  if (block.state) return block.state;
  if (block.continuedAt) return 'continued';
  if (block.answer) return 'answered';
  return 'open';
}

export function recordResolution(resolution: AttentionResolution, root?: string): void {
  const dir = resolutionDir(root ?? getFeedDir());
  ensureDir(dir);
  atomicWriteJsonSync(path.join(dir, `${resolution.blockId}.json`), resolution);
}

export function readResolution(blockId: string, root?: string): AttentionResolution | undefined {
  return safeReadJson<AttentionResolution>(path.join(resolutionDir(root ?? getFeedDir()), `${blockId}.json`));
}

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

export function readBlock(blockId: string, root?: string): OpenBlock | undefined {
  const parsed = safeReadJson<Partial<OpenBlock>>(blockPath(root ?? getFeedDir(), blockId));
  if (!parsed || !parsed.blockId || !parsed.sessionId || !parsed.questions?.length) return undefined;
  return parsed as OpenBlock;
}

type RecordAnswerResult =
  | { ok: true }
  | { ok: false; existing: AnswerRecord }
  | { ok: false; unauthorized: true; reason: string };

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

export function confirmAnswerResolution(
  blockId: string,
  root?: string,
  expected?: { generation: string; answeredAt: string },
): boolean {
  const dir = root ?? getFeedDir();
  const block = readBlock(blockId, dir);
  const record = getAnswerRecord(blockId, dir);
  if (!block || !record) return false;
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

export function getAnswerRecord(blockId: string, root?: string): AnswerRecord | undefined {
  return safeReadJson<AnswerRecord>(path.join(answeredDir(root ?? getFeedDir()), `${blockId}.json`));
}

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

  const release = path.join(answeredDir(dir), `${blockId}.${answeredAt.replace(/[^0-9A-Za-z]/g, '')}.release`);
  if (!acquireReleaseToken(release)) return false;
  const dropToken = (): void => {
    try { fs.unlinkSync(release); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  };
  const held = safeReadJson<AnswerRecord>(marker);
  if (!held || held.answeredAt !== answeredAt) { dropToken(); return false; }

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
  dropToken();
  return true;
}

export const RELEASE_TOKEN_STALE_MS = 60_000;

function acquireReleaseToken(release: string): boolean {
  const mine = { pid: process.pid, host: os.hostname(), at: Date.now() };
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
    try { process.kill(held.pid, 0); } catch { ownerGone = true; }
  }
  if (!ownerGone && ageMs < RELEASE_TOKEN_STALE_MS) return false;
  try { fs.unlinkSync(release); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  return create();
}

export function isBlockAnswered(blockId: string, root?: string): boolean {
  return fs.existsSync(path.join(answeredDir(root ?? getFeedDir()), `${blockId}.json`));
}

const RECEIPT_STATUS_RANK: Record<MessageReceipt['status'], number> = {
  queued: 0,
  consumed: 1,
  continued: 2,
  dropped: 3,
  expired: 3,
};

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
      return;
    }
    receipts[idx] = receipt;
  } else {
    receipts.push(receipt);
  }
  block.receipts = receipts;
  publishBlock(block, dir);

  if ((receipt.status === 'consumed' || receipt.status === 'continued')
    && receipt.generation !== undefined && block.answer) {
    confirmAnswerResolution(blockId, dir, {
      generation: receipt.generation, answeredAt: block.answer.answeredAt,
    });
  }
}

export function getBlockReceipts(blockId: string, root?: string): MessageReceipt[] {
  return readBlock(blockId, root)?.receipts ?? [];
}

export function latestMessageReceipt(
  blockId: string, root?: string, origin?: ReceiptOrigin,
): MessageReceipt | undefined {
  const all = getBlockReceipts(blockId, root);
  const receipts = origin ? all.filter((receipt) => receiptMatchesOrigin(receipt, origin)) : all;
  let best: MessageReceipt | undefined;
  for (const receipt of receipts) {
    if (!best) { best = receipt; continue; }
    const rank = RECEIPT_STATUS_RANK[receipt.status] - RECEIPT_STATUS_RANK[best.status];
    if (rank > 0 || (rank === 0 && receipt.at >= best.at)) best = receipt;
  }
  return best;
}

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

export function recordParked(blockId: string, root?: string): void {
  const dir = root ?? getFeedDir();
  const block = readBlock(blockId, dir);
  if (!block) return;
  block.parkedAt = new Date().toISOString();
  publishBlock(block, dir);
}

export function recordDefaulted(blockId: string, root?: string): void {
  const dir = root ?? getFeedDir();
  const block = readBlock(blockId, dir);
  if (!block) return;
  block.defaultedAt = new Date().toISOString();
  publishBlock(block, dir);
}

export function recordNotified(blockId: string, root?: string): void {
  const dir = root ?? getFeedDir();
  const block = readBlock(blockId, dir);
  if (!block) return;
  block.notifiedAt = new Date().toISOString();
  publishBlock(block, dir);
}

function clearBlockLifecycle(blockId: string, root?: string): void {
  const dir = root ?? getFeedDir();
  for (const sub of [answeredDir(dir), receiptDir(dir)]) {
    try {
      fs.unlinkSync(path.join(sub, `${blockId}.json`));
    } catch {
    }
  }
}

export interface DeclaringAgent {
  sessionId: string;
  mailboxId: string;
  host: string;
  runtime: string;
  cwd?: string;
}

interface DeclareBlockInput {
  text: string;
  options?: string[];
  safeDefault?: string;
  timeoutMinutes?: number;
  ts?: string;
}

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
    generation: ts,
    source: 'declared',
    state: 'open',
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

export function publishBlock(block: OpenBlock, root?: string): void {
  const dir = root ?? getFeedDir();
  fs.mkdirSync(dir, { recursive: true });
  const target = blockPath(dir, block.blockId);
  atomicWriteJsonSync(target, block);
}

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
    }
  }
  return blocks;
}

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

export function removeBlock(blockId: string, root?: string): boolean {
  const dir = root ?? getFeedDir();
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

WAITING_NOTIFICATION_TYPES = {
    "permission_prompt",
    "elicitation_dialog",
}
CLEAR_EVENTS = {
    "PostToolUse",
    "Stop",
    "SessionEnd",
}


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
        try:
            with open(target) as existing_file:
                existing = json.load(existing_file)
            answered = os.path.exists(os.path.join(answered_dir, f"{block_id}.json"))

            # Ordinary lifecycle hooks cannot clear a declared block before it is answered.
            if existing.get("kind") == "declared" and not answered:
                return
        except Exception:
            pass
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
        try:
            os.unlink(os.path.join(answered_dir, f"{block_id}.json"))
        except FileNotFoundError:
            pass
        except Exception:
            pass
        return

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
        "sourceCursor": {"lastActivityMs": now_ms},
        "questions": normalized_questions,
        "kind": kind,
    }
    if project:
        block["project"] = project
    if notification_type:
        block["notificationType"] = notification_type

    if codex_approval:
        block["blockClass"] = "approval"
        block["costOfDelay"] = "high"
        block["safeDefault"] = "deny"

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

    try:
        os.unlink(os.path.join(answered_dir, f"{block_id}.json"))
    except FileNotFoundError:
        pass
    except Exception:
        pass

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
        pass
`;

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
      'feed-publish-notification': {
        agents: ['claude', 'codex'],
        events: ['Notification'],
        matcher: 'permission_prompt|elicitation_dialog',
        script: '10-feed-publish.py',
        timeout: 5,
      },
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
      fs.writeFileSync(tmpYaml, stringifyDoc(yamlDoc));
      fs.renameSync(tmpYaml, agentsYamlPath);
    }

    return { installed };
  } catch (err) {
    return { installed: false, error: (err as Error).message };
  }
}
