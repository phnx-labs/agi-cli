import { select } from '@inquirer/prompts';
import chalk from 'chalk';
import type { AgentId } from '../lib/types.js';
import { agentLabel } from '../lib/agents.js';
import { loginHint } from '../lib/signin-badge.js';
import {
  collectRunCandidates,
  readinessFromCandidate,
  isSignInRecoverable,
  type AccountReadiness,
  type RotateCandidate,
} from '../lib/accounting/rotate.js';
import { compareVersions, getGlobalDefault } from '../lib/installations/versions.js';
import { verdictLabel } from '../lib/auth-health.js';
import { isInteractiveTerminal, isPromptCancelled, requireInteractiveSelection } from './utils.js';

const CANCEL_SELECTION = '__agents_cancel_account_selection__';

interface RunAccountChoice {
  name: string;
  value: string;
  disabled?: string;
  /** Can serve a run right now: signed in, authenticated, and under quota. */
  ready: boolean;
  /** Selectable, but picking it launches the harness so you can authenticate first (RUSH-2334).
   * Mutually exclusive with `ready`; never `disabled`. */
  signInRequired: boolean;
}

/** One named account row for `agents accounts default` (reuses this picker's layout). */
export interface SwitchAccountRow {
  accountName: string;
  kind: 'provider' | 'native';
  detail: string;
  current: boolean;
  candidate: RotateCandidate | null;
}

const WINDOW_ORDER = ['session', 'week', 'sonnet_week', 'month'] as const;
const WINDOW_LABELS = {
  session: 'Session',
  week: 'Week',
  sonnet_week: 'Sonnet week',
  month: 'Month',
} as const;

function formatPercent(value: number): string {
  const rounded = Math.round(value * 10) / 10;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
}

/** Human-readable remaining capacity for every window the provider exposes. */
export function formatAccountLimits(candidate: RotateCandidate): string {
  const windows = candidate.usageSnapshot?.windows;
  if (!windows || windows.length === 0) return 'limits unavailable';

  return [...windows]
    .sort((a, b) => WINDOW_ORDER.indexOf(a.key) - WINDOW_ORDER.indexOf(b.key))
    .map((window) => {
      const left = Math.max(0, 100 - window.usedPercent);
      return left === 0
        ? `${WINDOW_LABELS[window.key]} exhausted`
        : `${WINDOW_LABELS[window.key]} ${formatPercent(left)}% left`;
    })
    .join(' · ');
}

/** Why a row cannot be picked. Only a throttle disables a row: the account is signed in but out of
 * capacity, so launching only hammers it (RUSH-2132). An auth exclusion (`signed_out`/`revoked`)
 * stays pickable because the harness TUI is the login surface (RUSH-2334). */
function disabledReason(candidate: RotateCandidate, readiness: AccountReadiness): string | undefined {
  if (readiness.ready) return undefined;
  if (isSignInRecoverable(readiness)) return undefined;
  if (readiness.reason === 'out_of_credits') return 'out of credits';

  const windows = candidate.usageSnapshot?.windows ?? [];
  const blocking = windows.filter((window) => window.key !== 'sonnet_week');
  const considered = blocking.length > 0 ? blocking : windows;
  const exhausted = considered
    .filter((window) => window.usedPercent >= 100)
    .map((window) => WINDOW_LABELS[window.key]);
  return exhausted.length > 0
    ? `${exhausted.join(' and ')} ${exhausted.length === 1 ? 'limit' : 'limits'} reached`
    : 'rate limit reached';
}

