import * as fs from 'fs';
import * as path from 'path';

import { listNativeAccounts } from '../account-registry.js';
import { atomicWriteFileSync } from '../fs-atomic.js';
import { getCacheDir, readMeta } from '../state.js';
import type { AgentId } from '../types.js';
import { accountsAdviceNotification, collectAccountsAdvice } from './advise.js';

const STATE_FILE = 'accounts-advice-notified.json';

function readNotified(statePath: string): Record<string, string> {
  try {
    const parsed = JSON.parse(fs.readFileSync(statePath, 'utf-8')) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, string> : {};
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw err;
  }
}

export interface AdviceNotifyOutcome {
  harness: AgentId;
  title: string;
  result: string;
}

/**
 * Run on the headed box's usage-sync tick, after the exchange has stored every
 * peer's ledger. Sends one owner notification per harness when its keep/pause
 * advice changes; the per-week dedupKey keeps two headed boxes from both
 * sending it.
 */
export async function notifyChangedAccountsAdvice(
  now: Date = new Date(),
  statePath: string = path.join(getCacheDir(), STATE_FILE),
): Promise<AdviceNotifyOutcome[]> {
  const harnesses = [...new Set(listNativeAccounts(readMeta()).map((a) => a.agent))].sort();
  const notified = readNotified(statePath);
  const outcomes: AdviceNotifyOutcome[] = [];
  for (const harness of harnesses) {
    const note = accountsAdviceNotification(collectAccountsAdvice(harness, { now }), notified[harness] ?? null, now);
    if (!note) continue;
    const { postOwnerNotification, describeOwnerResult } = await import('../owner-notify.js');
    const sent = await postOwnerNotification({ event: 'message', title: note.title, body: note.body, dedupKey: note.dedupKey });
    notified[harness] = note.fingerprint;
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    atomicWriteFileSync(statePath, `${JSON.stringify(notified, null, 2)}\n`, 'utf-8');
    outcomes.push({ harness, title: note.title, result: describeOwnerResult(sent) });
  }
  return outcomes;
}
