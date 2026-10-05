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
  ready: boolean;
  signInRequired: boolean;
}

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

function disabledReason(candidate: RotateCandidate, readiness: AccountReadiness): string | undefined {
  // Only throttling disables a row: signed-out or revoked accounts stay selectable because the harness TUI is their login surface.
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

/**
 * Aligned picker rows for `accounts default`. Same columns as the run picker
 * (identity, status, limits) but the value is the named account to make default.
 * Rows stay selectable: setting a default is not a launch.
 */
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

/**
 * Prompt for the named account that becomes this harness's default.
 * A cancelled picker writes nothing.
 */
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

/**
 * The two-condition "human-facing" gate behind signInLaunchDecision and
 * noVerifiedUsageDecision: a real TTY and no `--json`. Off a TTY nobody can
 * answer a prompt, and `--json` marks a MACHINE consumer, which must never be
 * handed a picker or dropped into a login TUI. Mirrors the canonical
 * `Surface.interactive = tty && !json` in `commands/utils.ts`.
 */
export function isHumanFacingRun(input: { tty: boolean; json: boolean }): boolean {
  return input.tty && !input.json;
}

/**
 * Whether a zero-healthy run may recover by launching for a login, or must keep
 * failing loud. Three inputs, all of which have to hold:
 *
 * - `recoverable` — at least one excluded account is only auth-blocked. An
 *   all-throttled set is never launched (RUSH-2132): only a window reset clears it.
 * - `tty` — a login needs a human present; off a TTY nobody can complete one.
 * - `json` — `--json` marks a MACHINE consumer, which must never be handed a
 *   picker or dropped into a login TUI. This mirrors the canonical
 *   `Surface.interactive = tty && !json` in `commands/utils.ts`; a `--json` caller
 *   gets the parseable fail-loud error instead.
 */
export function signInLaunchDecision(
  input: { recoverable: number; tty: boolean; json: boolean },
): 'launch' | 'fail-loud' {
  const humanPresent = isHumanFacingRun(input);
  return input.recoverable > 0 && humanPresent ? 'launch' : 'fail-loud';
}

export function noVerifiedUsageDecision(
  input: { tty: boolean; json: boolean; headless: boolean },
): 'picker' | 'fail-loud' {
  // Stale or absent usage may prompt only an attended non-JSON TTY; automation must fail loud rather than guess.
  const humanPresent = input.tty && !input.json && !input.headless;
  return humanPresent ? 'picker' : 'fail-loud';
}

export async function pickSignInLaunchVersion(
  agent: AgentId,
  recoverable: RotateCandidate[],
  quiet = false,
): Promise<string | null> {
  // An all-throttled candidate set must never reach the harness login flow.
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
  // "Selectable" is broader than "ready": an auth-blocked row is pickable so the
  // launch can carry you into the harness's login (RUSH-2334). Only offer the
  // bail-out row when literally nothing can be chosen — i.e. every account is
  // throttled, which no amount of signing in fixes.
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