/** Build aligned picker rows with usable accounts first and unsafe rows disabled. */
export function buildRunAccountChoices(
  candidates: RotateCandidate[],
  globalDefault: string | null,
): RunAccountChoice[] {
  const rows = candidates.map((candidate) => {
    const readiness = readinessFromCandidate(candidate);
    const disabled = disabledReason(candidate, readiness);
    const signInRequired = isSignInRecoverable(readiness);
    const account = candidate.nativeAccount
      || candidate.accountLabel
      || 'account unavailable';
    const marked = candidate.version === globalDefault && !candidate.nativeAccount
      ? `${account} (default)`
      : account;
    const verdict = !readiness.ready && readiness.reason === 'revoked'
      ? 'needs re-login'
      : !readiness.ready && readiness.reason === 'signed_out'
        ? 'logged out'
        : candidate.authVerdict
          ? verdictLabel(candidate.authVerdict).toLowerCase()
          : 'live';
    return {
      candidate,
      account: marked,
      verdict,
      // An auth-blocked row shows what picking it DOES; its quota is moot until
      // there is a credential to spend it with.
      limits: !readiness.ready && readiness.reason === 'revoked'
        ? 'launch to re-authenticate'
        : !readiness.ready && readiness.reason === 'signed_out'
          ? 'launch to sign in'
          : formatAccountLimits(candidate),
      disabled,
      ready: readiness.ready,
      signInRequired,
    };
  });

  // Ready accounts first, then the ones a login would unlock (actionable), then
  // the throttled rows the user can do nothing about at this prompt.
  const rank = (row: { ready: boolean; signInRequired: boolean }): number =>
    row.ready ? 0 : row.signInRequired ? 1 : 2;
  rows.sort((a, b) => {
    if (rank(a) !== rank(b)) return rank(a) - rank(b);
    const aDefault = a.candidate.version === globalDefault;
    const bDefault = b.candidate.version === globalDefault;
    if (aDefault !== bDefault) return aDefault ? -1 : 1;
    return compareVersions(b.candidate.version, a.candidate.version);
  });

  const accountWidth = Math.max(0, ...rows.map((row) => row.account.length));
  const verdictWidth = Math.max(0, ...rows.map((row) => row.verdict.length));

  return rows.map((row) => ({
    name: [
      row.account.padEnd(accountWidth),
      row.verdict.padEnd(verdictWidth),
      row.limits,
    ].join('  '),
    value: row.candidate.nativeAccount ?? row.candidate.version,
    disabled: row.disabled,
    ready: row.ready,
    signInRequired: row.signInRequired,
  }));
}

function candidatePickerValue(candidate: RotateCandidate): string {
  return candidate.nativeAccount ?? candidate.version;
}

function switchRowStatus(row: SwitchAccountRow): { status: string; limits: string; ready: boolean } {
  if (!row.candidate) {
    return {
      status: row.kind === 'provider' ? 'credential' : 'named',
      limits: 'limits unavailable',
      ready: true,
    };
  }
  const readiness = readinessFromCandidate(row.candidate);
  const authReason = readiness.ready ? null : readiness.reason;
  const status = authReason === 'revoked'
    ? 'needs re-login'
    : authReason === 'signed_out'
      ? 'logged out'
      : authReason === 'rate_limited'
        ? 'rate limited'
        : authReason === 'out_of_credits'
          ? 'out of credits'
          : 'logged in';
  const limits = authReason === 'revoked'
    ? 'needs re-authentication'
    : authReason === 'signed_out'
      ? 'signed out'
      : formatAccountLimits(row.candidate);
  return { status, limits, ready: readiness.ready };
}

/** Aligned picker rows for `accounts default`: same columns as the run picker, but the value is the
 * named account to make default. Rows stay selectable since setting a default is not a launch. */
export function buildSwitchAccountChoices(rows: SwitchAccountRow[]): RunAccountChoice[] {
  const rendered = rows.map((row) => {
    const { status, limits, ready } = switchRowStatus(row);
    const account = row.current ? `${row.accountName} (default)` : row.accountName;
    const kind = row.kind === 'provider' ? `provider · ${row.detail}` : `native · ${row.detail}`;
    return { account, kind, status, limits, ready, value: row.accountName };
  });
  const accountWidth = Math.max(0, ...rendered.map((row) => row.account.length));
  const kindWidth = Math.max(0, ...rendered.map((row) => row.kind.length));
  const statusWidth = Math.max(0, ...rendered.map((row) => row.status.length));
  return rendered.map((row) => ({
    name: [
      row.account.padEnd(accountWidth),
      row.kind.padEnd(kindWidth),
      row.status.padEnd(statusWidth),
      row.limits,
    ].join('  '),
    value: row.value,
    ready: row.ready,
    signInRequired: false,
  }));
}

/** Prompt for the named account that becomes this harness's default; a cancelled picker writes
 * nothing. */
export async function pickSwitchAccount(agent: AgentId, rows: SwitchAccountRow[]): Promise<string | null> {
  if (!isInteractiveTerminal()) {
    requireInteractiveSelection(`Selecting a ${agentLabel(agent)} account`, [
      `agents accounts default ${agent} <account>`,
    ]);
  }
  if (rows.length === 0) {
    throw new Error(`No named accounts for ${agent}. Add one with 'agents accounts add ${agent} [name]'.`);
  }
  const choices = buildSwitchAccountChoices(rows).map(
    ({ ready: _ready, signInRequired: _signInRequired, ...choice }) => choice,
  );
  try {
    return await select({
      message: `Select the default ${agentLabel(agent)} account:`,
      choices,
      loop: false,
    });
  } catch (err) {
    if (isPromptCancelled(err)) return null;
    throw err;
  }
}

