import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export const CLAUDE_PROJECTS_ROOT = path.join(os.homedir(), '.claude', 'projects');

export function claudeWorkspaceFolder(cwd: string): string {
  return cwd.replace(/[\/.]/g, '-');
}

export function claudeSessionDir(cwd: string): string {
  return path.join(CLAUDE_PROJECTS_ROOT, claudeWorkspaceFolder(cwd));
}

export async function snapshotSessions(cwd: string): Promise<Set<string>> {
  try {
    const files = await fs.promises.readdir(claudeSessionDir(cwd));
    return new Set(files.filter((f) => f.endsWith('.jsonl')));
  } catch {
    return new Set();
  }
}

export interface NewSession {
  sessionId: string;
  latencyMs: number;
  file: string;
}

export async function awaitNewSession(
  cwd: string,
  before: Set<string>,
  timeoutMs: number,
  pollMs = 50,
): Promise<NewSession | null> {
  const start = Date.now();
  const dir = claudeSessionDir(cwd);
  while (Date.now() - start < timeoutMs) {
    try {
      const files = await fs.promises.readdir(dir);
      for (const f of files) {
        if (!f.endsWith('.jsonl')) continue;
        if (before.has(f)) continue;
        return {
          sessionId: f.replace(/\.jsonl$/, ''),
          latencyMs: Date.now() - start,
          file: path.join(dir, f),
        };
      }
    } catch {
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
  return null;
}
