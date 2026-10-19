import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomBytes } from 'node:crypto';
import { atomicWriteJsonSync } from '../fs-atomic.js';
import { confirmsDir, ensureLeadRoot } from './paths.js';

export const CONFIRM_TTL_MS = 10 * 60 * 1000;

const TOKEN_RE = /^c_[0-9a-f]{16}$/;

export const CONFIRM_ACTIONS = ['stop', 'answer', 'send', 'start', 'dispatch', 'pr'] as const;
export type ConfirmAction = typeof CONFIRM_ACTIONS[number];

export interface HeldAction {
  project: string;
  action: ConfirmAction;
  argv: string[];
  label: string;
  detail?: string;
  sessionId?: string;
  linearArgv?: string[];
}

export interface ConfirmRecord extends HeldAction {
  token: string;
  createdAtMs: number;
  expiresAtMs: number;
}

export class ConfirmError extends Error {
  constructor(message: string, readonly reason: 'invalid' | 'unknown' | 'expired') {
    super(message);
  }
}

function tokenPath(token: string): string {
  return path.join(confirmsDir(), `${token}.json`);
}

export function mintConfirm(input: HeldAction, nowMs = Date.now()): ConfirmRecord {
  ensureLeadRoot();
  fs.mkdirSync(confirmsDir(), { recursive: true, mode: 0o700 });
  const record: ConfirmRecord = {
    token: `c_${randomBytes(8).toString('hex')}`,
    ...input,
    createdAtMs: nowMs,
    expiresAtMs: nowMs + CONFIRM_TTL_MS,
  };
  atomicWriteJsonSync(tokenPath(record.token), record);
  return record;
}

export function claimConfirm(token: string, nowMs = Date.now()): ConfirmRecord {
  if (!TOKEN_RE.test(token)) throw new ConfirmError(`'${token}' is not a confirm token (expected c_ and 16 hex characters).`, 'invalid');
  const file = tokenPath(token);
  const claimed = `${file}.claimed-${process.pid}`;
  try {
    fs.renameSync(file, claimed);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new ConfirmError(`Confirm token ${token} is unknown or was already used.`, 'unknown');
    }
    throw err;
  }
  const record = JSON.parse(fs.readFileSync(claimed, 'utf-8')) as ConfirmRecord;
  fs.unlinkSync(claimed);
  if (nowMs > record.expiresAtMs) {
    throw new ConfirmError(`Confirm token ${token} expired ${Math.round((nowMs - record.expiresAtMs) / 1000)}s ago; ask the Lead again.`, 'expired');
  }
  return record;
}

export function sweepExpiredConfirms(nowMs = Date.now()): number {
  let names: string[];
  try {
    names = fs.readdirSync(confirmsDir());
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return 0;
    throw err;
  }
  let removed = 0;
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const file = path.join(confirmsDir(), name);
    const record = JSON.parse(fs.readFileSync(file, 'utf-8')) as ConfirmRecord;
    if (nowMs > record.expiresAtMs) {
      fs.rmSync(file, { force: true });
      removed++;
    }
  }
  return removed;
}
