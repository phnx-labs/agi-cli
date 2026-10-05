import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

import { getCacheDir } from './state.js';

export const LINEAR_RATE_WINDOW_MS = 60 * 60 * 1000;

export const LINEAR_HOURLY_REQUEST_BUDGET = 2400;

let rateLimitDirOverride: string | null = null;
export function setLinearRateLimitDirForTest(dir: string | null): string | null {
  const prev = rateLimitDirOverride;
  rateLimitDirOverride = dir;
  return prev;
}

function rateLimitRoot(): string {
  return rateLimitDirOverride ?? path.join(getCacheDir(), 'linear-rate-limit');
}

function keyDir(apiKey: string): string {
  const hash = crypto.createHash('sha256').update(apiKey).digest('hex').slice(0, 16);
  return path.join(rateLimitRoot(), hash);
}

function createdMsOf(name: string): number | null {
  const first = name.indexOf('.');
  if (first <= 0) return null;
  const head = name.slice(0, first);
  if (!/^\d+$/.test(head)) return null;
  const n = Number(head);
  return Number.isFinite(n) ? n : null;
}

export function linearRequestsInWindow(apiKey: string, nowMs: number = Date.now()): number {
  const dir = keyDir(apiKey);
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return 0;
  }
  const cutoff = nowMs - LINEAR_RATE_WINDOW_MS;
  let live = 0;
  for (const name of names) {
    const created = createdMsOf(name);
    if (created === null) continue;
    if (created <= cutoff) {
      try {
        fs.rmSync(path.join(dir, name), { force: true });
      } catch {
      }
    } else {
      live++;
    }
  }
  return live;
}

let reserveSeq = 0;

export function reserveLinearRequest(apiKey: string, nowMs: number = Date.now()): boolean {
  if (linearRequestsInWindow(apiKey, nowMs) >= LINEAR_HOURLY_REQUEST_BUDGET) return false;
  const dir = keyDir(apiKey);
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${nowMs}.${process.pid}.${reserveSeq++}`), '');
    return true;
  } catch {
    return true;
  }
}
