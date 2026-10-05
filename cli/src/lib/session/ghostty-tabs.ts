
import { execFile } from 'child_process';
import { promisify } from 'util';
import type { ActiveSession } from './active.js';

const execFileAsync = promisify(execFile);

export interface GhosttySurface {
  windowIndex: number;
  tabIndex: number;
  cwd: string;
  title: string;
}

const ENUM_SCRIPT = `tell application "Ghostty"
  set fd to (character id 31)
  set out to ""
  set wi to 0
  repeat with w in windows
    set wi to wi + 1
    repeat with t in tabs of w
      set ti to index of t
      repeat with s in terminals of t
        set out to out & wi & fd & ti & fd & (working directory of s) & fd & (name of s) & linefeed
      end repeat
    end repeat
  end repeat
  return out
end tell`;

export async function enumerateGhosttyTabs(timeoutMs = 1500): Promise<GhosttySurface[]> {
  // One bounded, nonfatal OS probe serves the whole refresh tick.
  if (process.platform !== 'darwin') return [];
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync('osascript', ['-e', ENUM_SCRIPT], {
      timeout: timeoutMs,
      killSignal: 'SIGKILL',
      maxBuffer: 1024 * 1024,
      encoding: 'utf8',
    }));
  } catch {
    return [];
  }
  const out: GhosttySurface[] = [];
  for (const line of stdout.split('\n')) {
    if (!line) continue;
    const f = line.split('\u001f');
    if (f.length < 4) continue;
    const windowIndex = parseInt(f[0], 10);
    const tabIndex = parseInt(f[1], 10);
    if (!Number.isFinite(windowIndex) || !Number.isFinite(tabIndex)) continue;
    out.push({ windowIndex, tabIndex, cwd: f[2], title: f[3] });
  }
  return out;
}

function cwdKey(p: string | undefined): string {
  return (p ?? '').replace(/\/+$/, '');
}

function normText(s: string): string {
  return s.replace(/^[^\p{L}\p{N}]+/u, '').toLowerCase().trim();
}

export function assignGhosttyTabs(
  sessions: ActiveSession[],
  surfaces: GhosttySurface[],
): Map<ActiveSession, number> {
  // Assign only a unique cwd/title match; ambiguity is safer than a wrong tab.
  const result = new Map<ActiveSession, number>();
  if (surfaces.length === 0) return result;

  const byCwd = new Map<string, GhosttySurface[]>();
  for (const s of surfaces) {
    const k = cwdKey(s.cwd);
    const bucket = byCwd.get(k);
    if (bucket) bucket.push(s);
    else byCwd.set(k, [s]);
  }

  for (const sess of sessions) {
    if (sess.host !== 'ghostty') continue;
    const candidates = byCwd.get(cwdKey(sess.cwd));
    if (!candidates || candidates.length === 0) continue;
    if (candidates.length === 1) {
      result.set(sess, candidates[0].tabIndex);
      continue;
    }
    const hints = [sess.label, sess.topic, sess.preview]
      .filter((h): h is string => !!h && normText(h).length >= 8)
      .map(normText);
    const matches = candidates.filter(c => {
      const title = normText(c.title);
      return title.length >= 8 && hints.some(h => title.includes(h) || h.includes(title));
    });
    if (matches.length === 1) result.set(sess, matches[0].tabIndex);
  }
  return result;
}
