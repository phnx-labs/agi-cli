import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { getMailboxRootDir } from './state.js';
import { recordMessageReceipt } from './feed/feed.js';
import { parseDuration } from './hooks/cache.js';

export const DEFAULT_TTL_SECONDS = 24 * 60 * 60;

export const MAILBOX_TTL_ENV = 'AGENTS_MAILBOX_TTL';

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

export interface MailboxMessage {
  msgId: string;
  to: string;
  from?: string;
  ts: string;
  expiresAt?: string;
  text: string;
  blockId?: string;
  generation?: string;
  attempt?: string;
  dropped?: string;
}

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

export function mailboxDir(mailboxId: string, root: string = getMailboxRootDir()): string {
  assertValidMailboxId(mailboxId);
  return path.join(root, mailboxId);
}

function inboxDir(boxDir: string): string { return path.join(boxDir, 'inbox'); }
function processingDir(boxDir: string): string { return path.join(boxDir, 'processing'); }
function consumedDir(boxDir: string): string { return path.join(boxDir, 'consumed'); }

function ensureDirs(boxDir: string): void {
  fs.mkdirSync(inboxDir(boxDir), { recursive: true });
  fs.mkdirSync(processingDir(boxDir), { recursive: true });
  fs.mkdirSync(consumedDir(boxDir), { recursive: true });
}

let seq = 0;

function newMsgId(): string {

  const s = String(seq++).padStart(6, '0');
  return `${Date.now()}-${s}-${randomUUID().slice(0, 8)}`;
}

export function enqueue(boxDir: string, msg: { to: string; text: string; from?: string; blockId?: string; generation?: string; attempt?: string; ttlSeconds?: number }): string {
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
    ...(msg.generation !== undefined ? { generation: msg.generation } : {}),
    ...(msg.attempt !== undefined ? { attempt: msg.attempt } : {}),
  };
  const ttlSeconds = msg.ttlSeconds ?? resolveDefaultTtlSeconds();
  if (ttlSeconds > 0) {
    record.expiresAt = new Date(now.getTime() + ttlSeconds * 1000).toISOString();
  }
  const target = path.join(inboxDir(boxDir), `${msgId}.json`);
  const tmp = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(record, null, 2), 'utf-8');
  fs.renameSync(tmp, target);
  return msgId;
}

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
  return {
    msgId: m.msgId, to: m.to, from: m.from, ts: m.ts ?? '', text: m.text,
    expiresAt: m.expiresAt, blockId: m.blockId, generation: m.generation, attempt: m.attempt,
    dropped: m.dropped,
  };
}

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
      fs.renameSync(src, dest);
    }
  } catch {
  }
}

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
            }
          }
          n++;
        } catch {
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

function consumeClaimed(boxDir: string, name: string, expectedTo: string): MailboxMessage | null {
  const src = path.join(processingDir(boxDir), name);
  const dest = path.join(consumedDir(boxDir), name);
  const msg = readMessage(src);
  try {
    fs.renameSync(src, dest);
  } catch {
    return null;
  }
  if (!msg || msg.to !== expectedTo) return null;
  if (msg.blockId) {
    try {
      const feedRoot = process.env.AGENTS_FEED_DIR;
      recordMessageReceipt(msg.blockId, {
        msgId: msg.msgId, status: 'consumed', at: new Date().toISOString(), from: msg.from,
        ...(msg.generation !== undefined ? { generation: msg.generation } : {}),
        ...(msg.attempt !== undefined ? { attempt: msg.attempt } : {}),
      }, feedRoot);
    } catch {
    }
  }
  return msg;
}

export function drain(boxDir: string, boxId: string = path.basename(boxDir), now: Date = new Date()): MailboxMessage[] {

  ensureDirs(boxDir);
  sweepExpired(boxDir, boxId, now);
  const out: MailboxMessage[] = [];

  for (const name of jsonFiles(processingDir(boxDir))) {
    const msg = consumeClaimed(boxDir, name, boxId);
    if (msg) out.push(msg);
  }

  for (const name of jsonFiles(inboxDir(boxDir))) {
    const from = path.join(inboxDir(boxDir), name);
    const to = path.join(processingDir(boxDir), name);
    try {
      fs.renameSync(from, to);
    } catch {
      continue;
    }
    const msg = consumeClaimed(boxDir, name, boxId);
    if (msg) out.push(msg);
  }

  return out;
}

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

export function clear(boxDir: string): number {
  let n = 0;
  for (const name of jsonFiles(inboxDir(boxDir))) {
    try {
      fs.unlinkSync(path.join(inboxDir(boxDir), name));
      n++;
    } catch {
    }
  }
  return n;
}

export type MailboxState = 'inbox' | 'processing' | 'consumed';

export interface StoredMessage extends MailboxMessage {
  state: MailboxState;
}

export interface CommsMsg {
  from: string;
  to: string;
  toLabel: string;
  ts: string;
  text: string;
  state: MailboxState;
  box: string;
}

export function listBoxes(root: string = getMailboxRootDir()): string[] {
  let names: string[];
  try {
    names = fs.readdirSync(root);
  } catch {
    return [];
  }
  return names.filter((n) => isValidMailboxId(n) && fs.statSync(path.join(root, n)).isDirectory()).sort();
}

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
