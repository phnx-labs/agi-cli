/**
 * Account-state services as supervised `PeriodicService`s (PHNX-3608).
 *
 * The daemon owns usage and authentication health as first-party device state.
 * This used to run its OWN two `setInterval` loops behind a `usageRunning` /
 * `authRunning` latch with NO deadline (`account-state-service.ts`, now removed):
 * a `runUsageRefreshTick` that hung on an unbounded provider await latched
 * `usageRunning = true` forever, so the usage cache froze for the daemon's whole
 * life while the service still looked healthy — the "12h usage-dark" root cause.
 *
 * Now usage and auth are TWO independent supervised services, each with its own
 * timer, per-tick deadline, AbortSignal, and — crucially — its own circuit
 * breaker (`AccountUsageService` = `account-state`, `AccountAuthService` =
 * `account-auth`). Keeping them separate means a run of usage-refresh failures
 * parks ONLY usage and never starves the slower auth refresh (they hit different
 * endpoints), matching the old design's independent loops. Each threads its
 * deadline AbortSignal into its refresh so the tick unwinds at the deadline
 * instead of blocking; the provider fetch is itself already bounded
 * (`AbortSignal.timeout` at the leaf), and the supervisor abandons + restarts a
 * hung tick regardless.
 */

import * as fsp from 'node:fs/promises';
import * as path from 'node:path';

import { BasePeriodicService, type DaemonContext } from './service.js';
import type { DaemonServiceId } from '../daemon-services.js';
import { runUsageRefreshTick, refreshLocalFleetAuthState } from '../daemon-ticks.js';
import type { AuthProbeRow, AuthVerdict } from '../auth-health.js';
import { getDaemonDir } from '../state.js';
import { getCliLaunch } from '../cli-entry.js';
import { execFileBounded } from '../exec-bounded.js';
import { fleetSharedStatePath, FLEET_SHARED_STATE_VERSION } from '../fleet-shared-state.js';
import { withFileLockAsync } from '../fs-atomic.js';
import { machineId } from '../machine-id.js';
import { getConfigValueAsync, isHeadedDeviceRole, type ConfiguredDeviceRole } from '../device-config.js';
import { harnessWorkerIsPerDevice } from '../harness-auth-capabilities.js';

/** Usage cache refresh cadence. */
export const USAGE_STATE_TICK_MS = 60_000;
/** Fleet-auth refresh cadence — deliberately slower (rate-limited endpoint). */
export const AUTH_STATE_TICK_MS = 3 * 60_000;

/** A hung refresh is abandoned at this deadline; a real sweep is far under it. */
const REFRESH_DEADLINE_MS = 2 * 60_000;
const NOTIFY_DEADLINE_MS = 30_000;
const ACCOUNT_TRANSITIONS_FILE = 'account-auth-transitions.json';
// Resolve the current CLI once at daemon startup. getCliLaunch performs sync
// filesystem probes, so it must never run inside a service tick.
const FEED_POST_LAUNCH = getCliLaunch([]);

type AccountAuthRefresh = (signal: AbortSignal) => Promise<AuthProbeRow[] | void>;
type AccountTransitionNotifier = (transition: DeadAccountTransition) => Promise<void>;

interface AccountTransitionState {
  version: 2;
  entries: Record<string, { verdict: AuthVerdict; checkedAt: number }>;
  /**
   * Outbox of transitions whose owner-important feed post has not yet
   * succeeded. An entry is enqueued BEFORE delivery is attempted and removed
   * only after the notifier resolves, so a failed post (or a daemon restart
   * mid-attempt) is retried on the next tick instead of being silently
   * swallowed. `feed post` has no idempotency key, so a crash between a
   * successful post and the state write can still re-send once — the semantic
   * is at-least-once, never zero.
   */
  pending: Record<string, DeadAccountTransition>;
}

interface DeadAccountTransition {
  agent: AuthProbeRow['agent'];
  /** Display label (email / account name) — presentation only, never a key. */
  account: string;
  verdict: 'expired' | 'revoked';
}

interface AccountAuthServiceOptions {
  stateFile?: string;
  notify?: AccountTransitionNotifier;
}

/**
 * A promise that rejects when `signal` aborts (immediately if already aborted),
 * so a tick can `Promise.race` its work against the supervisor's deadline and
 * unwind instead of blocking on an await that may never settle. The signal is
 * per-tick, so the once-listener is dropped with it — no cross-tick leak.
 */
function abortRejection(signal: AbortSignal, label: string): Promise<never> {
  return new Promise<never>((_, reject) => {
    if (signal.aborted) { reject(new Error(label)); return; }
    signal.addEventListener('abort', () => reject(new Error(label)), { once: true });
  });
}

/**
 * Refresh the usage cache the `agents run` router reads. Independent circuit
 * breaker from auth — a persistently-failing usage endpoint parks only this.
 */
