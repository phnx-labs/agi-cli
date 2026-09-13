/**
 * Agent mailbox — a file-spool that lets a message reach an already-running
 * agent mid-flight. One box per logical agent, keyed by a unique-per-launch id
 * (session UUID / teams agentId / loop runId), so boxes are disjoint and a
 * message can never reach the wrong agent (see docs / plan velvety-conjuring-popcorn).
 *
 * Layout: <root>/<mailboxId>/{inbox,processing,consumed}/<msgId>.json
 *   inbox/      pending, written by `agents message`
 *   processing/ claimed by a drain (claim-first = crash-safe)
 *   consumed/   archived after delivery (and dropped mismatches)
 *
 * A box has a SINGLE consumer — the owning agent, whose tool calls (and thus
 * hook-driven drains) are sequential. Writers may be concurrent; each enqueue
 * is atomic (temp-write + rename), so a drain never observes a partial file.
 * Delivery is at-least-once: an interrupted drain leaves the message in
 * processing/, and the next drain recovers it. Consumers dedup by `msgId`.
 */
import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { getMailboxRootDir } from './state.js';
import { recordMessageReceipt } from './feed/feed.js';
import { parseDuration } from './hooks/cache.js';

/** Default delivery TTL for messages enqueued without an explicit one (24 hours). */
export const DEFAULT_TTL_SECONDS = 24 * 60 * 60;

/** Env var that overrides {@link DEFAULT_TTL_SECONDS} with a duration like "24h" or "3600". */
export const MAILBOX_TTL_ENV = 'AGENTS_MAILBOX_TTL';

/**
 * Resolve the default mailbox TTL in seconds. Honors `AGENTS_MAILBOX_TTL`
 * (parsed by {@link parseDuration}); falls back to 24h. A malformed env value
 * fails loud instead of silently disabling expiry.
 */
function resolveDefaultTtlSeconds(): number {
  const raw = process.env[MAILBOX_TTL_ENV];
  if (raw == null || raw === '') return DEFAULT_TTL_SECONDS;
  const parsed = parseDuration(raw);
  if (parsed == null || parsed <= 0) {
    throw new Error(
      `Invalid ${MAILBOX_TTL_ENV}=${JSON.stringify(raw)}: expected a positive duration (e.g. 24h, 30m, 3600).`,
    );
  }
  return parsed;
}

/** A single mailbox message. `text` may embed `host:/path` clip tokens. */
export interface MailboxMessage {
  /** Unique, time-sortable id. Also the on-disk filename stem. */
  msgId: string;
  /** The mailboxId this message is addressed to (anti-misroute stamp). */
  to: string;
  /** Who sent it (operator label / agent id / host). Optional. */
  from?: string;
  /** ISO-8601 creation time. */
  ts: string;
  /** Optional ISO-8601 expiry time. Expired messages are dropped, not delivered. */
  expiresAt?: string;
  /** The message body. */
  text: string;
  /**
   * The feed block this message answers. Set by `agents message` when the
   * target has an open block, so the drain can surface consumed/continued
   * receipts back to the feed store.
   */
  blockId?: string;
  /**
   * Drop reason when a message is archived without delivery (expired, dead box, etc.).
   * Set by the TTL/liveness layer, not by writers.
   */
  dropped?: string;
}

/**
 * A mailboxId must be a single, separator-free path segment. Real ids (session
 * UUID / teams agentId / loop runId) already satisfy this; rejecting anything
 * else fails loud instead of silently misrouting — a message whose id contained
 * a `/` would nest under a different dir than the `to` stamp it is matched
 * against, and would be dropped with no error. Also blocks `.`/`..` traversal
 * once `agents message` starts accepting external target ids.
 */
export function isValidMailboxId(mailboxId: string): boolean {
  return /^[A-Za-z0-9._-]+$/.test(mailboxId) && mailboxId !== '.' && mailboxId !== '..';
}

export function assertValidMailboxId(mailboxId: string): void {
  if (!isValidMailboxId(mailboxId)) {
    throw new Error(
      `Invalid mailboxId ${JSON.stringify(mailboxId)}: must be a single path segment ` +
      `matching [A-Za-z0-9._-] (no separators, not '.'/'..').`,
    );
  }
}

/** Absolute path to a box. `root` override is for tests. */
export function mailboxDir(mailboxId: string, root: string = getMailboxRootDir()): string {
  assertValidMailboxId(mailboxId);
  return path.join(root, mailboxId);
}

