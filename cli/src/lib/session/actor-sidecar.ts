import fs from 'fs';
import path from 'path';
import { getHistoryDir } from '../state.js';
import { isAgentTmuxAlias, type SessionRunMode } from '@phnx-labs/sessions-cli/reader';


interface SessionActorRecord {
  sessionId: string;
  actor?: string;
  initiatedBy?: 'human' | 'agent';
  phoenixId?: string;
  mode?: SessionRunMode;
  version?: string;
  accountId?: string;
  harness?: string;
  aliases?: string[];
  startedAtMs: number;
}

function sidecarDir(): string {
  return path.join(getHistoryDir(), 'by-session');
}

function isSafeSessionId(sessionId: string): boolean {
  return sessionId.length > 0 && !/[/\\]/.test(sessionId) && sessionId !== '.' && sessionId !== '..';
}

function recordPath(sessionId: string): string {
  return path.join(sidecarDir(), `${sessionId}.json`);
}

function isSafeAlias(alias: string): boolean {
  return isAgentTmuxAlias(alias);
}

function hasRecordData(record: SessionActorRecord): boolean {
  return typeof record.actor === 'string'
    || typeof record.phoenixId === 'string'
    || typeof record.mode === 'string'
    || typeof record.version === 'string'
    || typeof record.accountId === 'string'
    || typeof record.harness === 'string'
    || (Array.isArray(record.aliases) && record.aliases.some(alias => typeof alias === 'string'));
}

function normalizedAliases(aliases: unknown): string[] {
  if (!Array.isArray(aliases)) return [];
  return [...new Set(aliases
    .filter((alias): alias is string => typeof alias === 'string' && isSafeAlias(alias))
    .map(alias => alias.toLowerCase()))];
}

function writeRecord(record: SessionActorRecord): void {
  fs.mkdirSync(sidecarDir(), { recursive: true });
  fs.writeFileSync(recordPath(record.sessionId), JSON.stringify(record), 'utf8');
}

export function writeSessionActorRecord(record: SessionActorRecord): void {
  if (!isSafeSessionId(record.sessionId)) return;
  try {
    const previous = readSessionActorRecord(record.sessionId);
    writeRecord({
      ...previous,
      ...record,
      accountId: previous?.accountId ?? record.accountId,
      aliases: normalizedAliases([...(previous?.aliases ?? []), ...(record.aliases ?? [])]),
    });
  } catch {
  }
}

export function writeSessionAliasRecord(sessionId: string, alias: string): void {
  if (!isSafeSessionId(sessionId) || !isSafeAlias(alias)) return;
  try {
    const previous = readSessionActorRecord(sessionId);
    writeRecord({
      sessionId,
      actor: previous?.actor,
      initiatedBy: previous?.initiatedBy,
      phoenixId: previous?.phoenixId,
      mode: previous?.mode,
      version: previous?.version,
      accountId: previous?.accountId,
      harness: previous?.harness,
      aliases: normalizedAliases([...(previous?.aliases ?? []), alias]),
      startedAtMs: previous?.startedAtMs ?? Date.now(),
    });
  } catch {
  }
}

type SessionAliasResolution =
  | { kind: 'resolved'; sessionId: string }
  | { kind: 'ambiguous'; sessionIds: string[] }
  | { kind: 'not-found' };

export function resolveSessionAlias(selector: string): SessionAliasResolution {
  const normalized = selector.trim().toLowerCase();
  if (!normalized) return { kind: 'not-found' };
  const exact = new Set<string>();
  const fuzzy = new Set<string>();
  for (const record of loadSessionActorIndex().values()) {
    for (const alias of normalizedAliases(record.aliases)) {
      if (alias === normalized) exact.add(record.sessionId);
      else if (normalized.length >= 6 && (alias.startsWith(normalized) || alias.endsWith(normalized))) fuzzy.add(record.sessionId);
    }
  }
  const matches = exact.size > 0 ? [...exact] : [...fuzzy];
  if (matches.length === 0) return { kind: 'not-found' };
  if (matches.length > 1) return { kind: 'ambiguous', sessionIds: matches.sort() };
  return { kind: 'resolved', sessionId: matches[0] };
}

export function readSessionActorRecord(sessionId: string): SessionActorRecord | undefined {
  if (!isSafeSessionId(sessionId)) return undefined;
  let raw: string;
  try {
    raw = fs.readFileSync(recordPath(sessionId), 'utf8');
  } catch {
    return undefined;
  }
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && typeof parsed.sessionId === 'string' &&
      hasRecordData(parsed as SessionActorRecord)) {
      return parsed as SessionActorRecord;
    }
  } catch {
  }
  return undefined;
}

export function loadSessionActorIndex(): Map<string, SessionActorRecord> {
  const out = new Map<string, SessionActorRecord>();
  let files: string[];
  try {
    files = fs.readdirSync(sidecarDir()).filter(f => f.endsWith('.json'));
  } catch {
    return out;
  }
  for (const f of files) {
    try {
      const parsed = JSON.parse(fs.readFileSync(path.join(sidecarDir(), f), 'utf8'));
      if (parsed && typeof parsed === 'object' && typeof parsed.sessionId === 'string' &&
        hasRecordData(parsed as SessionActorRecord)) {
        out.set(parsed.sessionId, parsed as SessionActorRecord);
      }
    } catch {
    }
  }
  return out;
}