export class AccountUsageService extends BasePeriodicService {
  readonly id: DaemonServiceId = 'account-state';
  readonly intervalMs = USAGE_STATE_TICK_MS;
  readonly deadlineMs = REFRESH_DEADLINE_MS;

  private readonly refresh: (signal: AbortSignal) => Promise<void>;

  constructor(refresh: (signal: AbortSignal) => Promise<void> = runUsageRefreshTick) {
    super();
    this.refresh = refresh;
  }

  protected async onStart(): Promise<void> {}
  protected async onStop(): Promise<void> {}

  protected async onTick(_ctx: DaemonContext, signal: AbortSignal): Promise<void> {
    await Promise.race([
      this.refresh(signal),
      abortRejection(signal, 'usage refresh aborted at deadline'),
    ]);
  }
}

/**
 * Publish this host's fleet-status row and refresh auth health. Independent
 * circuit breaker from usage, and on a slower cadence (the auth verdict rides a
 * rate-limited endpoint).
 */
export class AccountAuthService extends BasePeriodicService {
  readonly id: DaemonServiceId = 'account-auth';
  readonly intervalMs = AUTH_STATE_TICK_MS;
  readonly deadlineMs = REFRESH_DEADLINE_MS;

  private readonly refresh: AccountAuthRefresh;
  private readonly stateFile: string;
  private readonly notify: AccountTransitionNotifier;

  constructor(
    refresh: AccountAuthRefresh = async (signal) => (await refreshLocalFleetAuthState({ signal })).authRows,
    options: AccountAuthServiceOptions = {},
  ) {
    super();
    this.refresh = refresh;
    this.stateFile = options.stateFile ?? path.join(getDaemonDir(), ACCOUNT_TRANSITIONS_FILE);
    this.notify = options.notify ?? postImportantAccountTransition;
  }

  protected async onStart(): Promise<void> {}
  protected async onStop(): Promise<void> {}

  protected async onTick(_ctx: DaemonContext, signal: AbortSignal): Promise<void> {
    const rows = await Promise.race([
      this.refresh(signal),
      abortRejection(signal, 'auth refresh aborted at deadline'),
    ]);
    if (rows) {
      await publishAccountDaemonStateRows(rows);
      await processAccountAuthTransitions(rows, {
        stateFile: this.stateFile,
        notify: this.notify,
      });
    }
  }
}

export async function publishAccountDaemonStateRows(
  rows: readonly AuthProbeRow[],
  userAgentsDir?: string,
): Promise<void> {
  const device = machineId();
  const file = fleetSharedStatePath(device, userAgentsDir);
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const handle = await fsp.open(file, 'a', 0o600);
  await handle.close();
  const role = (await getConfigValueAsync('role', { device })).value as ConfiguredDeviceRole | undefined;
  const headed = isHeadedDeviceRole(role);
  const accountRows = [...collapseAccountRows(rows).values()].map((row) => ({
    // The registered account id is the only stable identity: two accounts may
    // share one email (different orgs), so the display label is never a key.
    // Unregistered legacy homes have no registry id and fall back to the label.
    accountId: row.accountId ?? row.account ?? row.version,
    identityLabel: row.account,
    harness: row.agent,
    authMode: harnessWorkerIsPerDevice(row.agent)
      ? 'per-device'
      : headed ? 'native' : 'durable',
    verdict: row.health.verdict === 'unconfigured'
      ? 'missing'
      : row.health.verdict === 'error' ? 'unverified' : row.health.verdict,
    checkedAt: new Date(row.health.checkedAt).toISOString(),
  }));
  await withFileLockAsync(file, async () => {
    const raw = await fsp.readFile(file, 'utf-8');
    let current: Record<string, unknown> = {};
    if (raw.trim()) {
      const parsed = JSON.parse(raw) as unknown;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error(`Cannot publish account state: ${file} is not an object.`);
      }
      current = parsed as Record<string, unknown>;
      if (current.device !== device || current.version !== FLEET_SHARED_STATE_VERSION) {
        throw new Error(`Cannot publish account state: ${file} has an unrecognized owner or version.`);
      }
    }
    const next = {
      ...current,
      version: FLEET_SHARED_STATE_VERSION,
      device,
      accounts: { rows: accountRows },
    };
    const serialized = `${JSON.stringify(next, null, 2)}\n`;
    if (serialized === raw) return;
    const temp = `${file}.${process.pid}.accounts.tmp`;
    await fsp.writeFile(temp, serialized, { mode: 0o600 });
    await fsp.rename(temp, file);
  });
}

function transitionKey(row: AuthProbeRow): string {
  // Stable identity first (registered account id); the display label is the
  // fallback for unregistered legacy homes, never the key for a named account.
  return `${row.agent}:${row.accountId ?? row.account ?? `version:${row.version}`}`;
}

