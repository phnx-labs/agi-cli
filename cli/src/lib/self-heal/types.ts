
export type HealCheckId =
  | 'resources'
  | 'hook-runtime'
  | 'hook-manifest'
  | 'shims'
  | 'shadowing'
  | 'path'
  | 'install-staging'
  | 'menubar-helper';

export type HealCadence = 'startup' | 'frequent' | 'periodic';

export interface HealCtx {
  mode: 'safe' | 'full';
  dryRun: boolean;
}

export interface CheckResult {
  fixed: string[];
  needsAttention: string[];
  ok: boolean;
}

export interface HealCheck {

  id: HealCheckId;
  title: string;
  platforms?: NodeJS.Platform[];
  cadence: HealCadence;
  run(ctx: HealCtx): Promise<CheckResult>;
}

export interface CheckReport {
  id: HealCheckId;
  title: string;
  result: CheckResult | null;
  error?: string;
}

export interface SelfHealReport {
  checks: CheckReport[];
}

export function okResult(): CheckResult {
  return { fixed: [], needsAttention: [], ok: true };
}

export function resultOf(fixed: string[], needsAttention: string[]): CheckResult {
  return { fixed, needsAttention, ok: fixed.length === 0 && needsAttention.length === 0 };
}
