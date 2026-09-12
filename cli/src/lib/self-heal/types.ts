// Unified self-heal subsystem — shared shapes.
//
// agents-cli had ~37 separate repair routines scattered across the daemon, every
// CLI startup, and a handful of commands, each hand-rolling detect+fix on its own
// trigger. This subsystem gives every repairable class of problem ONE shape — a
// HealCheck — driven by ONE runner, hosted behind TWO front doors (the daemon,
// on tiered schedules, and `agents doctor`, on demand).
//
// A check's `run()` both detects and repairs in a single pass (repair is skipped
// when `ctx.dryRun`), mirroring the existing resource heal (heal.ts) which computes
// and applies together. `mode` gates how aggressive a repair may be: 'safe' (the
// daemon default) fixes only low-risk drift and merely reports risky conditions;
// 'full' (`agents doctor --fix`) applies everything.

export type HealCheckId =
  | 'resources'
  | 'hook-runtime'
  | 'hook-manifest'
  | 'shims'
  | 'shadowing'
  | 'path'
  | 'install-staging'
  | 'menubar-helper';

/** When the daemon schedules a check. */
export type HealCadence = 'startup' | 'frequent' | 'periodic';

export interface HealCtx {
  /** 'safe' = daemon (low-risk only); 'full' = doctor --fix (everything). */
  mode: 'safe' | 'full';
  /** Detect only — never write. Powers `agents doctor` (read-only) and previews. */
  dryRun: boolean;
}

/** Outcome of one check. `ok` means nothing was wrong. */
export interface CheckResult {
  /** Things repaired (or, under dryRun, that WOULD be repaired). Human-readable. */
  fixed: string[];
  /** Detected but not auto-fixed: unfixable, or risky-in-safe-mode. Human-readable. */
  needsAttention: string[];
  /** True iff detect found nothing wrong (fixed and needsAttention both empty). */
  ok: boolean;
}

export interface HealCheck {
  id: HealCheckId;
  title: string;
  /** Restrict to these platforms; omit to run on all. */
  platforms?: NodeJS.Platform[];
  cadence: HealCadence;
  /** Detect + (repair unless dryRun). Must be headless (no TTY/prompt) and idempotent. */
  run(ctx: HealCtx): Promise<CheckResult>;
}

export interface CheckReport {
  id: HealCheckId;
  title: string;
  result: CheckResult | null;
  /** Set when the check itself threw (isolated — one check failing never aborts the run). */
  error?: string;
}

export interface SelfHealReport {
  checks: CheckReport[];
}

/** Convenience: an all-clear result. */
export function okResult(): CheckResult {
  return { fixed: [], needsAttention: [], ok: true };
}

/** Build a CheckResult from collected fixes/attention items (ok iff both empty). */
export function resultOf(fixed: string[], needsAttention: string[]): CheckResult {
  return { fixed, needsAttention, ok: fixed.length === 0 && needsAttention.length === 0 };
}
