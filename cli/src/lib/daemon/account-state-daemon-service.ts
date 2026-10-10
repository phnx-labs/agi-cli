
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

export const USAGE_STATE_TICK_MS = 60_000;
export const AUTH_STATE_TICK_MS = 3 * 60_000;

const REFRESH_DEADLINE_MS = 2 * 60_000;
const NOTIFY_DEADLINE_MS = 30_000;
const ACCOUNT_TRANSITIONS_FILE = 'account-auth-transitions.json';
const FEED_POST_LAUNCH = getCliLaunch([]);

type AccountAuthRefresh = (signal: AbortSignal) => Promise<AuthProbeRow[] | void>;
type AccountTransitionNotifier = (transition: DeadAccountTransition) => Promise<void>;

interface AccountTransitionState {
  version: 2;
  entries: Record<string, { verdict: AuthVerdict; checkedAt: number }>;
  pending: Record<string, DeadAccountTransition>;
}

interface DeadAccountTransition {
  agent: AuthProbeRow['agent'];
  account: string;
  verdict: 'expired' | 'revoked';
}

interface AccountAuthServiceOptions {
  stateFile?: string;
  notify?: AccountTransitionNotifier;
}

function abortRejection(signal: AbortSignal, label: string): Promise<never> {
  return new Promise<never>((_, reject) => {
    if (signal.aborted) { reject(new Error(label)); return; }
    signal.addEventListener('abort', () => reject(new Error(label)), { once: true });
  });
}

export class AccountUsageService extends BasePeriodicService {
  readonly id: DaemonServiceId = 'account-state';
  readonly intervalMs = USAGE_STATE_TICK_MS;
  readonly deadlineMs = REFRESH_DEADLINE_MS;

  private readonly refresh: (signal: AbortSignal, log: DaemonContext['log']) => Promise<void>;

  constructor(refresh: (signal: AbortSignal, log: DaemonContext['log']) => Promise<void> = runUsageRefreshTick) {
    super();
    this.refresh = refresh;
  }

  protected async onStart(): Promise<void> {}
  protected async onStop(): Promise<void> {}

  protected async onTick(ctx: DaemonContext, signal: AbortSignal): Promise<void> {
    await Promise.race([
      this.refresh(signal, ctx.log),
      abortRejection(signal, 'usage refresh aborted at deadline'),
    ]);
  }
}

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

// Registered account id is stable; only unregistered legacy homes fall back to the display label, so same-email named accounts remain distinct.
function transitionKey(row: AuthProbeRow): string {
  return `${row.agent}:${row.accountId ?? row.account ?? `version:${row.version}`}`;
}

function verdictRank(verdict: AuthVerdict): number {
  switch (verdict) {
    case 'revoked': return 7;
    case 'expired': return 6;
    case 'rate_limited': return 5;
    case 'live': return 4;
    case 'unverified': return 3;
    case 'no_evidence': return 3;
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

  // Persist the transition to the outbox before notifying; delete only after success for at-least-once delivery.
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
