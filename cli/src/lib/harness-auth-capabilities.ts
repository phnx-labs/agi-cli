// This table is complete for every agent: workers may use portable setup/API tokens but never rotating native sessions; headed devices retain native auth.
// Login invocations contain only finite real commands.
import type { AgentId } from './types.js';

type HarnessIdentityKind = 'strong' | 'email' | 'opaque';

/**
 * Durable worker credential, or `none` when the harness must log in per box.
 * Codex and Grok are both: an API key (portable, bills the API) OR a
 * per-device device-auth login (the subscription seat — ChatGPT plan,
 * SuperGrok, X Premium+; never stored in the reserved store because it is a
 * rotating session, so each box signs in for itself).
 */
type HarnessWorkerKind =
  | 'setup-token'
  | 'none'
  | `api-key:${string}`
  | `per-device${'' | `:${string}`}`;

type HarnessWorker = HarnessWorkerKind | HarnessWorkerKind[];

interface HarnessAuthCapability {
  login: string[] | null;
  status: string[] | null;
  identity: HarnessIdentityKind;
  worker: HarnessWorker;
  slotEnv: string | null;
}

export const HARNESS_AUTH: Record<AgentId, HarnessAuthCapability> = {
  claude: { login: ['auth', 'login'], status: ['auth', 'status'], identity: 'strong', worker: 'setup-token', slotEnv: 'CLAUDE_CONFIG_DIR' },
  codex: { login: ['login'], status: ['login', 'status'], identity: 'strong', worker: ['api-key:OPENAI_API_KEY', 'per-device:device-auth'], slotEnv: 'CODEX_HOME' },
  grok: { login: ['login', '--device-auth'], status: null, identity: 'strong', worker: ['api-key:XAI_API_KEY', 'per-device:device-auth'], slotEnv: 'GROK_HOME' },
  opencode: { login: ['auth', 'login'], status: ['auth', 'list'], identity: 'opaque', worker: 'api-key:provider', slotEnv: 'XDG_DATA_HOME' },
  cursor: { login: ['login'], status: ['status'], identity: 'strong', worker: 'api-key:CURSOR_API_KEY', slotEnv: null },
  kimi: { login: null, status: null, identity: 'opaque', worker: 'none', slotEnv: 'KIMI_CODE_HOME' },
  antigravity: { login: null, status: null, identity: 'opaque', worker: 'none', slotEnv: null },
  droid: { login: null, status: null, identity: 'opaque', worker: 'api-key:FACTORY_API_KEY', slotEnv: null },
  copilot: { login: null, status: null, identity: 'opaque', worker: 'none', slotEnv: 'COPILOT_HOME' },
  openclaw: { login: null, status: null, identity: 'opaque', worker: 'none', slotEnv: null },
  amp: { login: null, status: null, identity: 'opaque', worker: 'none', slotEnv: null },
  goose: { login: null, status: null, identity: 'opaque', worker: 'none', slotEnv: null },
  hermes: { login: null, status: null, identity: 'opaque', worker: 'none', slotEnv: null },
  muse: { login: null, status: null, identity: 'email', worker: 'none', slotEnv: 'XDG_CONFIG_HOME' },
  warp: { login: null, status: null, identity: 'opaque', worker: 'none', slotEnv: null },
};

export function harnessAuth(agent: AgentId): HarnessAuthCapability {
  const cap = HARNESS_AUTH[agent];
  if (!cap) throw new Error(`No harness-auth capability for '${agent}'.`);
  return cap;
}

export function harnessWorkerKinds(agent: AgentId): HarnessWorkerKind[] {
  const worker = harnessAuth(agent).worker;
  return Array.isArray(worker) ? worker : [worker];
}

export function harnessWorkerIsPerDevice(agent: AgentId): boolean {
  return harnessWorkerKinds(agent).every((kind) => kind === 'none' || kind.startsWith('per-device'));
}

/**
 * Native-login invocation per harness. Only harnesses with a REAL, finite login
 * COMMAND that connect currently drives — connect fails clearly for anything
 * else rather than faking a flow that never signs the user in. Verified against
 * the installed CLIs (PHNX-3940): `claude auth login --help` → "Sign in to your
 * Anthropic account" with `--email`; `codex login` drives the OAuth flow.
 * Args are the `HARNESS_AUTH.login` values for the same ids.
 */
export interface LoginInvocation {
  args: string[];
  emailFlag?: string;
  hint?: string;
}

export const LOGIN_INVOCATIONS: Partial<Record<AgentId, LoginInvocation>> = {
  claude: {
    args: HARNESS_AUTH.claude.login!,
    emailFlag: '--email',
    hint: 'Complete the Claude sign-in in your browser.',
  },
  codex: { args: HARNESS_AUTH.codex.login! },
};