function verdictRank(verdict: AuthVerdict): number {
  switch (verdict) {
    case 'revoked': return 7;
    case 'expired': return 6;
    case 'rate_limited': return 5;
    case 'live': return 4;
    case 'unverified': return 3;
    case 'error': return 2;
    case 'unconfigured': return 1;
  }
}

function collapseAccountRows(rows: readonly AuthProbeRow[]): Map<string, AuthProbeRow> {
  const accounts = new Map<string, AuthProbeRow>();
  for (const row of rows) {
    const key = transitionKey(row);
    const current = accounts.get(key);
    if (!current || verdictRank(row.health.verdict) > verdictRank(current.health.verdict)) {
      accounts.set(key, row);
    }
  }
  return accounts;
}

async function readTransitionState(file: string): Promise<AccountTransitionState> {
  try {
    const parsed = JSON.parse(await fsp.readFile(file, 'utf-8')) as { version?: number } & Omit<Partial<AccountTransitionState>, 'version'>;
    if ((parsed.version === 1 || parsed.version === 2) && parsed.entries && typeof parsed.entries === 'object') {
      // Version 1 files predate the outbox; they upgrade with an empty one.
      return { version: 2, entries: parsed.entries, pending: parsed.pending ?? {} };
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw new Error(`Cannot read account transition state at ${file}: ${(error as Error).message}`);
    }
  }
  return { version: 2, entries: {}, pending: {} };
}

async function writeTransitionState(file: string, state: AccountTransitionState): Promise<void> {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  await fsp.writeFile(temp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  await fsp.rename(temp, file);
}

/**
 * Detect live → expired/revoked transitions and deliver one owner-important
 * feed post each, through a persisted outbox:
 *
 * 1. Newly-dead accounts are ENQUEUED into `pending` and the state is written
 *    BEFORE any delivery is attempted — a crash or a failed sink can never
 *    strand a transition in the already-recorded `entries` with no retry.
 * 2. Every pending item (fresh and retried) is delivered; an item leaves
 *    `pending` only after its notifier resolves, and the state is written
 *    again. A crash in the narrow window between a successful post and that
 *    second write re-sends once — at-least-once, never zero.
 *
 * Delivery failures keep their outbox entries AND throw after the state is
 * durable, so the supervisor's circuit breaker still sees the unhealthy tick.
 */
export async function processAccountAuthTransitions(
  rows: readonly AuthProbeRow[],
  options: { stateFile?: string; notify?: AccountTransitionNotifier } = {},
): Promise<DeadAccountTransition[]> {
  const file = options.stateFile ?? path.join(getDaemonDir(), ACCOUNT_TRANSITIONS_FILE);
  const notify = options.notify ?? postImportantAccountTransition;
  const previous = await readTransitionState(file);
  const next: AccountTransitionState = {
    version: 2,
    entries: { ...previous.entries },
    pending: { ...previous.pending },
  };

  for (const [key, row] of collapseAccountRows(rows)) {
    const before = previous.entries[key]?.verdict;
    const after = row.health.verdict;
    next.entries[key] = { verdict: after, checkedAt: row.health.checkedAt };
    if (before === 'live' && (after === 'expired' || after === 'revoked') && !next.pending[key]) {
      next.pending[key] = {
        agent: row.agent,
        account: row.account ?? row.version,
        verdict: after,
      };
    }
  }

  // Durable BEFORE delivery: a pending entry survives a crash mid-notify.
  await writeTransitionState(file, next);

  const delivered: DeadAccountTransition[] = [];
  const failures: string[] = [];
  for (const [key, transition] of Object.entries(next.pending)) {
    try {
      await notify(transition);
      delete next.pending[key];
      delivered.push(transition);
    } catch (error) {
      failures.push(`${transition.agent} account ${transition.account}: ${(error as Error).message}`);
    }
  }
  await writeTransitionState(file, next);
  if (failures.length > 0) {
    throw new Error(`Account expiry notification failed (kept in the outbox for the next tick): ${failures.join('; ')}`);
  }
  return delivered;
}

async function postImportantAccountTransition(transition: DeadAccountTransition): Promise<void> {
  const title = `${transition.agent} account ${transition.verdict}`;
  const text = `${transition.agent} account ${transition.account} changed from live to ${transition.verdict}. Run agents accounts list ${transition.agent} for the exact fix.`;
  const args = [...FEED_POST_LAUNCH.args,
    'feed', 'post',
    '--session', 'account-state-daemon',
    '--title', title,
    '--level', 'important',
    text,
  ];
  const result = await execFileBounded(FEED_POST_LAUNCH.command, args, { timeoutMs: NOTIFY_DEADLINE_MS });
  if (result.code !== 0) {
    const detail = result.timedOut ? 'timed out' : (result.stderr.trim() || `exit ${result.code}`);
    throw new Error(`Account expiry feed notification failed: ${detail}`);
  }
}