function inboxDir(boxDir: string): string { return path.join(boxDir, 'inbox'); }
function processingDir(boxDir: string): string { return path.join(boxDir, 'processing'); }
function consumedDir(boxDir: string): string { return path.join(boxDir, 'consumed'); }

/** Create the three sub-buckets. Idempotent. */
function ensureDirs(boxDir: string): void {
  fs.mkdirSync(inboxDir(boxDir), { recursive: true });
  fs.mkdirSync(processingDir(boxDir), { recursive: true });
  fs.mkdirSync(consumedDir(boxDir), { recursive: true });
}

let seq = 0;

/**
 * `<epochMs>-<seq>-<rand>` — sorts by filename in FIFO order. The per-process
 * monotonic `seq` breaks ties within the same millisecond (so a single writer's
 * order is preserved); `rand` keeps it unique across processes/hosts.
 */
function newMsgId(): string {
  const s = String(seq++).padStart(6, '0');
  return `${Date.now()}-${s}-${randomUUID().slice(0, 8)}`;
}

/**
 * Enqueue a message into `boxDir` atomically. Returns the msgId. The `to` field
 * is stamped so a drain can refuse a message that lands in the wrong box.
 */
export function enqueue(boxDir: string, msg: { to: string; text: string; from?: string; blockId?: string; ttlSeconds?: number }): string {
  assertValidMailboxId(msg.to);
  ensureDirs(boxDir);
  const msgId = newMsgId();
  const now = new Date();
  const record: MailboxMessage = {
    msgId,
    to: msg.to,
    from: msg.from,
    ts: now.toISOString(),
    text: msg.text,
    blockId: msg.blockId,
  };
  const ttlSeconds = msg.ttlSeconds ?? resolveDefaultTtlSeconds();
  if (ttlSeconds > 0) {
    record.expiresAt = new Date(now.getTime() + ttlSeconds * 1000).toISOString();
  }
  const target = path.join(inboxDir(boxDir), `${msgId}.json`);
  const tmp = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(record, null, 2), 'utf-8');
  fs.renameSync(tmp, target); // atomic on a single filesystem
  return msgId;
}

/** Parse a message file. Returns null on missing/corrupt/invalid-shape. */
export function readMessage(file: string): MailboxMessage | null {
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf-8');
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const m = parsed as Partial<MailboxMessage>;
  if (typeof m?.msgId !== 'string' || typeof m?.to !== 'string' || typeof m?.text !== 'string') {
    return null;
  }
  return { msgId: m.msgId, to: m.to, from: m.from, ts: m.ts ?? '', text: m.text, expiresAt: m.expiresAt, blockId: m.blockId, dropped: m.dropped };
}

/** True when a message has a parsed expiry in the past. */
export function isExpired(msg: MailboxMessage, now: Date = new Date()): boolean {
  if (!msg.expiresAt) return false;
  const ts = Date.parse(msg.expiresAt);
  return !Number.isNaN(ts) && ts <= now.getTime();
}

function archiveDropped(boxDir: string, name: string, reason: string): void {
  const src = path.join(inboxDir(boxDir), name);
  const dest = path.join(consumedDir(boxDir), name);
  try {
    const msg = readMessage(src);
    if (msg) {
      msg.dropped = reason;
      fs.writeFileSync(`${dest}.tmp`, JSON.stringify(msg, null, 2), 'utf-8');
      fs.renameSync(`${dest}.tmp`, dest);
      fs.unlinkSync(src);
    } else {
      // corrupt — just move it out of inbox
      fs.renameSync(src, dest);
    }
  } catch {
    // best-effort
  }
}

/**
 * Move expired messages from inbox/ and processing/ into consumed/ with a
 * `dropped: expired` marker. Called by drain/peek before returning messages.
 *
 * When a dropped message carries a `blockId`, a failure receipt is surfaced
 * back to the feed store so the sender sees the bounce.
 */
