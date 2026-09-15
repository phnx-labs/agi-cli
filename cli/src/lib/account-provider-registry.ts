import type { AgentId } from './types.js';

export type AccountAuthKind = 'api-key' | 'setup-token' | 'bearer-token';

export interface AccountProviderAdapter {
  provider: string;
  authKinds: readonly AccountAuthKind[];
  envFor(host: AgentId, kind: AccountAuthKind): string;
  connectionEnvFor(host: AgentId): Record<string, string>;
  /**
   * The env var a per-account BASE_URL override should be written to for this
   * host, or null when the provider has no endpoint env on that host. Derived
   * from the provider's own connection env so the base-url key lives in one
   * place instead of being re-guessed by callers.
   */
  baseUrlEnvFor(host: AgentId): string | null;
  validate(kind: AccountAuthKind, value: string): void;
}

const nonEmpty = (provider: string, kind: AccountAuthKind, value: string): void => {
  if (!value.trim()) throw new Error(`${provider} ${kind} cannot be empty.`);
};

function fixed(
  provider: string,
  authKinds: readonly AccountAuthKind[],
  envByHost: Partial<Record<AgentId, string>>,
  connectionEnvByHost: Partial<Record<AgentId, Record<string, string>>> = {},
  baseUrlEnvByHost: Partial<Record<AgentId, string>> = {},
  validate?: (kind: AccountAuthKind, value: string) => void,
): AccountProviderAdapter {
  return {
    provider,
    authKinds,
    envFor(host, kind) {
      if (!authKinds.includes(kind)) throw new Error(`Provider '${provider}' does not support ${kind} accounts.`);
      const env = envByHost[host];
      if (!env) throw new Error(`Provider '${provider}' cannot authenticate the ${host} harness.`);
      return env;
    },
    connectionEnvFor(host) {
      return connectionEnvByHost[host] ?? {};
    },
    baseUrlEnvFor(host) {
      const connection = connectionEnvByHost[host] ?? {};
      return baseUrlEnvByHost[host] ?? Object.keys(connection).find(key => key.endsWith('_BASE_URL')) ?? null;
    },
    validate(kind, value) {
      nonEmpty(provider, kind, value);
      validate?.(kind, value);
    },
  };
}

const ADAPTERS = new Map<string, AccountProviderAdapter>([
  ['anthropic', fixed('anthropic', ['api-key', 'setup-token'], { claude: 'ANTHROPIC_API_KEY' }, {}, {}, (kind, value) => {
    if (kind === 'setup-token' && !value.startsWith('sk-ant-oat01-')) {
      throw new Error('Anthropic setup tokens must start with sk-ant-oat01-.');
    }
  })],
  ['cursor', fixed('cursor', ['api-key'], { cursor: 'CURSOR_API_KEY' })],
  ['openrouter', fixed(
    'openrouter',
    ['api-key'],
    { claude: 'ANTHROPIC_AUTH_TOKEN', codex: 'OPENAI_API_KEY', opencode: 'OPENROUTER_API_KEY' },
    { claude: { ANTHROPIC_BASE_URL: 'https://openrouter.ai/api' }, codex: { OPENAI_BASE_URL: 'https://openrouter.ai/api/v1' } },
  )],
  ['deepinfra', fixed(
    'deepinfra',
    ['api-key'],
    { codex: 'OPENAI_API_KEY' },
    { codex: { OPENAI_BASE_URL: 'https://api.deepinfra.com/v1/openai' } },
  )],
  ['openai', fixed('openai', ['api-key'], { codex: 'OPENAI_API_KEY', opencode: 'OPENAI_API_KEY' }, {}, { codex: 'OPENAI_BASE_URL', opencode: 'OPENAI_BASE_URL' })],
  ['xai', fixed('xai', ['api-key'], { grok: 'XAI_API_KEY', claude: 'ANTHROPIC_AUTH_TOKEN' })],
  ['google', fixed('google', ['api-key'], { antigravity: 'ANTIGRAVITY_API_KEY' })],
  ['opencode', fixed('opencode', ['api-key'], { opencode: 'OPENCODE_API_KEY' })],
  ['proxy', fixed('proxy', ['api-key', 'bearer-token'], { claude: 'ANTHROPIC_AUTH_TOKEN', codex: 'OPENAI_API_KEY' }, {}, { claude: 'ANTHROPIC_BASE_URL', codex: 'OPENAI_BASE_URL' })],
  ['truefoundry', fixed('truefoundry', ['api-key', 'bearer-token'], { claude: 'ANTHROPIC_AUTH_TOKEN' }, {}, { claude: 'ANTHROPIC_BASE_URL' })],
  ['bedrock', fixed('bedrock', ['bearer-token'], { claude: 'AWS_BEARER_TOKEN_BEDROCK' })],
  ['foundry', fixed('foundry', ['api-key'], { claude: 'ANTHROPIC_FOUNDRY_API_KEY' })],
  ['litellm', fixed('litellm', ['api-key', 'bearer-token'], { claude: 'ANTHROPIC_AUTH_TOKEN', codex: 'OPENAI_API_KEY' }, {}, { claude: 'ANTHROPIC_BASE_URL', codex: 'OPENAI_BASE_URL' })],
  ['vllm', fixed('vllm', ['api-key', 'bearer-token'], { claude: 'ANTHROPIC_AUTH_TOKEN', codex: 'OPENAI_API_KEY' }, {}, { claude: 'ANTHROPIC_BASE_URL', codex: 'OPENAI_BASE_URL' })],
  ['ollama', fixed('ollama', ['api-key'], { codex: 'OPENAI_API_KEY' }, {}, { codex: 'OPENAI_BASE_URL' })],
]);

export function getAccountProvider(provider: string): AccountProviderAdapter {
  const adapter = ADAPTERS.get(provider.toLowerCase());
  if (!adapter) throw new Error(`Unknown account provider '${provider}'. Supported: ${listAccountProviders().join(', ')}.`);
  return adapter;
}

/**
 * Whether a provider account of kind `auth` can authenticate `agent` — i.e. the
 * adapter has an `envFor(agent, auth)` mapping. Used both by the account UI and by
 * the run-candidate pool so a Cursor key never enters Claude's pool and a harness
 * with no provider adapter at all (e.g. kimi, native-login only) yields nothing.
 * A "cannot authenticate" is a clean false; any other error (unknown provider,
 * unsupported kind) is a real bug and re-throws rather than being swallowed.
 */
export function providerAuthenticatesHarness(
  provider: string,
  auth: AccountAuthKind,
  agent: AgentId,
): boolean {
  try {
    getAccountProvider(provider).envFor(agent, auth);
    return true;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes('cannot authenticate')) return false;
    throw err;
  }
}

export function listAccountProviders(): string[] {
  return [...ADAPTERS.keys()].sort();
}
