/**
 * Built-in profile presets for popular model providers.
 *
 * Each preset bundles a host CLI, API base URL, default model, and provider
 * name so users can `agents harness add kimi` without manual configuration.
 */

import type { AgentId } from './types.js';

export interface PresetVar {
  /** Env var name to set in the resulting profile. */
  envVar: string;
  /** User-facing prompt text. */
  prompt: string;
  /** True for secrets — wizard will mask input and store in keychain. */
  secret?: boolean;
  /** Default value (shown in prompt). */
  default?: string;
  /** Optional regex pattern — input validated against it. */
  pattern?: string;
  /** Optional hint text shown beside the prompt. */
  hint?: string;
}

/** A pre-configured profile template for a model provider. */
export interface Preset {
  name: string;
  description: string;
  provider: string;
  host: AgentId;
  env: Record<string, string>;
  vars?: PresetVar[];
  authEnvVar: string;
  /** True if the provider can function without a keychain token (e.g. Bedrock with SSO). */
  authOptional?: boolean;
  signupUrl?: string;
  docPath?: string;
}

// Model IDs verified against openrouter.ai/api/v1/models on 2026-07-31
// (spark presets corrected from the never-served meta/claude-spark-1.1 to the
// live meta/muse-spark-1.1, confirmed on both OpenRouter and OpenCode id:meta).
// Presets target the top-ranked open-source model per provider based on
// SWE-bench Verified, LiveCodeBench, HumanEval, and Chatbot Arena rankings.
//
// Important limitation of Claude Code + non-Anthropic models via OpenRouter:
// Claude Code sends `thinking:{type:"enabled"}` in its Anthropic payload by
// default, and its headless output consolidation returns empty text when a
// response contains thinking/redacted_thinking blocks — even when the model
// *also* emits a text block. This means reasoning models work fine in
// interactive `claude` mode (same env vars) but headless invocations
// (`agents run <profile> "<prompt>"`) see empty stdout.
//
// Presets flagged "headless-safe" use non-reasoning variants that ignore
// thinking:enabled. Presets flagged "reasoning" are the leaderboard leaders
// but are best invoked interactively.

const OPENROUTER_BASE = 'https://openrouter.ai/api';
const OPENROUTER_AUTH: Pick<Preset, 'provider' | 'host' | 'authEnvVar' | 'signupUrl'> = {
  provider: 'openrouter',
  host: 'claude',
  authEnvVar: 'ANTHROPIC_AUTH_TOKEN',
  signupUrl: 'https://openrouter.ai/keys',
};