export function sweepExpired(
  boxDir: string,
  boxId: string = path.basename(boxDir),
  now: Date = new Date(),
  feedRoot?: string,
): number {
  ensureDirs(boxDir);
  let n = 0;
  for (const dir of [inboxDir(boxDir), processingDir(boxDir)]) {
    for (const name of jsonFiles(dir)) {
      const msg = readMessage(path.join(dir, name));
      if (msg && msg.to === boxId && isExpired(msg, now)) {
        try {
          const dest = path.join(consumedDir(boxDir), name);
          msg.dropped = 'expired';
          const tmp = `${dest}.${process.pid}.tmp`;
          fs.writeFileSync(tmp, JSON.stringify(msg, null, 2), 'utf-8');
          fs.renameSync(tmp, dest);
          fs.unlinkSync(path.join(dir, name));
          if (msg.blockId) {
            try {
              recordMessageReceipt(
                msg.blockId,
                { msgId: msg.msgId, status: 'expired', at: new Date().toISOString(), from: msg.from },
                feedRoot ?? process.env.AGENTS_FEED_DIR,
              );
            } catch {
              // Receipt surfacing is best-effort; never stall expiry.
            }
          }
          n++;
        } catch {
          // ignore racing claimers
        }
      }
    }
  }
  return n;
}

function jsonFiles(dir: string): string[] {
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  return names.filter((n) => n.endsWith('.json')).sort();
}

/**
 * Consume a file already sitting in `processing/`: read, verify it is addressed
 * to this box, then archive to `consumed/`. Returns the message iff valid AND
 * addressed here; a mismatched/corrupt file is archived (dropped) so it never
 * loops. Returns null when the file vanished (a racing drain took it).
 *
 * When the message carries a `blockId`, the consumed event is surfaced back to
 * the feed store so the operator can see delivery confirmation.
 */
function consumeClaimed(boxDir: string, name: string, expectedTo: string): MailboxMessage | null {
  const src = path.join(processingDir(boxDir), name);
  const dest = path.join(consumedDir(boxDir), name);
  const msg = readMessage(src);
  try {
    fs.renameSync(src, dest);
  } catch {
    return null; // already archived/claimed elsewhere
  }
  if (!msg || msg.to !== expectedTo) return null; // dropped (corrupt or wrong box)
  if (msg.blockId) {
    try {
      const feedRoot = process.env.AGENTS_FEED_DIR;
      recordMessageReceipt(msg.blockId, { msgId: msg.msgId, status: 'consumed', at: new Date().toISOString(), from: msg.from }, feedRoot);
    } catch {
      // Receipt surfacing is best-effort; never stall delivery.
    }
  }
  return msg;
}

/**
 * Drain the box: return every pending message addressed to it, in FIFO order,
 * removing them from the queue. Claim-first (inbox → processing → consumed) so
 * an interrupted drain is recovered on the next call (at-least-once). Corrupt
 * files and messages addressed to a different box are dropped, not returned.
 *
 * `boxId` defaults to the box's directory name — the id it was created under.
 */
export function drain(boxDir: string, boxId: string = path.basename(boxDir), now: Date = new Date()): MailboxMessage[] {
  ensureDirs(boxDir);
  sweepExpired(boxDir, boxId, now);
  const out: MailboxMessage[] = [];

  // 1. Recover orphans left in processing/ by a prior interrupted drain.
  for (const name of jsonFiles(processingDir(boxDir))) {
    const msg = consumeClaimed(boxDir, name, boxId);
    if (msg) out.push(msg);
  }

  // 2. Claim and consume pending inbox messages.
  for (const name of jsonFiles(inboxDir(boxDir))) {
    const from = path.join(inboxDir(boxDir), name);
    const to = path.join(processingDir(boxDir), name);
    try {
      fs.renameSync(from, to); // atomic claim
    } catch {
      continue; // vanished — a racing drain took it
    }
    const msg = consumeClaimed(boxDir, name, boxId);
    if (msg) out.push(msg);
  }

  return out;
}

/** Read pending messages (inbox + in-flight) without consuming them. FIFO. */
export function peek(boxDir: string, boxId: string = path.basename(boxDir), now: Date = new Date()): MailboxMessage[] {
  sweepExpired(boxDir, boxId, now);
  const out: MailboxMessage[] = [];
  for (const dir of [processingDir(boxDir), inboxDir(boxDir)]) {
    for (const name of jsonFiles(dir)) {
      const msg = readMessage(path.join(dir, name));
      if (msg && msg.to === boxId) out.push(msg);
    }
  }
  return out;
}

