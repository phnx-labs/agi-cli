import * as fs from 'node:fs';
import { atomicWriteFileSync, atomicWriteJsonSync } from '../fs-atomic.js';
import type { LeadEngine, LeadRef, LeadTiming } from './events.js';
import type { LeadPaths } from './paths.js';
import type { RosterSnapshot } from './roster.js';

export interface LeadSessionState {
  sessionId: string;
  model: string;
  startedAtMs: number;
  turns: number;
  briefed: boolean;
  brief: string[];
  contextTokens?: number;
  contextWindow?: number;
  lastTurnAtMs?: number;
  lastEngine?: LeadEngine;
  rotatedFrom?: string;
  roster?: RosterSnapshot;
}

export interface LeadHistoryTool {
  label: string;
  cmd: string;
  state: 'ok' | 'fail' | 'run';
  secs: number;
}

export interface LeadHistoryTurn {
  turn: string;
  at: string;
  ask: string;
  voice?: number;
  text: string;
  summary: string;
  refs: LeadRef[];
  tools?: LeadHistoryTool[];
  session: string;
  timing: LeadTiming;
}

export function readSessionState(paths: LeadPaths): LeadSessionState | null {
  try {
    return JSON.parse(fs.readFileSync(paths.session, 'utf-8')) as LeadSessionState;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

export function writeSessionState(paths: LeadPaths, state: LeadSessionState): void {
  atomicWriteJsonSync(paths.session, state);
}

export function clearSessionState(paths: LeadPaths): void {
  fs.rmSync(paths.session, { force: true });
}

export function readMemory(paths: LeadPaths): string {
  try {
    return fs.readFileSync(paths.memory, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return '';
    throw err;
  }
}

export function writeMemory(paths: LeadPaths, text: string): void {
  atomicWriteFileSync(paths.memory, text.endsWith('\n') ? text : `${text}\n`);
}

export const HISTORY_MAX_BYTES = 5 * 1024 * 1024;
export const LOG_MAX_BYTES = 2 * 1024 * 1024;

export function rotateIfLarge(file: string, maxBytes: number): void {
  let size: number;
  try {
    size = fs.statSync(file).size;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw err;
  }
  if (size >= maxBytes) fs.renameSync(file, `${file}.1`);
}

export function appendHistory(paths: LeadPaths, turn: LeadHistoryTurn, maxBytes = HISTORY_MAX_BYTES): void {
  rotateIfLarge(paths.history, maxBytes);
  fs.appendFileSync(paths.history, `${JSON.stringify(turn)}\n`);
}

export function appendLog(paths: LeadPaths, line: string, maxBytes = LOG_MAX_BYTES): void {
  rotateIfLarge(paths.log, maxBytes);
  fs.appendFileSync(paths.log, `${line}\n`);
}

export function readHistory(paths: LeadPaths, limit?: number): LeadHistoryTurn[] {
  let raw: string;
  try {
    raw = fs.readFileSync(paths.history, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  const turns: LeadHistoryTurn[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      turns.push(JSON.parse(line) as LeadHistoryTurn);
    } catch {
      continue;
    }
  }
  return limit === undefined ? turns : turns.slice(-limit);
}
