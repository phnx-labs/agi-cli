/** Cloud provider registry: reads the `cloud` section of agents.yaml, lazily instantiates
 * providers, and exposes lookups for `agents cloud`. */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as yaml from 'yaml';
import type { CloudProvider, CloudProviderId, CloudConfig } from './types.js';
import { RushCloudProvider } from './rush.js';
import { CodexCloudProvider } from './codex.js';
import { FactoryCloudProvider } from './factory.js';
import { AntigravityCloudProvider } from './antigravity.js';
import { CursorCloudProvider } from './cursor.js';
import { HostCloudProvider } from './host.js';
import { getUserAgentsDir } from '../state.js';
import { AGENTS } from '../agents.js';
import type { AgentId } from '../types.js';

const META_FILE = path.join(getUserAgentsDir(), 'agents.yaml');

let _config: CloudConfig | null = null;

/** Parse the `cloud` section from agents.yaml, caching the result for the process lifetime. */
function loadCloudConfig(): CloudConfig {
  if (_config) return _config;

  if (!fs.existsSync(META_FILE)) {
    _config = {};
    return _config;
  }

  try {
    const raw = fs.readFileSync(META_FILE, 'utf-8');
    const data = yaml.parse(raw) as Record<string, unknown>;
    _config = (data?.cloud as CloudConfig) ?? {};
  } catch {
    _config = {};
  }
  return _config;
}

const providers: Map<CloudProviderId, CloudProvider> = new Map();

/** Instantiate all provider implementations once, keyed by their ID. */
function initProviders(): void {
  if (providers.size > 0) return;

  const config = loadCloudConfig();

  providers.set('rush', new RushCloudProvider());
  providers.set('codex', new CodexCloudProvider(config.providers?.codex));
  providers.set('factory', new FactoryCloudProvider(config.providers?.factory));
  providers.set('antigravity', new AntigravityCloudProvider(config.providers?.antigravity));
  providers.set('cursor', new CursorCloudProvider(config.providers?.cursor));
  // Your own machines (agents devices) over SSH. No agent
  // auto-routes here — it's always an explicit --provider host / --host choice.
  providers.set('host', new HostCloudProvider());
}

/** The cloud provider an agent dispatches to by default, from the `cloudProvider` field on its
 * registry entry; undefined if no native cloud. */
export function nativeProviderForAgent(agentId: string): CloudProviderId | undefined {
  const agent = AGENTS[agentId as AgentId];
  return agent?.cloudProvider;
}

/** Look up a provider by ID, throwing if the ID is unknown. */
export function getProvider(id: CloudProviderId): CloudProvider {
  initProviders();
  const provider = providers.get(id);
  if (!provider) {
    throw new Error(`Unknown cloud provider: ${id}. Available: ${[...providers.keys()].join(', ')}`);
  }
  return provider;
}

/** Return the user's configured default provider, falling back to 'rush'. */
export function getDefaultProviderId(): CloudProviderId {
  const config = loadCloudConfig();
  return config.default_provider ?? 'rush';
}

/** Return every registered provider (used by `agents cloud providers`). */
export function getAllProviders(): CloudProvider[] {
  initProviders();
  return [...providers.values()];
}

/** Resolve the provider: explicit `--provider` > the agent's `cloudProvider` >
 * `cloud.default_provider` > `rush`. A caller with a concrete provider id passes it as `explicit`;
 * the agent arg is then ignored. */
export function resolveProvider(explicit?: string, agentId?: string): CloudProvider {
  const id = (explicit
    ?? (agentId ? nativeProviderForAgent(agentId) : undefined)
    ?? getDefaultProviderId()) as CloudProviderId;
  return getProvider(id);
}