/** Delete pending (not-yet-claimed) inbox messages. Returns the count removed. */
export function clear(boxDir: string): number {
  let n = 0;
  for (const name of jsonFiles(inboxDir(boxDir))) {
    try {
      fs.unlinkSync(path.join(inboxDir(boxDir), name));
      n++;
    } catch {
      // already gone — ignore
    }
  }
  return n;
}

/** Which bucket a stored message currently sits in. */
export type MailboxState = 'inbox' | 'processing' | 'consumed';

/** A message read back from a box, tagged with the bucket it was found in. */
export interface StoredMessage extends MailboxMessage {
  state: MailboxState;
}

/** A stored message enriched with the mailbox identity used by comms renderers. */
export interface CommsMsg {
  from: string;
  to: string;
  toLabel: string;
  ts: string;
  text: string;
  state: MailboxState;
  box: string;
}

/**
 * Enumerate the box ids under `root` (directory names that are valid mailbox
 * ids). Read-only; does not create the root. Sorted for stable output.
 */
export function listBoxes(root: string = getMailboxRootDir()): string[] {
  let names: string[];
  try {
    names = fs.readdirSync(root);
  } catch {
    return [];
  }
  return names.filter((n) => isValidMailboxId(n) && fs.statSync(path.join(root, n)).isDirectory()).sort();
}

/**
 * Read every message in a box across all three buckets (inbox, processing,
 * consumed) WITHOUT consuming, sweeping, or archiving anything. Unlike `peek`,
 * this includes `consumed/` — the delivered history — so callers can surface a
 * communication log. Each row is tagged with its bucket. Sorted FIFO by msgId
 * (which is time-sortable), oldest first.
 */
export function readBox(boxDir: string): StoredMessage[] {
  const out: StoredMessage[] = [];
  const buckets: [string, MailboxState][] = [
    [inboxDir(boxDir), 'inbox'],
    [processingDir(boxDir), 'processing'],
    [consumedDir(boxDir), 'consumed'],
  ];
  for (const [dir, state] of buckets) {
    for (const name of jsonFiles(dir)) {
      const msg = readMessage(path.join(dir, name));
      if (msg) out.push({ ...msg, state });
    }
  }
  out.sort((a, b) => (a.msgId < b.msgId ? -1 : a.msgId > b.msgId ? 1 : 0));
  return out;
}

/**
 * Poll the complete spool and yield each message once when its box/msgId pair
 * first appears. Existing messages establish the initial baseline unless
 * `backfill` is requested; moving a message between buckets does not re-emit it.
 */
export async function* watchMessages(
  root: string,
  opts: { signal?: AbortSignal; intervalMs?: number; backfill?: boolean },
): AsyncGenerator<CommsMsg> {
  const seen = new Set<string>();
  const requestedInterval = opts.intervalMs ?? 500;
  const intervalMs = Number.isFinite(requestedInterval) ? Math.max(1, requestedInterval) : 500;
  let firstPoll = true;

  while (!opts.signal?.aborted) {
    const fresh: Array<{ key: string; message: CommsMsg }> = [];
    for (const box of listBoxes(root)) {
      for (const stored of readBox(mailboxDir(box, root))) {
        const key = `${box}\0${stored.msgId}`;
        if (seen.has(key)) continue;
        seen.add(key);
        if (firstPoll && !opts.backfill) continue;
        fresh.push({
          key,
          message: {
            from: stored.from || 'operator',
            to: stored.to,
            toLabel: box.slice(0, 8),
            ts: stored.ts,
            text: stored.text,
            state: stored.state,
            box,
          },
        });
      }
    }
    firstPoll = false;

    fresh.sort((a, b) =>
      compareWatched(a.message.ts, b.message.ts) ||
      compareWatched(a.key, b.key));
    for (const { message } of fresh) {
      if (opts.signal?.aborted) return;
      yield message;
    }

    if (!await waitForMailboxPoll(intervalMs, opts.signal)) return;
  }
}

function compareWatched(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Wait for the next poll, resolving immediately when the watcher is aborted. */
function waitForMailboxPoll(intervalMs: number, signal?: AbortSignal): Promise<boolean> {
  if (signal?.aborted) return Promise.resolve(false);
  return new Promise((resolve) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let settled = false;
    const finish = (keepWatching: boolean) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      resolve(keepWatching);
    };
    const onAbort = () => finish(false);
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) {
      finish(false);
      return;
    }
    timer = setTimeout(() => finish(true), intervalMs);
  });
}
