/**
 * The self-heal pass as its own process (`agents __self-heal-run`).
 *
 * `runSelfHeal` byte-compares every synced resource in every version home
 * against its source with synchronous reads. On a real operator box (23 version
 * homes, ~42 MB of plugin assets) that is tens of seconds of solid CPU with no
 * await in between. Run inline on the daemon's event loop it starved every other
 * service past its tick deadline, the supervisor exited for a restart, and the
 * restart ran self-heal again 30 s later: a crash loop pinning a core. The
 * daemon's self-heal tick now spawns this verb and only awaits the child, the
 * same split `__harness-update-run` uses for the harness auto-update pass.
 *
 * Stdout carries one compact JSON summary the daemon logs; nothing else is
 * written there.
 */

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

/**
 * Run one safe-mode self-heal pass and print its summary. The pass checks no
 * cancel flag mid-run (each version heal is a synchronous unit), so a cancel
 * request is honored at the first event-loop turn the pass yields: before it
 * starts or between its async steps. A pass that never yields is reaped by the
 * daemon's grace backstop.
 */
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
