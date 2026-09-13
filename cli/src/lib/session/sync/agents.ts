/**
 * Per-agent adapter for sync. Each supported agent declares where its
 * transcripts live and how to derive a session id and storage-relative key
 * from a file path. The merge (crdt.ts) and transport (r2.ts) are fully
 * agent-agnostic — adding a new agent is just another entry in SYNC_AGENTS.
 *
 * Mirror layout: synced-in transcripts land under
 *   ~/.agents/.history/backups/<agent>/<machine>/<subdir>/<relKey>
 * which is already a scan root (getAgentSessionDirs scans backups/<agent>/<ts>),
 * so the existing incremental scanner indexes them with no changes. Because the
 * scanner dedups by session id with the live home scanned first, a session that
 * also exists locally always wins — the mirror only ever fills in sessions
 * originated on other machines.
 */

import * as fs from 'fs';
import * as path from 'path';
import { getHistoryDir } from '../../state.js';
import { getAgentSessionDirs } from '../discover.js';
import { walkForFiles } from '../../fs-walk.js';
import { isSafeSegmentName, assertWithin } from '../../paths.js';

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

/** One constituent file of a session — a session has exactly one for file-shaped
 *  agents (Claude, Codex, …), and many for directory-shaped ones (Kimi). */
export interface SessionFile {
  /** Absolute path on this machine. */
  absPath: string;
  /** Path relative to the agent's subdir root — preserved in the mirror layout. */
  relKey: string;
}

export interface LocalTranscript {
  /** Globally-unique session id (the grouping key across machines). */
  sessionId: string;
  /** Every file that makes up this session. Length 1 for file-shaped agents. */
  files: SessionFile[];
}

export interface SyncAgentSpec {
  id: string;
  /** Config subdir under the agent home that holds transcripts. */
  subdir: string;
  /** File extension to walk for this agent (defaults to .jsonl). */
  ext?: string;
  /**
   * A session is a DIRECTORY of files (e.g. Kimi: state.json + agents/…/wire.jsonl
   * + per-tool task sidecars), not a single transcript. When set, every file under
   * the session dir (matching `exts`, passing `fileFilter`) syncs, is stored under
   * its own R2 sub-key, and is mirrored at its own relative path — instead of the
   * file-shaped "one transcript per session" model.
   */
  dirShaped?: boolean;
  /** Extensions a dir-shaped agent walks (defaults to `[ext ?? '.jsonl']`). */
  exts?: string[];
  /** Optional per-file exclusion for dir-shaped agents (lock/scratch files, …). */
  fileFilter?(relKey: string): boolean;
  /**
   * Extensions whose files are append-only event logs and therefore CRDT-mergeable
   * (G-Set union across forked copies). A dir-shaped session usually mixes an
   * append-only conversation log (`wire.jsonl`) with mutable metadata blobs
   * (`state.json`) — line-unioning the latter would corrupt it, so any file NOT
   * matching an entry here is reconciled last-writer-wins instead. Undefined (the
   * file-shaped default) means every file is mergeable — the single `.jsonl`
   * transcript keeps its existing union behaviour.
   */
  mergeableExts?: string[];
  /** Derive the session id from a storage-relative key. */
  sessionIdFromRelKey(relKey: string): string;
}

/** True when a file at `relKey` is an append-only log that CRDT-unions across
 *  forks; false when it must be reconciled last-writer-wins (mutable blob). */
export function isMergeableFile(spec: SyncAgentSpec, relKey: string): boolean {
  if (!spec.mergeableExts) return true; // file-shaped default: the transcript unions
  return spec.mergeableExts.some(e => relKey.endsWith(e));
}

export const SYNC_AGENTS: SyncAgentSpec[] = [
  {
    id: 'claude',
    subdir: 'projects',
    // Claude transcripts are <projectDir>/<sessionId>.jsonl.
    sessionIdFromRelKey: rel => path.basename(rel).replace(/\.jsonl$/, ''),
  },
  {
    id: 'codex',
    subdir: 'sessions',
    // Codex transcripts are rollout-<ts>-<uuid>.jsonl under date dirs; the uuid
    // is the session id (matches session_meta.payload.id).
    sessionIdFromRelKey: rel => path.basename(rel).match(UUID_RE)?.[0] ?? rel,
  },
  {
    id: 'droid',
    subdir: 'sessions',
    // Droid writes <uuid>.jsonl under per-cwd subdirs (plus an optional
    // <uuid>.settings.json sidecar for metadata). The JSONL is the canonical
    // transcript; the sidecar is rebuilt from the transcript on the mirror.
    sessionIdFromRelKey: rel => path.basename(rel).replace(/\.jsonl$/, ''),
  },
  {
    id: 'cursor',
    subdir: 'projects',
    // Cursor writes <encoded-cwd>/agent-transcripts/<uuid>/<uuid>.jsonl.
    sessionIdFromRelKey: rel => path.basename(path.dirname(rel)),
  },
  {
    id: 'grok',
    subdir: 'sessions',
    // Grok sessions are multi-file directories under ~/.grok/sessions/<cwd>/<uuid>/.
    // events.jsonl is the canonical transcript stream; syncing it lets the mirror
    // reconstruct the session (summary.json metadata is recomputed on read).
    sessionIdFromRelKey: rel => path.basename(path.dirname(rel)),
  },
  {
    id: 'kimi',
    subdir: 'sessions',
    // Kimi stores a session as a DIRECTORY under
    // ~/.kimi-code/sessions/<wd_hash>/session_<uuid>/: state.json (the metadata the
    // scanner reads) + agents/<name>/wire.jsonl (the conversation the scanner
    // parses) + agents/<name>/tasks/*.json (per-tool sidecars). All of them must
    // sync for the session to reconstruct on another machine — hence dir-shaped
    // with both extensions. wire.jsonl unions as an append-only log; the .json
    // blobs reconcile last-writer-wins (see mergeableExts).
    dirShaped: true,
    exts: ['.json', '.jsonl'],
    mergeableExts: ['.jsonl'],
    // Lock files are machine-local and never part of the transcript.
    fileFilter: rel => !rel.endsWith('.lock'),
    sessionIdFromRelKey: rel => {
      const m = rel.match(/session_[^/]+/);
      return m?.[0] ?? rel;
    },
  },
  {
    id: 'opencode',
    subdir: 'sessions',
    // OpenCode stores sessions in a single SQLite DB (~/.local/share/opencode/opencode.db)
    // rather than transcript files. This entry reserves the agent slot so the
    // sync matrix is complete; file-based round-tripping requires an SQLite-to-JSONL
    // export step (not yet implemented).
    sessionIdFromRelKey: rel => path.basename(rel),
  },
];

