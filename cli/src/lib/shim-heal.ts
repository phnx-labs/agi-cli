// Interactive shim-heal for the CLI startup path + the persistent notice-state that
// replaces the old per-PPID sentinel.
//
// The actual repair (regenerating shims, adopting symlink launchers, adding the
// shims dir to PATH) lives in the unified self-heal registry — this module just
// drives the shim-relevant checks SILENTLY on a normal `agents` invocation and then
// decides whether to print a one-time notice about anything left. The old flow
// re-ran its whole detect-and-nag on every new terminal (its sentinel was keyed to
// process.ppid); the persistent signature here means an unresolved condition is
// surfaced once, not on every shell.

import fs from 'node:fs';
import path from 'node:path';
import { getRuntimeStateDir } from './state.js';
import type { SelfHealReport } from './self-heal/types.js';

interface InteractiveShimHealResult {
  noticeLines: string[] | null;
  report: SelfHealReport;
}

/**
 * Heal the shim/shadow/PATH conditions silently, then return both the raw report
 * and the notice lines to print ONCE for whatever is left (a real-binary shadow we
 * won't move; a PATH entry that was just added / needs a reload).
 */
export async function runInteractiveShimHeal(): Promise<InteractiveShimHealResult> {
  const { runSelfHeal } = await import('./self-heal/registry.js');
  const report = await runSelfHeal({ checks: ['shims', 'shadowing', 'path'], mode: 'safe' });

  const shadowNotes: string[] = [];
  let pathAdded: string | null = null;
  let pathReload: string | null = null;
  for (const c of report.checks) {
    if (!c.result) continue;
    if (c.id === 'shadowing') shadowNotes.push(...c.result.needsAttention);
    if (c.id === 'path') {
      for (const f of c.result.fixed) pathAdded = f; // "added shims to PATH (~/.zshrc)"
      for (const a of c.result.needsAttention) pathReload = a; // "...not loaded — open a new terminal"
    }
  }

  const pathState: PathNoticeState = pathAdded ? 'added' : pathReload ? 'reload' : 'ok';
  const signature = computeShimNoticeSignature({ shadowNotes, pathState });
  if (!shouldSurfaceShimNotice(signature)) return { noticeLines: null, report };

  const lines: string[] = [];
  if (pathAdded) {
    lines.push(pathAdded);
    lines.push('Open a new terminal (or source your shell rc) to pick it up.');
  } else if (pathReload) {
    lines.push(pathReload);
  }
  if (shadowNotes.length > 0) {
    lines.push('These agent commands run a native binary instead of the version-managed shim:');
    for (const note of shadowNotes) lines.push(`  ${note}`);
    lines.push("It's a real binary (not a symlink), so agents-cli won't move it — reorder PATH or remove it to hand it over.");
  }
  return { noticeLines: lines.length > 0 ? lines : null, report };
}

// ─── Persistent notice-state (replaces the per-PPID sentinel) ──────────────────

type PathNoticeState = 'ok' | 'added' | 'reload';

function noticeStatePath(): string {
  return path.join(getRuntimeStateDir(), 'shim-notice.json');
}

/**
 * A stable signature of the conditions worth surfacing: the sorted set of
 * real-binary shadows plus the PATH notice state. Empty string = nothing to say.
 */
export function computeShimNoticeSignature(input: {
  shadowNotes: string[];
  pathState: PathNoticeState;
}): string {
  const shadows = [...input.shadowNotes].sort().join(',');
  const parts: string[] = [];
  if (shadows) parts.push(`shadow:${shadows}`);
  if (input.pathState !== 'ok') parts.push(`path:${input.pathState}`);
  return parts.join('|');
}

function readLastNoticeSignature(): string | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(noticeStatePath(), 'utf-8')) as { signature?: string };
    return typeof parsed.signature === 'string' ? parsed.signature : null;
  } catch {
    return null;
  }
}

function writeLastNoticeSignature(signature: string): void {
  try {
    fs.mkdirSync(getRuntimeStateDir(), { recursive: true });
    fs.writeFileSync(noticeStatePath(), JSON.stringify({ signature }));
  } catch {
    /* best-effort: never block a command on the marker */
  }
}

/**
 * Whether to surface the notice for the current condition. Returns false (stay
 * quiet) when the exact same signature was already surfaced, or when there's
 * nothing to say. On true it records the signature so the next shell with the same
 * state is suppressed. An empty signature clears the marker.
 */
export function shouldSurfaceShimNotice(signature: string): boolean {
  if (!signature) {
    try { fs.rmSync(noticeStatePath(), { force: true }); } catch { /* best-effort */ }
    return false;
  }
  if (readLastNoticeSignature() === signature) return false;
  writeLastNoticeSignature(signature);
  return true;
}
