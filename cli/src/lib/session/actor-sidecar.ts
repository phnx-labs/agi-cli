/** Durable sessionId -> actor sidecar (RUSH-2019). Transcripts carry no actor; the pid-registry
 * (RUSH-2018) is pruned when the pid dies. One never-pruned record per session under
 * `~/.agents/.history`, joined by the scanner. Best-effort: never throws into launch or scan. */
import fs from 'fs';
import path from 'path';
import { getHistoryDir } from '../state.js';
import { isAgentTmuxAlias, type SessionRunMode } from '@phnx-labs/sessions-cli/reader';

interface SessionActorRecord {
  sessionId: string;
  /** Resolved actor id (`resolveActor().id`) — the responsible human/agent. */
  actor?: string;
  /** Actor kind (`resolveActor().kind`). */
  initiatedBy?: 'human' | 'agent';
  /** Phoenix id of the responsible actor (`resolveActor().phoenixId`), resolved from the `actors:`
   * map at spawn (PHNX-3798). Joined onto the session index at scan time so listings can show it,
   * not just the email. */
  phoenixId?: string;
  /** Effective permissions mode used by the launcher. */
  mode?: SessionRunMode;
  /** Installed executable label at launch; provenance only, never account identity. */
  version?: string;
  /** Credential account used at launch, independent of the installed executable. */
  accountId?: string;
  /** Custom harness/profile name when launched via `agents run <profile>` (e.g. `deepseek`), joined
   * onto the index at scan time to distinguish the profile from its host agent (PHNX-2935). */
  harness?: string;
  /** Stable wrapper names that resolve to this native session id. */
  aliases?: string[];
  startedAtMs: number;
}

function sidecarDir(): string {
  return path.join(getHistoryDir(), 'by-session');
}

/** A session id safe as a filename: no path separators or `..`, so a caller-supplied `--session-id`
 * cannot escape `by-session/`. Anything else is rejected, not sanitized, so a bad id yields no
 * record rather than an outside write. */
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

/** Record the actor a session was launched under. Never throws: the sidecar is an attribution
 * optimization. No-ops without a concrete session id. */
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

type SessionAliasResolution =
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

/** Load every actor record into a `sessionId -> record` map so the scan joins a batch in one
 * directory read, not a stat per row. Best-effort: corrupt files are skipped, a missing dir yields
 * an empty map. */
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