let cachedMirrorRoot: string | null = null;
function mirrorRootReal(): string {
  if (cachedMirrorRoot) return cachedMirrorRoot;
  const root = path.join(getHistoryDir(), 'backups');
  cachedMirrorRoot = safeReal(root);
  return cachedMirrorRoot;
}

function safeReal(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

/**
 * List this machine's own transcript files for an agent, EXCLUDING the sync
 * mirror (we never re-upload another machine's files under our prefix). Dedups
 * by session id so a session present in multiple version homes is uploaded once.
 */
export function listLocalTranscripts(spec: SyncAgentSpec): LocalTranscript[] {
  const mirror = mirrorRootReal();
  const exts = spec.dirShaped ? (spec.exts ?? [spec.ext ?? '.jsonl']) : [spec.ext ?? '.jsonl'];
  // sessionId -> its files. File-shaped: the first file per session wins (one
  // transcript, unchanged behaviour). Dir-shaped: every matching file under the
  // session directory is collected, deduped by relKey across version homes.
  const bySession = new Map<string, LocalTranscript>();
  const seenRel = new Set<string>();

  for (const dir of getAgentSessionDirs(spec.id, spec.subdir)) {
    if (safeReal(dir).startsWith(mirror)) continue; // skip synced-in mirror dirs
    for (const ext of exts) {
      for (const abs of walkForFiles(dir, ext, 100_000)) {
        const relKey = path.relative(dir, abs);
        if (!relKey || relKey.startsWith('..')) continue;
        if (spec.fileFilter && !spec.fileFilter(relKey)) continue;
        const sessionId = spec.sessionIdFromRelKey(relKey);

        let entry = bySession.get(sessionId);
        if (!entry) bySession.set(sessionId, (entry = { sessionId, files: [] }));
        if (!spec.dirShaped && entry.files.length > 0) continue; // file-shaped: one file wins
        const dedupKey = `${sessionId} ${relKey}`;
        if (seenRel.has(dedupKey)) continue; // same file across >1 version home
        seenRel.add(dedupKey);
        entry.files.push({ absPath: abs, relKey });
      }
    }
  }
  // Stable file order per session so the manifest is deterministic across runs.
  const out = [...bySession.values()];
  for (const t of out) t.files.sort((a, b) => (a.relKey < b.relKey ? -1 : a.relKey > b.relKey ? 1 : 0));
  return out;
}

/**
 * Absolute mirror path for a remote machine's transcript — lands in a scan root.
 *
 * `machine` and `relKey` come from a peer's manifest (untrusted: any peer with
 * write access to the shared bucket controls them). Unlike the push side, which
 * already drops `relKey` starting with `..` when building the manifest, the pull
 * side would otherwise `fs.writeFileSync` at this path with peer-controlled
 * content. `machine` is constrained to a single segment and `relKey` (which may
 * legitimately nest, e.g. `projects/x/y.jsonl`) is contained beneath the
 * per-machine mirror root, so a crafted `relKey` like `../../../.ssh/authorized_keys`
 * cannot write outside `~/.agents/.history/backups/<agent>/<machine>/<subdir>`.
 */
export function mirrorPath(spec: SyncAgentSpec, machine: string, relKey: string): string {
  if (!isSafeSegmentName(machine)) {
    throw new Error(`Unsafe sync machine segment: ${JSON.stringify(machine)}`);
  }
  const machineRoot = path.join(getHistoryDir(), 'backups', spec.id, machine, spec.subdir);
  const dest = path.join(machineRoot, relKey);
  assertWithin(machineRoot, dest);
  return dest;
}

/**
 * R2 object key for a transcript.
 *  - file-shaped (relKey omitted): sessions/<machine>/<agent>/<sessionId>.jsonl —
 *    unchanged, so existing claude/codex/droid objects keep their keys.
 *  - dir-shaped (relKey given): sessions/<machine>/<agent>/<sessionId>/<relKey> —
 *    one object per constituent file of the session directory.
 */
export function objectKey(machine: string, agentId: string, sessionId: string, relKey?: string): string {
  if (relKey) return `sessions/${machine}/${agentId}/${sessionId}/${relKey}`;
  return `sessions/${machine}/${agentId}/${sessionId}.jsonl`;
}

/** Prefix under which all machine manifests live (for discovery). */
export const SESSIONS_PREFIX = 'sessions/';
