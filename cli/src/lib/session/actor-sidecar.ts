/**
 * Durable sessionId -> actor sidecar (RUSH-2019, P3 lineage).
 *
 * The actor behind a run is resolved at spawn (`resolveActor()`), but the session
 * transcript on disk carries no record of it — so the scanner that indexes those
 * transcripts into `sessions.db` (`discover.ts` -> `upsertSessionsBatch`) has
 * nothing to attribute a session to a person with. The pid-registry answers this
 * for LIVE processes (`--active` owner, RUSH-2018), but it lives under `.cache`
 * and is pruned when the pid dies, so it can't back a DURABLE, historical listing.
 *
 * This module writes one small, durable record per launched session — keyed by
 * session id, under `~/.agents/.history` (never pruned) — that the scanner joins
 * on to fill the write-once `actor` / `initiated_by` columns. Best-effort
 * throughout: a failed write or a corrupt file degrades to an unattributed row,
 * never throws into the launch or the scan path.
 */
import fs from 'fs';
import path from 'path';
import { getHistoryDir } from '../state.js';
import { isAgentTmuxAlias, type SessionRunMode } from './types.js';

export interface SessionActorRecord {
  sessionId: string;
  /** Resolved actor id (`resolveActor().id`) — the responsible human/agent. */
  actor?: string;
  /** Actor kind (`resolveActor().kind`). */
  initiatedBy?: 'human' | 'agent';
  /**
   * Phoenix id of the responsible actor (`resolveActor().phoenixId`) — the
   * tailnet human's stable Phoenix identity, resolved from the `actors:` map at
   * spawn (PHNX-3798). Pairs with {@link actor}: joined onto the session index at
   * scan time so a durable listing can surface the Phoenix id, not just the email.
   */
  phoenixId?: string;
  /** Effective permissions mode used by the launcher. */
  mode?: SessionRunMode;
  /** Installed executable label at launch; provenance only, never account identity. */
  version?: string;
  /** Credential account used at launch, independent of the installed executable. */
  accountId?: string;
  /**
   * Custom harness / profile name when launched via `agents run <profile>`
   * (e.g. `deepseek`). Joined onto the session index at scan time so a
   * durable listing can distinguish the profile from its host agent
   * (PHNX-2935).
   */
  harness?: string;
  /** Stable wrapper names that resolve to this native session id. */
  aliases?: string[];
  startedAtMs: number;
}

function sidecarDir(): string {
  return path.join(getHistoryDir(), 'by-session');
}

/**
 * A session id safe to use as a filename: no path separators or `..`, so a
 * caller-supplied `--session-id` can never escape `by-session/` via
 * `path.join`. Session ids are uuids in practice; anything else is rejected
 * rather than sanitized, so a bad id degrades to no record, never a write
 * outside the directory.
 */
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

/**
 * Record the actor a session was launched under. Never throws — the sidecar is
 * an attribution optimization; a session with no record simply scans unattributed.
 * No-ops without a concrete session id (nothing to key on).
 */
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
    /* degrade to an unattributed row */
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
    /* the native id remains usable */
  }
}

export type SessionAliasResolution =
  | { kind: 'resolved'; sessionId: string }
  | { kind: 'ambiguous'; sessionIds: string[] }
  | { kind: 'not-found' };

/** Resolve an exact alias, or a unique prefix/suffix of at least six chars. */
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

/** Read one session's actor record. Returns undefined if absent/corrupt. */
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
    /* unparseable */
  }
  return undefined;
}

/**
 * Load every session actor record into a `sessionId -> record` map, for the scan
 * path to join a whole batch of sessions in one directory read instead of a
 * stat-per-row. Best-effort: unreadable/corrupt files are skipped, a missing dir
 * yields an empty map.
 */
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
      /* raced with a writer, or corrupt — skip */
    }
  }
  return out;
}
