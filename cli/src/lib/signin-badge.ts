/**
 * Shared login-state LOOK. One place decides how "signed in / logged out"
 * renders and what the login command is, so `agents doctor`, `agents view`, and
 * the `agents run` preflight banner all read identically.
 *
 * The signal is `AccountInfo.signedIn` from `getAccountInfo` (file-based, cheap,
 * no Keychain ACL prompt). It is advisory — opaque-credential agents (Kimi,
 * Antigravity) and keychain-bound Claude can false-negative — so callers that act
 * on it (the run preflight) WARN and continue; they never block.
 */
import chalk from 'chalk';
import { addWorkerRefusal } from './accounts/add.js';
import { AGENTS } from './agents.js';
import type { AccountInfo } from './agents.js';
import type { AuthVerdict } from './auth-health.js';
import { HARNESS_AUTH } from './harness-auth-capabilities.js';
import { CONFIG_ENV_ISOLATED_AGENTS } from './installations/shims.js';
import type { AgentId } from './types.js';

export type AccountVerdict =
  | Exclude<AuthVerdict, 'unconfigured' | 'error'>
  | 'missing'
  | 'per-device'
  | 'ready';

export type AccountProvisioning = 'portable' | 'per-device';

/**
 * The exact command that logs a given agent in — for warn banners and nudges.
 * Driven off the registry `cliCommand` with the per-agent subcommand overrides
 * (verified against the real CLIs): codex/grok/opencode run the finite login
 * subcommand `HARNESS_AUTH` wires (`loginSubcommand`), claude logs in from
 * inside its TUI via `/login`, and the remaining agents (kimi, gemini, …) start
 * their device/oauth flow on launch.
 */
export function loginHint(agentId: AgentId): string {
  const cli = AGENTS[agentId]?.cliCommand ?? agentId;
  switch (agentId) {
    case 'claude':
      return `${cli}, then /login`;
    case 'codex':
    case 'grok':
    case 'opencode':
      return `${cli} ${loginSubcommand(agentId)!}`;
    // Warp Agent CLI has no `login` subcommand: running `warp` opens a browser
    // sign-in on launch (or set WARP_API_KEY / pass --api-key), so the default
    // bare-`warp` hint is correct.
    default:
      return cli;
  }
}

/**
 * Harnesses that log back in through a finite native subcommand runnable via
 * `agents run <agent>@<version> -- <args>`. Claude logs in from inside its TUI
 * (`/login`); cursor and the rest start their device/oauth flow on launch.
 */
export const SUBCOMMAND_LOGIN_AGENTS: readonly AgentId[] = ['codex', 'grok', 'opencode'];

/**
 * The finite native login subcommand (`login`, `login --device-auth`,
 * `auth login`) for a {@link SUBCOMMAND_LOGIN_AGENTS} harness, read from the one
 * `HARNESS_AUTH` row so every surface that spells it — the hint, the per-version
 * fix, `agents doctor` — agrees. Null for every other harness.
 */
export function loginSubcommand(agent: AgentId): string | null {
  if (!SUBCOMMAND_LOGIN_AGENTS.includes(agent)) return null;
  return HARNESS_AUTH[agent].login!.join(' ');
}

/**
 * Exact action shown beside a non-live account. Every emitted command exists
 * today — never a planned surface and never a hidden verb:
 * - Per-device harnesses (kimi/antigravity) repair on the box itself: run the
 *   harness there (`loginHint`) and complete its native login.
 * - Named accounts re-auth through `agents accounts login <harness>#<name>`.
 *   A known account with no slot on a headed device is onboarded with
 *   `agents accounts add <harness> <name>`. A worker never runs an
 *   interactive login — the hint is `add.ts`'s worker refusal (add on the
 *   personal device; this box is provisioned from the durable credential).
 * - Unnamed legacy homes use the same version-targeted command shape as
 *   doctor, so the hint never logs a different/default home in by accident.
 * - `unverified` / `no_evidence` emit nothing: the probe could not confirm state
 *   (codex/grok have no probe endpoint; a worker's token lacks the usage scope),
 *   so there is nothing to repair.
 */
