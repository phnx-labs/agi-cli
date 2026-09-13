import { type SpawnSyncOptions } from 'child_process';
import { getCliLaunch } from './cli-entry.js';

/**
 * argv for writing a bare (non-`agents-cli.`) keychain item via
 * `/usr/bin/security add-generic-password`, deliberately WITHOUT the value: the
 * secret travels over stdin (see below) so it never lands in argv or a `ps`
 * snapshot. Pure — no agents-cli secrets engine involved (this migration writes
 * directly to the OpenClaw account's OWN macOS keychain entries, bypassing the
 * `agents secrets` bundle store entirely), so it's a local helper rather than a
 * process-client call.
 */
function buildAddGenericPasswordArgs(account: string, item: string): string[] {
  return ['add-generic-password', '-U', '-a', account, '-s', item, '-w'];
}

/**
 * spawnSync options for the bare `-w` keychain write. `input` pipes the value
 * TWICE (bare `-w` prompts enter+confirm; one line fails the confirm and stores
 * an empty secret). `detached: true` runs `security` in a new session with no
 * controlling terminal, so readpassphrase(3) falls back to our piped stdin
 * instead of prompting the user's `/dev/tty` in an interactive shell.
 */
function buildAddGenericPasswordSpawnOptions(
  value: string,
): SpawnSyncOptions & { input: string; detached: boolean } {
  return {
    input: `${value}\n${value}\n`,
    stdio: ['pipe', 'pipe', 'pipe'],
    timeout: 10_000,
    detached: true,
  };
}

const OPENCLAW_KEYCHAIN_ACCOUNT = 'openclaw';
const OPENCLAW_KEYCHAIN_PROVIDER = 'agents_keychain';

const OPENCLAW_KEYCHAIN_ENV_SERVICES: Record<string, string> = {
  OPENROUTER_API_KEY: 'openrouter-api-key',
  LINEAR_API_KEY: 'linear-api-key',
  GRAFANA_API_KEY: 'grafana-api-key',
  POSTHOG_API_KEY: 'posthog-api-key',
};

interface OpenClawSecretRef {
  source: 'exec';
  provider: string;
  id: string;
}

interface OpenClawKeychainMigrationOptions {
  account?: string;
  provider?: string;
  agentsBin?: string;
}

interface OpenClawKeychainMigrationResult {
  services: Array<{ envKey: string; service: string; value: string }>;
  replacedPaths: string[];
  removedEnvPaths: string[];
  unsupportedEnvKeys: string[];
  changed: boolean;
}

interface JsonObject {
  [key: string]: unknown;
}

