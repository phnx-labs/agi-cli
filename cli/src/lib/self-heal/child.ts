
export const SELF_HEAL_CHILD_CMD = '__self-heal-run';
export const SELF_HEAL_CANCEL_MSG = 'self-heal:cancel';

export function selfHealCancelMessage(): { type: typeof SELF_HEAL_CANCEL_MSG } {
  return { type: SELF_HEAL_CANCEL_MSG };
}

export interface SelfHealChildSummary {
  v: 1;
  changed: boolean;
  needsAttention: boolean;
  summary: string;
}

export async function runSelfHealChild(): Promise<number> {
  // Isolate synchronous repair from the daemon; cancellation is observed at yields and parent-reaped.
  process.on('message', (msg: unknown) => {
    if (msg && typeof msg === 'object' && (msg as { type?: unknown }).type === SELF_HEAL_CANCEL_MSG) {
      process.exit(0);
    }
  });
  process.on('disconnect', () => process.exit(0));

  const { runSelfHeal, selfHealChangedAnything, selfHealNeedsAttention, summarizeSelfHeal } =
    await import('./registry.js');
  const report = await runSelfHeal({ mode: 'safe' });
  const summary: SelfHealChildSummary = {
    v: 1,
    changed: selfHealChangedAnything(report),
    needsAttention: selfHealNeedsAttention(report),
    summary: summarizeSelfHeal(report),
  };
  // Stdout is exactly one machine-readable summary.
  process.stdout.write(JSON.stringify(summary));
  return 0;
}