export const PRESETS: Preset[] = [
  // ----- Top coding (via OpenRouter) -----
  {
    name: 'kimi',
    description: 'Kimi K2.5 via OpenRouter (262K ctx, $0.38/$1.72 per 1M). Top Kimi: 99% HumanEval, 76.8% SWE-bench. REASONING — works interactively, but `agents run kimi "<prompt>"` (headless) returns empty stdout. Use `kimi-chat` preset for scripting.',
    ...OPENROUTER_AUTH,
    env: {
      ANTHROPIC_BASE_URL: OPENROUTER_BASE,
      ANTHROPIC_MODEL: 'moonshotai/kimi-k2.5',
      ANTHROPIC_SMALL_FAST_MODEL: 'moonshotai/kimi-k2.5',
    },
  },
  {
    name: 'kimi-chat',
    description: 'Kimi K2 0905 via OpenRouter (262K ctx, $0.40/$2.00 per 1M). Non-reasoning sibling of K2.5 — slightly older but HEADLESS-SAFE, works end-to-end with `agents run kimi-chat "<prompt>"` and in scripts/automation.',
    ...OPENROUTER_AUTH,
    env: {
      ANTHROPIC_BASE_URL: OPENROUTER_BASE,
      ANTHROPIC_MODEL: 'moonshotai/kimi-k2-0905',
      ANTHROPIC_SMALL_FAST_MODEL: 'moonshotai/kimi-k2-0905',
    },
  },
  {
    name: 'minimax',
    description: 'MiniMax M2.5 via OpenRouter (230B params). #1 SWE-bench Verified (80.2%) on Apr 2026 leaderboards. REASONING — works interactively, headless `agents run` returns empty stdout.',
    ...OPENROUTER_AUTH,
    env: {
      ANTHROPIC_BASE_URL: OPENROUTER_BASE,
      ANTHROPIC_MODEL: 'minimax/minimax-m2.5',
      ANTHROPIC_SMALL_FAST_MODEL: 'minimax/minimax-m2.5',
    },
  },
  {
    name: 'glm',
    description: 'GLM 5 via OpenRouter (80K ctx, $0.72/$2.30 per 1M). #1 Chatbot Arena ELO (1451) among open-weight models on BenchLM.ai (Apr 2026). Prompt-complexity-dependent reasoning — Claude Code\'s 38K system prompt typically triggers thinking blocks, so headless invocations are unreliable. Interactive use is fine.',
    ...OPENROUTER_AUTH,
    env: {
      ANTHROPIC_BASE_URL: OPENROUTER_BASE,
      ANTHROPIC_MODEL: 'z-ai/glm-5',
      ANTHROPIC_SMALL_FAST_MODEL: 'z-ai/glm-5',
    },
  },
  {
    name: 'qwen',
    description: 'Qwen3 Coder Next via OpenRouter (256K ctx, $0.15/$0.80 per 1M, sparse MoE 80B/3B active). Latest coding-specific Qwen (Feb 2026). HEADLESS-SAFE — works with `agents run qwen "<prompt>"`.',
    ...OPENROUTER_AUTH,
    env: {
      ANTHROPIC_BASE_URL: OPENROUTER_BASE,
      ANTHROPIC_MODEL: 'qwen/qwen3-coder-next',
      ANTHROPIC_SMALL_FAST_MODEL: 'qwen/qwen3-coder-next',
    },
  },
  {
    name: 'deepseek',
    description: 'DeepSeek Chat V3 (0324) via OpenRouter. Latest DeepSeek Chat variant that ignores thinking:enabled. HEADLESS-SAFE. The newer V3.2 / V3.1-Terminus / V3.2-Speciale are reasoning variants — use `--model deepseek/deepseek-v3.2` to override if you want those for interactive use.',
    ...OPENROUTER_AUTH,
    env: {
      ANTHROPIC_BASE_URL: OPENROUTER_BASE,
      ANTHROPIC_MODEL: 'deepseek/deepseek-chat-v3-0324',
      ANTHROPIC_SMALL_FAST_MODEL: 'deepseek/deepseek-chat-v3-0324',
    },
  },
  {
    name: 'open-claude',
    description: 'Open-weight coding via OpenRouter inside Claude Code (Qwen3 Coder Next, 256K ctx, $0.15/$0.80 per 1M). HEADLESS-SAFE — best general preset for open-claude usage with Claude Code harness.',
    ...OPENROUTER_AUTH,
    env: {
      ANTHROPIC_BASE_URL: OPENROUTER_BASE,
      ANTHROPIC_MODEL: 'qwen/qwen3-coder-next',
      ANTHROPIC_SMALL_FAST_MODEL: 'qwen/qwen3-coder-next',
    },
  },
  {
    name: 'claude-spark',
    description: 'Meta Muse Spark 1.1 via OpenRouter inside Claude Code (open alternative). Model: meta/muse-spark-1.1 — now usable in the Claude Code UI. HEADLESS-SAFE. For open-claude spark usage.',
    ...OPENROUTER_AUTH,
    env: {
      ANTHROPIC_BASE_URL: OPENROUTER_BASE,
      ANTHROPIC_MODEL: 'meta/muse-spark-1.1',
      ANTHROPIC_SMALL_FAST_MODEL: 'meta/muse-spark-1.1',
    },
  },
  // ----- OpenCode CLI (open-claude harness) -----
  {
    name: 'opencode',
    description: 'OpenCode default — uses your configured model via opencode auth. Run `opencode auth` to login, then `agents run opencode --model meta/muse-spark-1.1 "prompt"` for spark usage.',
    provider: 'opencode',
    host: 'opencode',
    authEnvVar: 'OPENCODE_API_KEY',
    authOptional: true,
    env: {},
  },
  {
    name: 'opencode-spark',
    description: 'Meta Muse Spark 1.1 via OpenCode (free, headless-safe). Pinned to meta/muse-spark-1.1 — best for open-claude usage with opencode harness.',
    provider: 'opencode',
    host: 'opencode',
    authEnvVar: 'OPENCODE_API_KEY',
    authOptional: true,
    env: {
      OPENCODE_MODEL: 'meta/muse-spark-1.1',
    },
  },
  {
    name: 'opencode-qwen',
    description: 'Qwen3 Coder Next via OpenCode (open-claude path). Use `agents run opencode-qwen "prompt"` — free via opencode provider.',
    provider: 'opencode',
    host: 'opencode',
    authEnvVar: 'OPENCODE_API_KEY',
    authOptional: true,
    env: {
      OPENCODE_MODEL: 'qwen/qwen3-coder-next',
    },
  },
  // ----- xAI Grok Build CLI (native host) -----
  {
    name: 'grok-fast',
    description: 'xAI Grok Build CLI — fast tier. Optimized for speed and low-latency coding tasks.',
    provider: 'xai',
    host: 'grok',
    authEnvVar: 'XAI_API_KEY',
    signupUrl: 'https://console.x.ai',
    env: {
      GROK_MODEL: 'grok-build-0.1',
    },
  },
  {
    name: 'grok-heavy',
    description: 'xAI Grok Build CLI — flagship tier (Grok 4.3). Best for complex reasoning and large context windows.',
    provider: 'xai',
    host: 'grok',
    authEnvVar: 'XAI_API_KEY',
    signupUrl: 'https://console.x.ai',
    env: {
      GROK_MODEL: 'grok-4.3',
    },
  },
  // ----- Google Antigravity CLI (native host) -----
  {
    name: 'agy',
    description: 'Google Antigravity CLI default (gemini-3.5-flash). Optimized for speed and large context.',
    provider: 'google',
    host: 'antigravity',
    authEnvVar: 'ANTIGRAVITY_API_KEY',
    signupUrl: 'https://antigravity.google',
    env: {
      // Antigravity defaults to gemini-3.5-flash as of June 2026
    },
  },
  // ----- Direct Providers -----
  {
    name: 'anthropic',
    description: 'Anthropic direct API — standard Claude Code experience with your own API key.',
    provider: 'anthropic',
    host: 'claude',
    authEnvVar: 'ANTHROPIC_API_KEY',
    signupUrl: 'https://console.anthropic.com',
    env: {
      ANTHROPIC_MODEL: 'claude-3-5-sonnet-latest',
      ANTHROPIC_SMALL_FAST_MODEL: 'claude-3-5-haiku-latest',
    },
  },
  {
    name: 'deepinfra',
    description: 'DeepInfra direct API through its OpenAI-compatible endpoint, hosted by Codex.',
    provider: 'deepinfra',
    host: 'codex',
    authEnvVar: 'OPENAI_API_KEY',
    signupUrl: 'https://deepinfra.com/dash/api_keys',
    docPath: 'deepinfra',
    env: {
      OPENAI_BASE_URL: 'https://api.deepinfra.com/v1/openai',
      OPENAI_MODEL: 'deepseek-ai/DeepSeek-V3',
    },
  },
  // ----- Gateway / enterprise / self-hosted -----
  {
    name: 'proxy',
    description: 'Generic local proxy / gateway — points at a local router (CCR, LiteLLM) or internal corporate inference endpoint.',
    provider: 'proxy',
    host: 'claude',
    authEnvVar: 'ANTHROPIC_AUTH_TOKEN',
    authOptional: true,
    env: {
      API_TIMEOUT_MS: '600000',
    },
    vars: [
      {
        envVar: 'ANTHROPIC_BASE_URL',
        prompt: 'Gateway base URL',
        default: 'http://127.0.0.1:3456',
      },
      {
        envVar: 'ANTHROPIC_MODEL',
        prompt: 'Model ID',
        default: 'claude-3-5-sonnet-latest',
      },
    ],
  },
  {
    name: 'truefoundry',
    description: 'TrueFoundry AI Gateway routing to Anthropic-compatible backends (often Bedrock). Strips experimental headers + disables prompt caching to satisfy Bedrock validation.',
    provider: 'truefoundry',
    host: 'claude',
    authEnvVar: 'ANTHROPIC_AUTH_TOKEN',
    signupUrl: 'https://www.truefoundry.com',
    docPath: 'truefoundry',
    env: {
      CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS: '1',
      CLAUDE_CODE_ATTRIBUTION_HEADER: '0',
      DISABLE_PROMPT_CACHING: '1',
      API_TIMEOUT_MS: '600000',
      CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY: '1',
    },
    vars: [
      {
        envVar: 'ANTHROPIC_BASE_URL',
        prompt: 'TrueFoundry gateway base URL',
        hint: 'e.g. https://<tenant>.truefoundry.cloud/api/llm',
      },
      {
        envVar: 'ANTHROPIC_MODEL',
        prompt: 'Model ID',
        hint: 'provider-account/model-id',
      },
    ],
  },
  {
    name: 'bedrock',
    description: 'AWS Bedrock — Claude Code native Bedrock mode. Uses the standard AWS SDK credential chain (SSO, IAM roles, env). Set AWS_BEARER_TOKEN_BEDROCK only if your gateway requires a static token.',
    provider: 'bedrock',
    host: 'claude',
    authEnvVar: 'AWS_BEARER_TOKEN_BEDROCK',
    authOptional: true,
    signupUrl: 'https://aws.amazon.com/bedrock/',
    env: {
      CLAUDE_CODE_USE_BEDROCK: '1',
      DISABLE_PROMPT_CACHING: '1',
    },
    vars: [
      {
        envVar: 'AWS_REGION',
        prompt: 'AWS region',
        default: 'us-east-1',
      },
    ],
  },
  {
    name: 'vertex',
    description: 'Google Vertex AI — Claude Code native Vertex mode.',
    provider: 'vertex',
    host: 'claude',
    authEnvVar: 'GOOGLE_APPLICATION_CREDENTIALS',
    signupUrl: 'https://cloud.google.com/vertex-ai',
    env: {
      CLAUDE_CODE_USE_VERTEX: '1',
    },
    vars: [
      {
        envVar: 'CLOUD_ML_REGION',
        prompt: 'Vertex region',
        default: 'us-east5',
      },
      {
        envVar: 'ANTHROPIC_VERTEX_PROJECT_ID',
        prompt: 'GCP project ID',
      },
    ],
  },
  {
    name: 'foundry',
    description: 'Microsoft Azure AI Foundry — Anthropic models hosted on Azure. Distinct from TrueFoundry.',
    provider: 'foundry',
    host: 'claude',
    authEnvVar: 'ANTHROPIC_FOUNDRY_API_KEY',
    signupUrl: 'https://ai.azure.com',
    env: {
      CLAUDE_CODE_USE_FOUNDRY: '1',
    },
    vars: [
      {
        envVar: 'ANTHROPIC_FOUNDRY_BASE_URL',
        prompt: 'Azure AI Foundry base URL',
        hint: '<resource>.services.ai.azure.com/anthropic',
      },
    ],
  },
  {
    name: 'litellm',
    description: 'LiteLLM proxy in Anthropic-compatible mode.',
    provider: 'litellm',
    host: 'claude',
    authEnvVar: 'ANTHROPIC_AUTH_TOKEN',
    env: {
      API_TIMEOUT_MS: '600000',
    },
    vars: [
      { envVar: 'ANTHROPIC_BASE_URL', prompt: 'LiteLLM base URL' },
      { envVar: 'ANTHROPIC_MODEL', prompt: 'Model ID' },
    ],
  },
  {
    name: 'vllm',
    description: 'Self-hosted vLLM with native Anthropic-compatible endpoint.',
    provider: 'vllm',
    host: 'claude',
    authEnvVar: 'ANTHROPIC_AUTH_TOKEN',
    env: {
      API_TIMEOUT_MS: '600000',
    },
    vars: [
      {
        envVar: 'ANTHROPIC_BASE_URL',
        prompt: 'vLLM base URL',
        default: 'http://127.0.0.1:8000',
      },
      { envVar: 'ANTHROPIC_MODEL', prompt: 'Model ID' },
    ],
  },
  {
    name: 'ollama',
    description: 'Local Ollama via Codex CLI (OpenAI-compatible). Codex host because Anthropic translation through CCR/LiteLLM drops tool_use.',
    provider: 'ollama',
    host: 'codex',
    authEnvVar: 'OPENAI_API_KEY',
    env: {},
    vars: [
      {
        envVar: 'OPENAI_BASE_URL',
        prompt: 'Ollama base URL',
        default: 'http://127.0.0.1:11434/v1',
      },
      {
        envVar: 'OPENAI_MODEL',
        prompt: 'Model ID',
        default: 'qwen3-coder:30b',
      },
    ],
  },
];

interface ResolvedPresetEnv {
  /** Env vars from preset.env — always set, no user input. */
  static: Record<string, string>;
  /** Vars the wizard needs to prompt for. */
  prompts: PresetVar[];
}

/** Split a preset into static env vars and prompts needed from the user. */
export function expandPreset(p: Preset): ResolvedPresetEnv {
  return { static: { ...p.env }, prompts: p.vars ?? [] };
}

/** Look up a preset by name (case-sensitive). */
export function getPreset(name: string): Preset | undefined {
  return PRESETS.find((p) => p.name === name);
}

/** Return a copy of all available presets. */
export function listPresets(): Preset[] {
  return [...PRESETS];
}

/** Return the unique set of provider names across all presets. */
export function listProviders(): string[] {
  return [...new Set(PRESETS.map((p) => p.provider))];
}
