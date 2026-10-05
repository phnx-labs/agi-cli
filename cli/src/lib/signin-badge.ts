/** Shared login-state look, so `agents doctor`, `agents view` and the `agents run` preflight banner
 * read alike. `signedIn` is advisory (it can false-negative), so callers warn and continue,
 * never block. */
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

/** The exact command that logs a given agent in, from the registry `cliCommand` plus per-agent
 * overrides: codex/grok/ opencode use the finite subcommand `HARNESS_AUTH` wires, claude logs in
 * via `/login` in its TUI, the rest start a device/oauth flow on launch. */
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

/** Harnesses that log back in through a finite native subcommand runnable via `agents run
 * <agent>@<version> -- <args>`. Claude uses `/login` in its TUI; cursor and the rest start their
 * device/oauth flow on launch. */
export const SUBCOMMAND_LOGIN_AGENTS: readonly AgentId[] = ['codex', 'grok', 'opencode'];

/** The finite native login subcommand for a SUBCOMMAND_LOGIN_AGENTS harness, read from the one
 * `HARNESS_AUTH` row so the hint, the per-version fix and `agents doctor` agree. Null for other
 * harnesses. */
export function loginSubcommand(agent: AgentId): string | null {
  if (!SUBCOMMAND_LOGIN_AGENTS.includes(agent)) return null;
  return HARNESS_AUTH[agent].login!.join(' ');
}

/** Exact action shown beside a non-live account; every emitted command exists today. Per-device
 * harnesses (kimi/antigravity) repair on the box via `loginHint`. Named accounts use `agents
 * accounts login <harness>#<name>` or `accounts add`; workers never log in interactively. */
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

/** Whether `agents run` probes login before launch: only when it opens the interactive TUI. Off
 * for `--json`/`--quiet`, `--no-auth-check`/`AGENTS_NO_AUTH_CHECK=1`, or a signed-in rotation.
 * `forceInteractive` is load-bearing: `/continue <id>` resumes set `hasPrompt` yet open the TUI. */
/** Is a Claude run on this box authenticating from an ambient `CLAUDE_CODE_OAUTH_TOKEN` rather than
 * a per-version login? `signedIn` is read from `.claude.json`, so such versions read 'logged out'
 * though the run works (a fleet incident). */
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

/** Colored `signed in <account>` / `logged out` badge. When signed in and an account label (email,
 * else id) is derivable, it is appended in cyan; opaque-credential agents with no email still read
 * as signed in. */
export function formatSignInBadge(
  info: Pick<AccountInfo, 'signedIn' | 'email' | 'accountId'> | null | undefined,
): string {
  if (!info?.signedIn) return chalk.red('✗ logged out');
  const who = info.email ?? (info.accountId ? `id:${info.accountId}` : '');
  return who ? `${chalk.green('✓ signed in')} ${chalk.cyan(who)}` : chalk.green('✓ signed in');
}
