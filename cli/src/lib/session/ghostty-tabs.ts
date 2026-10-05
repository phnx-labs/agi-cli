/** Best-effort Ghostty tab-number detection for `agents sessions --active`. Ghostty's AppleScript
 * exposes tab index/name and surface working directory, but no env var, tty or pid, so match by
 * working directory (title as tiebreak). Display sugar; any failure yields no number. */

import { execFile } from 'child_process';
import { promisify } from 'util';
import type { ActiveSession } from './active.js';

const execFileAsync = promisify(execFile);

/** One Ghostty surface (terminal), flattened from window -> tab -> surface. */
export interface GhosttySurface {
  windowIndex: number;
  tabIndex: number;
  cwd: string;
  title: string;
}

// Field delimiter: ASCII Unit Separator (0x1F). AppleScript's `tab` keyword does
// not resolve to a tab byte via `osascript -e`, but `character id 31` does — and
// 0x1F never appears in a cwd or a tab title, so parsing is unambiguous.
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

/** Enumerate every Ghostty surface (window/tab/cwd/title) via one read-only osascript call. Returns
 * [] on ANY failure (not running, Automation permission missing, timeout, parse miss). Never
 * throws, never prompts. */
export async function enumerateGhosttyTabs(timeoutMs = 1500): Promise<GhosttySurface[]> {
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

/** Trailing-slash-insensitive cwd key. */
function cwdKey(p: string | undefined): string {
  return (p ?? '').replace(/\/+$/, '');
}

/** Normalize a tab title or hint for containment matching: drop a leading run of non-alphanumerics
 * (Ghostty prefixes a spinner glyph like `⠐ ` while an agent runs) and lowercase, or an
 * exact-topic title fails the substring test. */
function normText(s: string): string {
  return s.replace(/^[^\p{L}\p{N}]+/u, '').toLowerCase().trim();
}

/** Assign a Ghostty tab number to each `host === 'ghostty'` session by matching cwd to a surface's
 * working directory; ties break by title containment against label/topic/kind. A session not
 * uniquely resolved gets NO number: a wrong jump target is worse. Pure. */
export function assignGhosttyTabs(
  sessions: ActiveSession[],
  surfaces: GhosttySurface[],
): Map<ActiveSession, number> {
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
    // Tie: break by title containment (glyph-stripped, lowercased). Hints are
    // what the session knows about itself; a good hint is >=8 chars so short
    // fragments don't cause spurious matches.
    const hints = [sess.label, sess.topic, sess.preview]
      .filter((h): h is string => !!h && normText(h).length >= 8)
      .map(normText);
    const matches = candidates.filter(c => {
      const title = normText(c.title);
      return title.length >= 8 && hints.some(h => title.includes(h) || h.includes(title));
    });
    // Only assign when the tiebreak is unambiguous (exactly one title match).
    if (matches.length === 1) result.set(sess, matches[0].tabIndex);
  }
  return result;
}
