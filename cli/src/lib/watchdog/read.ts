
import * as fs from 'fs';
import * as path from 'path';
import { getAgentSessionDirs } from '../session/discover.js';
import { walkForFiles } from '../fs-walk.js';

export const WATCHDOG_TAIL_LINES = 20;
export const WATCHDOG_STALL_MS = 300_000;
export const WATCHDOG_COOLDOWN_MS = 1_200_000;
export const WATCHDOG_DORMANT_MS = 3_600_000;

const CHUNK_SIZE = 64 * 1024;
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

const WATCHDOG_WALK_CAP = 100_000;

const WATCHDOG_SESSION_LAYOUT: Record<string, { subdir: string; ext: string }> = {
  claude: { subdir: 'projects', ext: '.jsonl' },
  codex: { subdir: 'sessions', ext: '.jsonl' },
  droid: { subdir: 'sessions', ext: '.jsonl' },
};

const WATCHDOG_SESSION_LAYOUT_DEFAULT = { subdir: 'projects', ext: '.jsonl' };

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
    }
  }
}

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

export function resolveWatchdogSessionPath(sessionId: string, agent: string): string | undefined {
  const layout = WATCHDOG_SESSION_LAYOUT[agent] ?? WATCHDOG_SESSION_LAYOUT_DEFAULT;
  const dirs = getAgentSessionDirs(agent, layout.subdir);
  return findSessionJsonlIn(dirs, sessionId, layout.ext);
}

export function readWatchdogTail(
  sessionId: string,
  agent: string,
  maxLines: number = WATCHDOG_TAIL_LINES,
): string[] {
  const filePath = resolveWatchdogSessionPath(sessionId, agent);
  if (!filePath) return [];
  return readTailLines(filePath, maxLines);
}
