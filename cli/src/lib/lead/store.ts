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

export function appendHistory(paths: LeadPaths, turn: LeadHistoryTurn): void {
  fs.appendFileSync(paths.history, `${JSON.stringify(turn)}\n`);
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
    turns.push(JSON.parse(line) as LeadHistoryTurn);
  }
  return limit === undefined ? turns : turns.slice(-limit);
}
