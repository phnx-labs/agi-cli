/** The self-heal pass as its own process (`agents __self-heal-run`). Run inline, its synchronous
 * reads starved the daemon's event loop and caused a restart crash loop. The daemon spawns this
 * verb and awaits it. Stdout carries one compact JSON summary, nothing else. */

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

/** Run one safe-mode self-heal pass and print its summary. No cancel flag is checked mid-run; a
 * cancel is honored at the first event-loop yield, and a pass that never yields is reaped by the
 * daemon's grace backstop. */
export async function runSelfHealChild(): Promise<number> {
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
  process.stdout.write(JSON.stringify(summary));
  return 0;
}
