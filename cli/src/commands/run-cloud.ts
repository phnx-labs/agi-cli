import chalk from 'chalk';
import type { Command } from 'commander';
import { AGENTS, resolveAgentName, isAgentHardDeprecated, hardDeprecationError } from '../lib/agents.js';
import { RUN_AUTO_KEYWORD } from '../lib/types.js';
import { resolveProvider, nativeProviderForAgent } from '../lib/cloud/registry.js';
import type { CloudProvider } from '../lib/cloud/types.js';
import type { DispatchOptions } from '../lib/cloud/types.js';
import { resolveCloudPrompt, executeCloudDispatch } from '../lib/cloud/dispatch.js';

export class RunCloudError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RunCloudError';
  }
}

const RUN_CLOUD_CONFLICTS: Array<{ field: string; flag: string; set: (v: unknown) => boolean }> = [

  { field: 'terminal', flag: '--terminal', set: (v) => v !== undefined && v !== false },
  { field: 'interactive', flag: '--interactive', set: (v) => v === true },
  { field: 'acp', flag: '--acp', set: (v) => v === true },
  { field: 'loop', flag: '--loop', set: (v) => v === true },
  { field: 'resumeCheckpoint', flag: '--resume-checkpoint', set: (v) => v !== undefined },
  { field: 'maxIterations', flag: '--max-iterations', set: (v) => v !== undefined },
  { field: 'budget', flag: '--budget', set: (v) => v !== undefined },
  { field: 'until', flag: '--until', set: (v) => v !== undefined },
  { field: 'interval', flag: '--interval', set: (v) => v !== undefined },
  { field: 'resume', flag: '--resume', set: (v) => v !== undefined && v !== false },
  { field: 'sessionId', flag: '--session-id', set: (v) => v !== undefined },
  { field: 'secrets', flag: '--secrets', set: (v) => Array.isArray(v) && (v as string[]).length > 0 },
  { field: 'secretsKeys', flag: '--secrets-keys', set: (v) => v !== undefined },
  { field: 'allowExpired', flag: '--allow-expired', set: (v) => v === true },
  { field: 'autoSecrets', flag: '--no-auto-secrets', set: (v) => v === false },
  { field: 'copyCreds', flag: '--copy-creds', set: (v) => v === true },
  { field: 'fallback', flag: '--fallback', set: (v) => v !== undefined },
  { field: 'strategy', flag: '--strategy', set: (v) => v !== undefined },
  { field: 'balanced', flag: '--balanced', set: (v) => v === true },
  { field: 'cwd', flag: '--cwd', set: (v) => v !== undefined },
  { field: 'project', flag: '--project', set: (v) => v !== undefined },
  { field: 'addDir', flag: '--add-dir', set: (v) => Array.isArray(v) && (v as string[]).length > 0 },
  { field: 'remoteCwd', flag: '--remote-cwd', set: (v) => v !== undefined },
  { field: 'env', flag: '--env', set: (v) => Array.isArray(v) && (v as string[]).length > 0 },
  { field: 'notify', flag: '--notify', set: (v) => v === true },
  { field: 'effort', flag: '--effort', set: (v) => v !== undefined && v !== 'auto' },
  { field: 'name', flag: '--name', set: (v) => v !== undefined },
];

const CLOUD_ONLY_FLAGS: Array<{ field: string; flag: string; set: (v: unknown) => boolean }> = [
  { field: 'provider', flag: '--provider', set: (v) => v !== undefined },
  { field: 'repo', flag: '--repo', set: (v) => Array.isArray(v) && (v as string[]).length > 0 },
  { field: 'branch', flag: '--branch', set: (v) => v !== undefined },
  { field: 'cloudEnv', flag: '--cloud-env', set: (v) => v !== undefined },
];

export function runCloudConflicts(options: Record<string, unknown>): string[] {
  return RUN_CLOUD_CONFLICTS.filter((c) => c.set(options[c.field])).map((c) => c.flag);
}

export function cloudFlagsWithoutCloud(options: Record<string, unknown>): string[] {
  return CLOUD_ONLY_FLAGS.filter((c) => c.set(options[c.field])).map((c) => c.flag);
}

export function cloudCapableAgentIds(): string[] {
  return Object.values(AGENTS)
    .filter((a) => a.cloudProvider)
    .map((a) => a.id)
    .sort();
}

export function resolveRunCloudProvider(agentId: string, explicitProvider?: string): CloudProvider {

  if (explicitProvider) return resolveProvider(explicitProvider);
  if (!nativeProviderForAgent(agentId)) {
    throw new RunCloudError(
      `${agentId} has no native cloud. Cloud-capable agents: ${cloudCapableAgentIds().join(', ')}. ` +
        `Override with --provider <id> (rush | codex | cursor | factory | antigravity | host).`,
    );
  }
  return resolveProvider(undefined, agentId);
}

export function resolveRunCloudAgent(agentSpec: string): string {
  if (agentSpec === RUN_AUTO_KEYWORD || agentSpec.startsWith(`${RUN_AUTO_KEYWORD}@`)) {
    throw new RunCloudError(
      `agents run auto --cloud: auto harness-pick is a local-run feature. ` +
        `Name a cloud-capable agent: ${cloudCapableAgentIds().join(', ')}.`,
    );
  }
  if (agentSpec.includes('@')) {
    throw new RunCloudError(
      `Version pins (<agent>@<version>) do not apply to --cloud — the provider runs its own agent version. ` +
        `Drop the pin: agents run ${agentSpec.split('@')[0]} "<task>" --cloud.`,
    );
  }
  const agentId = resolveAgentName(agentSpec);
  if (!agentId) {
    throw new RunCloudError(`Unknown agent: ${agentSpec}. Cloud-capable agents: ${cloudCapableAgentIds().join(', ')}.`);
  }
  if (isAgentHardDeprecated(agentId)) {
    throw new RunCloudError(hardDeprecationError(agentId));
  }
  return agentId;
}

export async function handleRunCloud(
  agentSpec: string,
  prompt: string | undefined,
  options: Record<string, unknown>,
  command: Command,
): Promise<void> {
  const json = options.json === true;
  try {
    const agentId = resolveRunCloudAgent(agentSpec);
    const provider = resolveRunCloudProvider(agentId, options.provider as string | undefined);
    const resolvedPrompt = resolveCloudPrompt(prompt, {
      json,
      hint: `agents run ${agentId} "<task>" --cloud${agentId === 'claude' ? ' --repo <owner/repo>' : ''}`,
    });

    const repoValues = Array.isArray(options.repo) ? (options.repo as string[]) : [];
    const dispatchOptions: DispatchOptions = {
      prompt: resolvedPrompt,
      agent: agentId,
      repo: repoValues[0],
      repos: repoValues.length > 0 ? repoValues : undefined,
      branch: options.branch as string | undefined,
      timeout: options.timeout as string | undefined,
      model: options.model as string | undefined,
      providerOptions: {},
    };
    if (options.cloudEnv) dispatchOptions.providerOptions!.env = options.cloudEnv as string;
    if (command.getOptionValueSource('mode') === 'cli') {
      dispatchOptions.providerOptions!.mode = options.mode as string;
    }

    await executeCloudDispatch({
      provider,
      dispatchOptions,
      follow: options.follow !== false,
      json,
    });
  } catch (err) {
    if (err instanceof RunCloudError) {
      console.error(chalk.red(err.message));
      process.exit(1);
    }
    throw err;
  }
}