/** The two-condition 'human-facing' check behind signInLaunchDecision and noVerifiedUsageDecision:
 * a real TTY and no `--json`. `--json` marks a machine consumer that must never get a picker or
 * login TUI. Mirrors `Surface.interactive` in `commands/utils.ts`. */
export function isHumanFacingRun(input: { tty: boolean; json: boolean }): boolean {
  return input.tty && !input.json;
}

/** Whether a zero-healthy run may recover by launching for a login, or must fail loud. All must
 * hold: `recoverable` (an excluded account is only auth-blocked; all-throttled is never launched,
 * RUSH-2132), `tty` (a login needs a human), and not `json`. */
export function signInLaunchDecision(
  input: { recoverable: number; tty: boolean; json: boolean },
): 'launch' | 'fail-loud' {
  const humanPresent = isHumanFacingRun(input);
  return input.recoverable > 0 && humanPresent ? 'launch' : 'fail-loud';
}

/** How a `balanced`/`available` run reacts when every account's usage is stale and none verified
 * (PHNX-2526): a human at a terminal gets the picker; every unattended shape (`--headless`,
 * `--json`, no TTY) fails loud with NO_VERIFIED_USAGE. */
export function noVerifiedUsageDecision(
  input: { tty: boolean; json: boolean; headless: boolean },
): 'picker' | 'fail-loud' {
  const humanPresent = input.tty && !input.json && !input.headless;
  return humanPresent ? 'picker' : 'fail-loud';
}

/** Choose which installed version to launch so the user can authenticate, when a strategy found
 * zero healthy accounts but one is merely signed out (RUSH-2334); null on cancel. A single
 * candidate doesn't prompt; several go to the account picker. Callers must have confirmed a TTY. */
export async function pickSignInLaunchVersion(
  agent: AgentId,
  recoverable: RotateCandidate[],
  quiet = false,
): Promise<string | null> {
  if (recoverable.length === 0) return null;

  if (recoverable.length > 1) {
    const selected = await pickRunAccountCandidate(agent);
    return selected?.version ?? null;
  }

  const [only] = recoverable;
  if (!quiet) {
    const readiness = readinessFromCandidate(only);
    const why = !readiness.ready && readiness.reason === 'revoked'
      ? 'has no valid credential (the server rejected its token)'
      : 'has no signed-in account';
    process.stderr.write(chalk.yellow(
      `${agentLabel(agent)} ${why} — launching ${agent}@${only.version} so you can sign in.\n`,
    ));
    process.stderr.write(chalk.gray(`Sign in with: ${loginHint(agent)}\n`));
  }
  return only.version;
}

/** Prompt for one safe installed account/version. A cancelled picker launches nothing. */
export async function pickRunAccountCandidate(agent: AgentId): Promise<RotateCandidate | null> {
  if (!isInteractiveTerminal()) {
    requireInteractiveSelection(`Selecting a ${agentLabel(agent)} account`, [
      `agents run ${agent}@<version>`,
      `agents view ${agent}`,
    ]);
  }

  const candidates = await collectRunCandidates(agent);
  if (candidates.length === 0) {
    throw new Error(`No installed ${agentLabel(agent)} versions are available. Run: agents add ${agent}@latest`);
  }

  const choices = buildRunAccountChoices(candidates, getGlobalDefault(agent));
  // 'Selectable' is broader than 'ready': an auth-blocked row is pickable so the launch can carry
  // you into the login (RUSH-2334). Offer the bail-out row only when nothing can be chosen, i.e.
  // every account is throttled, which signing in doesn't fix.
  const hasSelectableAccount = choices.some((choice) => !choice.disabled);
  const needsSignIn = choices.some((choice) => choice.signInRequired);
  const promptChoices = choices.map(
    ({ ready: _ready, signInRequired: _signInRequired, ...choice }) => choice,
  );
  if (!hasSelectableAccount) {
    promptChoices.push({
      name: 'No usable accounts — cancel',
      value: CANCEL_SELECTION,
    });
  }

  try {
    const picked = await select({
      message: needsSignIn
        ? `Select a ${agentLabel(agent)} account for this run (pick a logged-out one to sign in):`
        : `Select a ${agentLabel(agent)} account for this run:`,
      choices: promptChoices,
      loop: false,
    });
    if (picked === CANCEL_SELECTION) return null;
    return candidates.find((candidate) => candidatePickerValue(candidate) === picked) ?? null;
  } catch (err) {
    if (isPromptCancelled(err)) return null;
    throw err;
  }
}
