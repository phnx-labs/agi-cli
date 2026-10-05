
import fs from 'node:fs';
import path from 'node:path';
import { getRuntimeStateDir } from './state.js';
import type { SelfHealReport } from './self-heal/types.js';

interface InteractiveShimHealResult {
  noticeLines: string[] | null;
  report: SelfHealReport;
}

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
  }
}

export function shouldSurfaceShimNotice(signature: string): boolean {
  if (!signature) {
    try { fs.rmSync(noticeStatePath(), { force: true }); } catch {  }
    return false;
  }
  if (readLastNoticeSignature() === signature) return false;
  writeLastNoticeSignature(signature);
  return true;
}
