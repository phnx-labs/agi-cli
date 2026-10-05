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

export function loginHint(agentId: AgentId): string {
  // File-derived login state is advisory and may false-negative; preflight warns and continues.
  const cli = AGENTS[agentId]?.cliCommand ?? agentId;
  switch (agentId) {
    case 'claude':
      return `${cli}, then /login`;
    case 'codex':
    case 'grok':
    case 'opencode':
      return `${cli} ${loginSubcommand(agentId)!}`;
    default:
      return cli;
  }
}

export const SUBCOMMAND_LOGIN_AGENTS: readonly AgentId[] = ['codex', 'grok', 'opencode'];

export function loginSubcommand(agent: AgentId): string | null {
  if (!SUBCOMMAND_LOGIN_AGENTS.includes(agent)) return null;
  return HARNESS_AUTH[agent].login!.join(' ');
}

export function fixFor(input: {
  agent: AgentId;
  verdict: AccountVerdict;
  name?: string | null;
  version?: string | null;
  provisioning?: AccountProvisioning;
  hasSlot?: boolean;
}): string | null {
  // Repair respects per-device, named-slot, and worker ownership; unverified/no-evidence has no repair command.
  const { agent, verdict } = input;
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

export function ambientClaudeToken(
  agentId: AgentId | string,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  // Ambient Claude auth supersedes missing home identity and collapses rotation to one account.
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
  // forceInteractive covers injected resume prompts that otherwise look non-interactive.
  if (o.json || o.quiet || o.authCheckDisabled || o.rotated) return false;
  return o.interactive === true || o.forceInteractive === true || (!o.hasPrompt && o.headless !== true);
}

export function formatSignInBadge(
  info: Pick<AccountInfo, 'signedIn' | 'email' | 'accountId'> | null | undefined,
): string {
  if (!info?.signedIn) return chalk.red('✗ logged out');
  const who = info.email ?? (info.accountId ? `id:${info.accountId}` : '');
  return who ? `${chalk.green('✓ signed in')} ${chalk.cyan(who)}` : chalk.green('✓ signed in');
}
