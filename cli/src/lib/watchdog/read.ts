// Watchdog tail reader: locate a session transcript from its id + agent and
// pull the last N raw JSONL lines. The raw lines feed the pure detectors in
// watchdog.ts (isLikelyTrulyBlocked / renderWatchdogPrompt) and the pure
// summarizer in watchdogTail.ts.
//
// Adapted from Swarmify's readTailLines (extension/src/vscode/sessions.vscode.ts)
// to agents-cli's session layout. Path resolution REUSES getAgentSessionDirs()
// from src/lib/session/discover.ts — the same resolver the rest of the CLI uses
// to enumerate per-version transcript roots — instead of hardcoding
// ~/.agents/.history/versions/<agent>/.../projects/<enc>/<sessionId>.jsonl.

import * as fs from 'fs';
import * as path from 'path';
import { getAgentSessionDirs } from '../session/discover.js';
import { walkForFiles } from '../fs-walk.js';

/** Default watchdog thresholds, mirrored from the Swarmify VS Code runtime. */
export const WATCHDOG_TAIL_LINES = 20;
export const WATCHDOG_STALL_MS = 300_000; // 5m — stallSeconds default
export const WATCHDOG_COOLDOWN_MS = 1_200_000; // 20m — cooldownSeconds default
export const WATCHDOG_DORMANT_MS = 3_600_000; // 1h — DORMANT_MS

const CHUNK_SIZE = 64 * 1024;
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

/** Cap on files walked per transcript root — matches session/discover.ts. */
const WATCHDOG_WALK_CAP = 100_000;

/**
 * Per-agent transcript layout, mirroring the `getAgentSessionDirs()` call sites
 * in session/discover.ts so the resolver never diverges from the rest of the CLI:
 * Claude keeps per-project folders under `projects/` (discover.ts:486); Codex and
 * Droid date-/work-partition rollout `.jsonl` deep under `sessions/`
 * (discover.ts:665, :1673); Gemini nests chat `.json` under `tmp/<hash>/chats/`
 * (discover.ts:820). Subdir + extension are driven from this table instead of the
 * old hardcoded `codex ? 'sessions' : 'projects'` ternary, which sent every
 * non-Codex agent (Gemini included) to the wrong root.
 */
const WATCHDOG_SESSION_LAYOUT: Record<string, { subdir: string; ext: string }> = {
  claude: { subdir: 'projects', ext: '.jsonl' },
  codex: { subdir: 'sessions', ext: '.jsonl' },
  droid: { subdir: 'sessions', ext: '.jsonl' },
};

const WATCHDOG_SESSION_LAYOUT_DEFAULT = { subdir: 'projects', ext: '.jsonl' };

/**
 * Read the last `maxLines` non-empty lines of a JSONL transcript by seeking
 * backward from EOF in 64KB chunks. A tail that begins mid-line yields one
 * malformed leading line, which the callers' per-line JSON try/catch tolerates.
 * Returns `[]` on any read error or empty file.
 */
export function readTailLines(filePath: string, maxLines: number): string[] {
  let fd: number;
  try {
    fd = fs.openSync(filePath, 'r');
  } catch {
    return [];
  }

  try {
    const fileSize = fs.fstatSync(fd).size;
    if (fileSize === 0) return [];

    let position = fileSize;
    let buffer = '';
    let collected: string[] = [];

    while (position > 0 && collected.length <= maxLines) {
      const readSize = Math.min(CHUNK_SIZE, position);
      position -= readSize;
      const chunk = Buffer.alloc(readSize);
      fs.readSync(fd, chunk, 0, readSize, position);
      buffer = chunk.toString('utf-8') + buffer;
      collected = buffer.split(/\r?\n/).filter((l) => l.trim());
    }

    return collected.slice(-maxLines);
  } catch {
    return [];
  } finally {
    try {
      fs.closeSync(fd);
    } catch {
      /* fd already gone */
    }
  }
}

/**
 * Given candidate transcript-root directories, find the transcript file for a
 * session. Handles the flat Claude layout (`<sessionId>.jsonl` inside a
 * per-project `<enc>/` subfolder), Codex-style names that merely embed the uuid
 * (`rollout-…-<sessionId>.jsonl`), and — critically — the DEEP date partitions
 * Codex/Droid use (`sessions/YYYY/MM/DD/rollout-…-<uuid>.jsonl`). The scan is
 * fully recursive via `walkForFiles` (the same walker session/discover.ts uses),
 * so no fixed number of subdir levels is assumed — a hand-rolled one-level scan
 * silently missed every Codex transcript. Newest mtime wins when a uuid appears
 * in more than one root (e.g. across version homes). Pure over its `dirs`
 * argument, so it is testable without touching the real home directory.
 */
export function findSessionJsonlIn(
  dirs: string[],
  sessionId: string,
  ext: string = '.jsonl',
): string | undefined {
  if (!sessionId) return undefined;

  const matches = (name: string): boolean => {
    if (!name.endsWith(ext)) return false;
    const stem = name.slice(0, -ext.length);
    if (stem === sessionId) return true;
    // Codex embeds the uuid in a longer filename (rollout-<ts>-<uuid>.jsonl).
    return name.includes(sessionId) || (UUID_RE.test(sessionId) && stem.includes(sessionId));
  };

  let best: { file: string; mtime: number } | undefined;
  for (const dir of dirs) {
    for (const file of walkForFiles(dir, ext, WATCHDOG_WALK_CAP)) {
      if (!matches(path.basename(file))) continue;
      let mtime: number;
      try {
        mtime = fs.statSync(file).mtimeMs;
      } catch {
        continue;
      }
      if (!best || mtime > best.mtime) best = { file, mtime };
    }
  }

  return best?.file;
}

/**
 * Resolve a session transcript path from its id + agent, reusing the CLI's
 * per-version transcript roots. Returns `undefined` if no transcript is found.
 */
export function resolveWatchdogSessionPath(sessionId: string, agent: string): string | undefined {
  // Subdir + transcript extension are driven per-agent from WATCHDOG_SESSION_LAYOUT
  // (which mirrors the getAgentSessionDirs() convention in session/discover.ts),
  // not a hardcoded `codex ? 'sessions' : 'projects'` — that ternary sent Codex to
  // a root it only scanned one level deep, and every other agent (Gemini included)
  // to the wrong subdir entirely.
  const layout = WATCHDOG_SESSION_LAYOUT[agent] ?? WATCHDOG_SESSION_LAYOUT_DEFAULT;
  const dirs = getAgentSessionDirs(agent, layout.subdir);
  return findSessionJsonlIn(dirs, sessionId, layout.ext);
}

/**
 * Read the last `maxLines` JSONL lines for a session by id + agent. Returns
 * `[]` when the transcript cannot be located or read.
 */
export function readWatchdogTail(
  sessionId: string,
  agent: string,
  maxLines: number = WATCHDOG_TAIL_LINES,
): string[] {
  const filePath = resolveWatchdogSessionPath(sessionId, agent);
  if (!filePath) return [];
  return readTailLines(filePath, maxLines);
}
