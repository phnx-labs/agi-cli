
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

function initProviders(): void {
  if (providers.size > 0) return;

  const config = loadCloudConfig();

  providers.set('rush', new RushCloudProvider());
  providers.set('codex', new CodexCloudProvider(config.providers?.codex));
  providers.set('factory', new FactoryCloudProvider(config.providers?.factory));
  providers.set('antigravity', new AntigravityCloudProvider(config.providers?.antigravity));
  providers.set('cursor', new CursorCloudProvider(config.providers?.cursor));
  providers.set('host', new HostCloudProvider());
}

export function nativeProviderForAgent(agentId: string): CloudProviderId | undefined {
  const agent = AGENTS[agentId as AgentId];
  return agent?.cloudProvider;
}

export function getProvider(id: CloudProviderId): CloudProvider {
  initProviders();
  const provider = providers.get(id);
  if (!provider) {
    throw new Error(`Unknown cloud provider: ${id}. Available: ${[...providers.keys()].join(', ')}`);
  }
  return provider;
}

export function getDefaultProviderId(): CloudProviderId {
  const config = loadCloudConfig();
  return config.default_provider ?? 'rush';
}

export function getAllProviders(): CloudProvider[] {
  initProviders();
  return [...providers.values()];
}

export function resolveProvider(explicit?: string, agentId?: string): CloudProvider {
  const id = (explicit
    ?? (agentId ? nativeProviderForAgent(agentId) : undefined)
    ?? getDefaultProviderId()) as CloudProviderId;
  return getProvider(id);
}