function isRecord(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function secretRef(provider: string, service: string): OpenClawSecretRef {
  return { source: 'exec', provider, id: service };
}

function openClawPath(parts: string[]): string {
  return parts.join('.');
}

function collectOpenClawEnv(config: JsonObject): Map<string, { path: string[]; value: string }> {
  const env = isRecord(config.env) ? config.env : null;
  const out = new Map<string, { path: string[]; value: string }>();
  if (!env) return out;

  for (const [key, service] of Object.entries(OPENCLAW_KEYCHAIN_ENV_SERVICES)) {
    void service;
    const top = env[key];
    if (typeof top === 'string' && top.trim()) {
      out.set(key, { path: ['env', key], value: top });
      continue;
    }
    const vars = isRecord(env.vars) ? env.vars : null;
    const nested = vars?.[key];
    if (typeof nested === 'string' && nested.trim()) {
      out.set(key, { path: ['env', 'vars', key], value: nested });
    }
  }
  return out;
}

function deletePath(config: JsonObject, parts: string[]): boolean {
  let current: unknown = config;
  for (const part of parts.slice(0, -1)) {
    if (!isRecord(current)) return false;
    current = current[part];
  }
  if (!isRecord(current)) return false;
  const key = parts[parts.length - 1];
  if (!(key in current)) return false;
  delete current[key];
  return true;
}

function normalizeObject(value: unknown): JsonObject {
  return isRecord(value) ? value : {};
}

function ensureOpenClawKeychainProvider(
  config: JsonObject,
  opts: Required<Pick<OpenClawKeychainMigrationOptions, 'account' | 'provider'>>,
  agentsBin?: string,
): void {
  const launch = getCliLaunch(['secrets', 'openclaw-keychain', 'resolve', '--account', opts.account], agentsBin);
  const secrets = normalizeObject(config.secrets);
  const providers = normalizeObject(secrets.providers);
  providers[opts.provider] = {
    source: 'exec',
    command: launch.command,
    args: launch.args,
    jsonOnly: true,
  };
  secrets.providers = providers;
  config.secrets = secrets;
}

function providerEnvKeyForPath(parts: string[]): string | null {
  if (
    parts.length === 8 &&
    parts[0] === 'plugins' &&
    parts[1] === 'entries' &&
    parts[3] === 'config' &&
    parts[4] === 'mcpServers' &&
    parts[6] === 'env'
  ) {
    return parts[7];
  }
  return null;
}

function serviceForSupportedPath(parts: string[]): string | null {
  const envKey = providerEnvKeyForPath(parts);
  if (envKey) return OPENCLAW_KEYCHAIN_ENV_SERVICES[envKey] ?? null;

  if (parts.length === 4 && parts[0] === 'models' && parts[1] === 'providers' && parts[3] === 'apiKey') {
    if (parts[2] === 'openrouter') return OPENCLAW_KEYCHAIN_ENV_SERVICES.OPENROUTER_API_KEY;
  }

  return null;
}

function envKeyForService(service: string): string {
  return Object.entries(OPENCLAW_KEYCHAIN_ENV_SERVICES).find(([, known]) => known === service)?.[0] ?? service;
}

function assertSameOpenClawSecretValue(
  envKey: string,
  service: string,
  existingPath: string,
  existingValue: string,
  nextPath: string,
  nextValue: string,
): void {
  if (existingValue === nextValue) return;
  throw new Error(
    `OpenClaw credential value mismatch for ${envKey} (${service}): ${existingPath} and ${nextPath} differ. ` +
    `Resolve the plaintext values before migrating to Keychain.`
  );
}

function canReplaceByValue(parts: string[]): boolean {
  if (parts.length === 4 && parts[0] === 'models' && parts[1] === 'providers' && parts[3] === 'apiKey') return true;
  if (parts.length === 6 && parts[0] === 'plugins' && parts[1] === 'entries' && parts[3] === 'config' && parts[4] === 'webSearch' && parts[5] === 'apiKey') return true;
  if (parts.length === 5 && parts[0] === 'tools' && parts[1] === 'web' && parts[2] === 'search' && parts[4] === 'apiKey') return true;
  if (parts.length === 4 && parts[0] === 'tools' && parts[1] === 'web' && parts[2] === 'search' && parts[3] === 'apiKey') return true;
  return providerEnvKeyForPath(parts) !== null;
}

function replaceSupportedSecrets(
  current: unknown,
  parts: string[],
  provider: string,
  envByValue: Map<string, string>,
  env: Map<string, { path: string[]; value: string }>,
  services: Map<string, { envKey: string; service: string; value: string }>,
  servicePaths: Map<string, string>,
  replacedPaths: string[],
): void {
  if (!isRecord(current) && !Array.isArray(current)) return;
  const entries = Array.isArray(current)
    ? current.map((value, index) => [String(index), value] as const)
    : Object.entries(current);

  for (const [key, value] of entries) {
    const childParts = [...parts, key];
    if (typeof value === 'string' && value.trim() && canReplaceByValue(childParts)) {
      const directService = serviceForSupportedPath(childParts);
      const matchedService = directService ?? envByValue.get(value);
      if (matchedService) {
        const envKey = envKeyForService(matchedService);
        const childPath = openClawPath(childParts);
        const existingService = services.get(matchedService);
        if (existingService) {
          assertSameOpenClawSecretValue(
            envKey,
            matchedService,
            servicePaths.get(matchedService) ?? matchedService,
            existingService.value,
            childPath,
            value,
          );
        }
        if (directService) {
          const envEntry = env.get(envKey);
          if (envEntry) {
            assertSameOpenClawSecretValue(
              envKey,
              matchedService,
              openClawPath(envEntry.path),
              envEntry.value,
              childPath,
              value,
            );
          }
        }
        services.set(matchedService, { envKey, service: matchedService, value });
        servicePaths.set(matchedService, childPath);
        (current as Record<string, unknown>)[key] = secretRef(provider, matchedService);
        replacedPaths.push(childPath);
        continue;
      }
    }
    replaceSupportedSecrets(value, childParts, provider, envByValue, env, services, servicePaths, replacedPaths);
  }
}

export function migrateOpenClawConfigToKeychainRefs(
  config: JsonObject,
  opts: OpenClawKeychainMigrationOptions = {},
): OpenClawKeychainMigrationResult {
  const account = opts.account ?? OPENCLAW_KEYCHAIN_ACCOUNT;
  const provider = opts.provider ?? OPENCLAW_KEYCHAIN_PROVIDER;
  const env = collectOpenClawEnv(config);
  const envByValue = new Map<string, string>();
  for (const [envKey, entry] of env) {
    envByValue.set(entry.value, OPENCLAW_KEYCHAIN_ENV_SERVICES[envKey]);
  }

  const services = new Map<string, { envKey: string; service: string; value: string }>();
  const servicePaths = new Map<string, string>();
  const replacedPaths: string[] = [];
  replaceSupportedSecrets(config, [], provider, envByValue, env, services, servicePaths, replacedPaths);

  const removedEnvPaths: string[] = [];
  const unsupportedEnvKeys: string[] = [];
  for (const [envKey, entry] of env) {
    const service = OPENCLAW_KEYCHAIN_ENV_SERVICES[envKey];
    const mappedService = services.get(service);
    if (!mappedService) {
      unsupportedEnvKeys.push(envKey);
      continue;
    }
    assertSameOpenClawSecretValue(
      envKey,
      service,
      servicePaths.get(service) ?? service,
      mappedService.value,
      openClawPath(entry.path),
      entry.value,
    );
    if (deletePath(config, entry.path)) removedEnvPaths.push(openClawPath(entry.path));
  }

  if (services.size > 0) {
    ensureOpenClawKeychainProvider(config, { account, provider }, opts.agentsBin);
  }

  return {
    services: [...services.values()],
    replacedPaths,
    removedEnvPaths,
    unsupportedEnvKeys,
    changed: services.size > 0 || replacedPaths.length > 0 || removedEnvPaths.length > 0,
  };
}

export function buildOpenClawKeychainStoreInvocation(
  service: string,
  value: string,
  account = OPENCLAW_KEYCHAIN_ACCOUNT,
): { command: string; args: string[]; options: SpawnSyncOptions & { input: string; detached: boolean } } {
  return {
    command: '/usr/bin/security',
    args: buildAddGenericPasswordArgs(account, service),
    options: buildAddGenericPasswordSpawnOptions(value),
  };
}

interface OpenClawExecResolverRequest {
  protocolVersion?: number;
  provider?: string;
  ids?: unknown;
}

interface OpenClawExecResolverResponse {
  protocolVersion: 1;
  values: Record<string, string>;
  errors?: Record<string, { code: string }>;
}

export function resolveOpenClawKeychainRequest(
  request: OpenClawExecResolverRequest,
  lookup: (service: string) => string,
): OpenClawExecResolverResponse {
  const ids = Array.isArray(request.ids) ? request.ids.filter((id): id is string => typeof id === 'string') : [];
  const values: Record<string, string> = {};
  const errors: Record<string, { code: string }> = {};
  for (const id of ids) {
    try {
      values[id] = lookup(id);
    } catch {
      errors[id] = { code: 'NOT_FOUND' };
    }
  }
  return {
    protocolVersion: 1,
    values,
    ...(Object.keys(errors).length > 0 ? { errors } : {}),
  };
}