export function fixFor(input: {
  agent: AgentId;
  verdict: AccountVerdict;
  name?: string | null;
  version?: string | null;
  provisioning?: AccountProvisioning;
  /** When false, this named account has no slot on this device yet. */
  hasSlot?: boolean;
}): string | null {
  const { agent, verdict } = input;
  // `no_evidence` (credential present, nothing probed/run here yet) is benign like
  // `unverified` — there is nothing to repair (PHNX-4116).
  if (verdict === 'live' || verdict === 'rate_limited' || verdict === 'unverified' || verdict === 'no_evidence' || verdict === 'ready') return null;
  if (input.provisioning === 'per-device' || verdict === 'per-device') {
    return loginHint(agent);
  }
  if (input.name) {
    const worker = addWorkerRefusal(agent, input.name);
    if (worker) return worker;
    if (input.hasSlot === false) return `agents accounts add ${agent} ${input.name}`;
    return `agents accounts login ${agent}#${input.name}`;
  }

  const version = input.version ?? null;
  if (!version || !CONFIG_ENV_ISOLATED_AGENTS.includes(agent)) return loginHint(agent);
  if (agent === 'claude') return `agents run ${agent}@${version}, then /login`;
  const sub = loginSubcommand(agent);
  if (sub) return `agents run ${agent}@${version} -- ${sub}`;
  return `agents run ${agent}@${version}`;
}

/**
 * Whether `agents run` should probe login state before launching. True only for
 * a launch that actually opens the interactive TUI — where discovering a logged-out
 * account after the fact wastes time. Suppressed when there is no preamble surface
 * (`--json`/`--quiet`), when the check is explicitly disabled
 * (`--no-auth-check` / `AGENTS_NO_AUTH_CHECK=1`), or when a rotation already picked a
 * signed-in account.
 *
 * `forceInteractive` is load-bearing: a resume of a non-native-resume agent
 * (`agents run kimi --resume`, also grok/opencode/gemini) rewrites the prompt to
 * `/continue <id>` — so `hasPrompt` is true even though the run still opens the TUI.
 * Keying only off `hasPrompt` would silently skip the warning on exactly those
 * agents (the ones the feature is for), so the resume's `forceInteractive` flag is
 * consulted directly.
 */
/**
 * Is a Claude run on this box going to authenticate from an ambient
 * `CLAUDE_CODE_OAUTH_TOKEN` rather than a per-version login?
 *
 * `AccountInfo.signedIn` is `!!email` read from a version home's `.claude.json`
 * (agents.ts), so a version with no account written there reports signed-out —
 * even though Claude Code authenticates fine from the env token and the run
 * succeeds. Rendering that as "logged out" sends people hunting a login that is
 * not missing (a real fleet incident: every version on a box read as locked out
 * while all of them answered a live prompt).
 *
 * It is also the more useful warning: an ambient token is ONE account, so every
 * version on the box resolves to it and balanced rotation across them rotates
 * nothing. `env` is a parameter so the branch is testable without mutating the
 * process environment.
 */
export function ambientClaudeToken(
  agentId: AgentId | string,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return agentId === 'claude' && (env.CLAUDE_CODE_OAUTH_TOKEN ?? '').trim().length > 0;
}

export function shouldCheckLoginBeforeLaunch(o: {
  interactive?: boolean;
  forceInteractive?: boolean;
  headless?: boolean;
  hasPrompt: boolean;
  json?: boolean;
  quiet?: boolean;
  authCheckDisabled?: boolean;
  rotated?: boolean;
}): boolean {
  if (o.json || o.quiet || o.authCheckDisabled || o.rotated) return false;
  return o.interactive === true || o.forceInteractive === true || (!o.hasPrompt && o.headless !== true);
}

/**
 * Colored `✓ signed in <account>` / `✗ logged out` badge. When signed in and an
 * account label is derivable (email, else an account id), it is appended in cyan;
 * opaque-credential agents with no email still read as signed in.
 */
export function formatSignInBadge(
  info: Pick<AccountInfo, 'signedIn' | 'email' | 'accountId'> | null | undefined,
): string {
  if (!info?.signedIn) return chalk.red('✗ logged out');
  const who = info.email ?? (info.accountId ? `id:${info.accountId}` : '');
  return who ? `${chalk.green('✓ signed in')} ${chalk.cyan(who)}` : chalk.green('✓ signed in');
}
