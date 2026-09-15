/**
 * Per-harness auth capability table (PHNX-3940).
 *
 * One row per `ALL_AGENT_IDS` entry. Governs `accounts add` / connect login
 * argv, identity strength, the durable worker credential (if any), and the
 * config-dir env that pins a slot. Completeness is pinned by the test against
 * `ALL_AGENT_IDS` — a new harness without a row is a type error and a failing
 * test, never a silent skip.
 *
 * Values are taken from evidence-harness-auth.md (2026-09-06) and the adapters
 * under `lib/harness/adapters/`. `LOGIN_INVOCATIONS` is the connect-era subset
 * (claude, codex) derived from this table so existing connect callers keep
 * working until T4 folds connect into `accounts add`.
 */
import type { AgentId } from './types.js';

type HarnessIdentityKind = 'strong' | 'email' | 'opaque';

/**
 * Durable worker credential, or `none` when the harness must log in per box.
 * Codex is both: an API key (portable, bills the API) OR a per-device
 * ChatGPT-plan device-auth login (the plan seat; never stored in the reserved
 * store because it is a rotating session).
 */
type HarnessWorkerKind =
  | 'setup-token'
  | 'none'
  | `api-key:${string}`
  | `per-device${'' | `:${string}`}`;

type HarnessWorker = HarnessWorkerKind | HarnessWorkerKind[];

interface HarnessAuthCapability {
  /** argv after the harness binary to start native login, or null when there is no finite login command. */
  login: string[] | null;
  /** argv to probe login status, or null when the CLI has no status command. */
  status: string[] | null;
  identity: HarnessIdentityKind;
  worker: HarnessWorker;
  /** Config-dir env that pins a slot, or null when isolation is HOME-swap only. */
  slotEnv: string | null;
}

export const HARNESS_AUTH: Record<AgentId, HarnessAuthCapability> = {
  claude: { login: ['auth', 'login'], status: ['auth', 'status'], identity: 'strong', worker: 'setup-token', slotEnv: 'CLAUDE_CONFIG_DIR' },
  codex: { login: ['login'], status: ['login', 'status'], identity: 'strong', worker: ['api-key:OPENAI_API_KEY', 'per-device:device-auth'], slotEnv: 'CODEX_HOME' },
  // `--device-auth` pins the device-code flow: bare `grok login` defaults to
  // `--oauth`, the loopback browser flow, which opens whatever browser profile
  // the OS defaults to. The device-code screen prints the URL + code instead,
  // so the human finishes it in the browser profile they choose — which is
  // what makes it usable over an SSH shell on a worker.
  grok: { login: ['login', '--device-auth'], status: null, identity: 'strong', worker: 'api-key:XAI_API_KEY', slotEnv: 'GROK_HOME' },
  // auth.json has no email claim; identity is the sorted provider-id join
  // (`resolveOpenCodeAccountId`). NATIVE_ACCOUNT_CAPABILITIES.opencode.inspection
  // is already 'opaque'.
  opencode: { login: ['auth', 'login'], status: ['auth', 'list'], identity: 'opaque', worker: 'api-key:provider', slotEnv: 'XDG_DATA_HOME' },
  cursor: { login: ['login'], status: ['status'], identity: 'strong', worker: 'api-key:CURSOR_API_KEY', slotEnv: null },
  // No finite login argv — launch bare `kimi`, then `/login` in the TUI
  // (`loginHint('kimi') === 'kimi'`).
  kimi: { login: null, status: null, identity: 'opaque', worker: 'none', slotEnv: 'KIMI_CODE_HOME' },
  antigravity: { login: null, status: null, identity: 'opaque', worker: 'none', slotEnv: null },
  droid: { login: null, status: null, identity: 'opaque', worker: 'api-key:FACTORY_API_KEY', slotEnv: null },
  copilot: { login: null, status: null, identity: 'opaque', worker: 'none', slotEnv: 'COPILOT_HOME' },
  openclaw: { login: null, status: null, identity: 'opaque', worker: 'none', slotEnv: null },
  amp: { login: null, status: null, identity: 'opaque', worker: 'none', slotEnv: null },
  goose: { login: null, status: null, identity: 'opaque', worker: 'none', slotEnv: null },
  hermes: { login: null, status: null, identity: 'opaque', worker: 'none', slotEnv: null },
  // Auth lives under $XDG_CONFIG_HOME/muse (adapter pins XDG_CONFIG_HOME +
  // XDG_DATA_HOME). slotEnv names the config pin; T5 must not HOME-swap.
  muse: { login: null, status: null, identity: 'email', worker: 'none', slotEnv: 'XDG_CONFIG_HOME' },
  warp: { login: null, status: null, identity: 'opaque', worker: 'none', slotEnv: null },
};

export function harnessAuth(agent: AgentId): HarnessAuthCapability {
  const cap = HARNESS_AUTH[agent];
  if (!cap) throw new Error(`No harness-auth capability for '${agent}'.`);
  return cap;
}

/** Worker kinds as a flat list (codex's dual path is two entries). */
export function harnessWorkerKinds(agent: AgentId): HarnessWorkerKind[] {
  const worker = harnessAuth(agent).worker;
  return Array.isArray(worker) ? worker : [worker];
}

/**
 * True when this harness has no portable worker credential and must log in
 * per box. `worker: 'none'` (kimi, antigravity, …) and a sole `per-device…`
 * kind both count; a dual path like Codex (API key OR device-auth) does not.
 */
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
  /** argv passed to the installed binary to start the native login. */
  args: string[];
  /** Flag that pre-fills the login email (appended as `[emailFlag, email]`), when supported. */
  emailFlag?: string;
  /** One-line hint shown before the login flow takes over. */
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
