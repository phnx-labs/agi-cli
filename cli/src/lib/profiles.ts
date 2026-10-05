
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'node:crypto';
import * as yaml from 'yaml';
import type { AgentId } from './types.js';
import { ALL_AGENT_IDS } from './agents.js';
import { getUserAgentsDir } from './state.js';
import {
  deleteKeychainTokenSync,
  getKeychainTokenSync,
  hasKeychainTokenSync,
  isSecretsClientError,
  isSecretsTransportError,
  profileKeychainItem,
} from './secrets-client.js';
import { type Preset } from './profiles-presets.js';
import { MODEL_TIERS, isTierToken, type ModelTier } from './model-tiers.js';
import { addAccount, findAccount, resolveCredentialAccount } from './account-registry.js';
import { atomicWriteFileSync } from './fs-atomic.js';
import { listAccountProviders } from './account-provider-registry.js';

export interface Profile {
  name: string;
  host: {
    agent: AgentId;
    version?: string;
  };
  env: Record<string, string>;
  account?: string;
  auth?: {
    envVar: string;
    keychainItem: string;
  };
  authOptional?: boolean;
  description?: string;
  preset?: string;
  provider?: string;
  label?: string;
  forkedFrom?: string;
  fallback_model?: string;
  models?: Partial<Record<ModelTier, string>>;
}

export interface ProfileSummary {
  name: string;
  label: string;
  agent: AgentId;
  host: string;
  hostVersion: string | null;
  provider: string;
  model: string;
  auth: string;
  path: string;
  description: string | null;
  forkedFrom: string | null;
}

const PROFILE_NAME_PATTERN = /^[a-z0-9][a-z0-9-_]{0,48}$/i;

function getProfilesDir(): string {
  return path.join(getUserAgentsDir(), 'profiles');
}

function profilePath(name: string): string {
  return path.join(getProfilesDir(), `${name}.yml`);
}

export function getProfilePath(name: string): string {
  validateProfileName(name);
  return profilePath(name);
}

export function validateProfileName(name: string): void {
  if (!PROFILE_NAME_PATTERN.test(name)) {
    throw new Error(`Invalid profile name '${name}'. Use letters, digits, dash, underscore (max 48 chars).`);
  }
}

export function profileExists(name: string): boolean {
  return fs.existsSync(profilePath(name));
}

export function isCustomHarnessName(name: string): boolean {
  if (!PROFILE_NAME_PATTERN.test(name)) return false;
  return !(ALL_AGENT_IDS as readonly string[]).includes(name) && profileExists(name);
}

export function readProfile(name: string): Profile {
  validateProfileName(name);
  const file = profilePath(name);
  if (!fs.existsSync(file)) {
    throw new Error(`Profile '${name}' not found.`);
  }
  const raw = fs.readFileSync(file, 'utf-8');
  const parsed = yaml.parse(raw) as Profile;
  if (!parsed || typeof parsed !== 'object') {
    throw new Error(`Profile '${name}' is malformed.`);
  }
  if (!parsed.name) parsed.name = name;
  if (!parsed.host?.agent) {
    throw new Error(`Profile '${name}' is missing host.agent.`);
  }
  if (!parsed.env || typeof parsed.env !== 'object') {
    parsed.env = {};
  }
  migrateLegacyProfileAuth(parsed, file);
  return parsed;
}

function migrateLegacyProfileAuth(profile: Profile, file: string): void {


  if (!profile.auth || profile.account) return;
  if (!profile.provider) {
    throw new Error(`Profile '${profile.name}' owns a legacy credential without a provider. Add a durable account with 'agents accounts add', then set account: <name> in ${file}.`);
  }
  const provider = listAccountProviders().includes(profile.provider) ? profile.provider : 'proxy';
  const suffix = crypto.createHash('sha256').update(profile.auth.keychainItem).digest('hex').slice(0, 8);
  const accountName = `legacy-${profile.provider}-${suffix}`;
  if (!findAccount(accountName)) {
    const kind = profile.auth.envVar.includes('BEARER_TOKEN') ? 'bearer-token' : 'api-key';
    addAccount(accountName, provider, kind, getKeychainTokenSync(profile.auth.keychainItem));
  }
  const migratedAccount = findAccount(accountName)!;
  const oldItem = profile.auth.keychainItem;
  profile.account = migratedAccount.name;
  profile.provider = provider;
  delete profile.auth;
  delete profile.authOptional;
  atomicWriteFileSync(file, yaml.stringify(profile));

  const stillReferenced = fs.readdirSync(path.dirname(file))
    .filter(entry => /\.ya?ml$/.test(entry) && path.join(path.dirname(file), entry) !== file)
    .some(entry => {
      try {
        const other = yaml.parse(fs.readFileSync(path.join(path.dirname(file), entry), 'utf8')) as Profile | null;
        return other?.auth?.keychainItem === oldItem;
      } catch { return false; }
    });
  if (!stillReferenced) deleteKeychainTokenSync(oldItem);
}

export function writeProfile(profile: Profile): void {
  validateProfileName(profile.name);
  const dir = getProfilesDir();
  fs.mkdirSync(dir, { recursive: true });
  const body = yaml.stringify(profile);
  const file = profilePath(profile.name);
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, body, 'utf-8');
  fs.renameSync(tmp, file);
}

export function deleteProfile(name: string): boolean {
  validateProfileName(name);
  const file = profilePath(name);
  if (!fs.existsSync(file)) return false;
  fs.unlinkSync(file);
  return true;
}

export function listProfiles(): Profile[] {
  const dir = getProfilesDir();
  if (!fs.existsSync(dir)) return [];
  const entries = fs.readdirSync(dir).filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'));
  const profiles: Profile[] = [];
  for (const entry of entries) {
    const name = entry.replace(/\.(yml|yaml)$/, '');
    try {
      profiles.push(readProfile(name));
    } catch {
    }
  }
  return profiles.sort((a, b) => a.name.localeCompare(b.name));
}

export function profileHostLabel(profile: Profile): string {
  return profile.host.version ? `${profile.host.agent}@${profile.host.version}` : profile.host.agent;
}

export function profileProviderLabel(profile: Profile): string {
  return profile.provider || profile.auth?.keychainItem?.split('.')[1] || '-';
}

const MODEL_ENV_KEYS = [
  'ANTHROPIC_MODEL',
  'ANTHROPIC_SMALL_FAST_MODEL',
  'OPENAI_MODEL',
  'GEMINI_MODEL',
  'GROK_MODEL',
  'OPENCODE_MODEL',
] as const;

export function profileModelLabel(profile: Profile): string {
  const key = profileModelEnvKey(profile);
  return key ? profile.env[key] : '-';
}

export function profileModelEnvKey(profile: Profile): string | null {
  for (const key of MODEL_ENV_KEYS) {
    if (profile.env[key]) return key;
  }
  for (const [key, value] of Object.entries(profile.env)) {
    if ((key === 'MODEL' || key.endsWith('_MODEL')) && value) return key;
  }
  return null;
}

function decodeJwtPayload(token: string): Record<string, unknown> | null {
  const parts = token.split('.');
  if (parts.length < 2) return null;
  try {
    const normalized = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');
    const decoded = Buffer.from(padded, 'base64').toString('utf-8');
    const parsed = JSON.parse(decoded);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function maskToken(token: string): string {
  if (token.length <= 12) return `${token.slice(0, 3)}...${token.slice(-2)}`;
  return `${token.slice(0, 6)}...${token.slice(-4)}`;
}

const INLINE_AUTH_KEYS = [
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
  'GEMINI_API_KEY',
  'GOOGLE_API_KEY',
  'XAI_API_KEY',
] as const;

function inlineAuthToken(profile: Profile): string | undefined {
  if (profile.auth?.envVar && profile.env[profile.auth.envVar]) {
    return profile.env[profile.auth.envVar];
  }
  for (const key of INLINE_AUTH_KEYS) {
    const value = profile.env[key];
    if (value) return value;
  }
  return undefined;
}

export function profileAuthLabel(profile: Profile): string {


  const provider = profileProviderLabel(profile);
  const token = inlineAuthToken(profile);
  if (token) {
    const payload = decodeJwtPayload(token);
    const identity =
      payload?.email ||
      payload?.preferred_username ||
      payload?.username ||
      payload?.sub;
    if (typeof identity === 'string') return `${provider} ${identity}`;
    return `${provider} ${maskToken(token)}`;
  }
  if (profile.auth) {
    let stored: boolean;
    try {
      stored = hasKeychainTokenSync(profile.auth.keychainItem);
    } catch (err) {

      if (isSecretsTransportError(err)) return `${provider} unavailable`;
      throw err;
    }
    return `${provider} ${stored ? 'stored' : 'missing'}`;
  }
  return provider;
}

const VENDOR_TABLE: ReadonlyArray<readonly [string, string]> = [
  ['deepseek', 'DeepSeek'],
  ['openai', 'OpenAI'],
  ['anthropic', 'Anthropic'],
  ['claude', 'Claude'],
  ['grok', 'Grok'],
  ['xai', 'xAI'],
  ['gpt', 'GPT'],
  ['meta', 'Meta'],
  ['mistral', 'Mistral'],
  ['mistralai', 'Mistral'],
  ['qwen', 'Qwen'],
  ['gemini', 'Gemini'],
  ['moonshot', 'Moonshot AI'],
  ['moonshotai', 'Moonshot AI'],
  ['kimi', 'Kimi'],
  ['cohere', 'Cohere'],
  ['perplexity', 'Perplexity'],
];

function tokenToDisplayName(token: string): string {
  const lower = token.toLowerCase();
  for (const [key, display] of VENDOR_TABLE) {
    if (lower === key) return display;
  }
  return token.charAt(0).toUpperCase() + token.slice(1);
}

export function profileLabel(profile: Profile): string {
  return profile.name.split(/[-_]/).map(tokenToDisplayName).join(' ');
}

export function profileSummary(profile: Profile): ProfileSummary {
  return {
    name: profile.name,
    label: profileLabel(profile),
    agent: profile.host.agent,
    host: profileHostLabel(profile),
    hostVersion: profile.host.version ?? null,
    provider: profileProviderLabel(profile),
    model: profileModelLabel(profile),
    auth: profileAuthLabel(profile),
    path: getProfilePath(profile.name),
    description: profile.description ?? null,
    forkedFrom: profile.forkedFrom ?? null,
  };
}

export function profileFromPreset(profileName: string, preset: Preset, version?: string): Profile {
  return {
    name: profileName,
    host: { agent: preset.host, version },
    env: { ...preset.env },
    auth: {
      envVar: preset.authEnvVar,
      keychainItem: profileKeychainItem(preset.provider),
    },
    authOptional: preset.authOptional,
    description: preset.description,
    preset: preset.name,
    provider: preset.provider,
    forkedFrom: preset.host,
  };
}

const MODEL_ENV_KEY_BY_HOST: Partial<Record<AgentId, string>> = {
  claude: 'ANTHROPIC_MODEL',
  opencode: 'OPENCODE_MODEL',
  grok: 'GROK_MODEL',
  codex: 'OPENAI_MODEL',
};

const BASE_URL_ENV_KEY_BY_HOST: Partial<Record<AgentId, string>> = {
  claude: 'ANTHROPIC_BASE_URL',
  codex: 'OPENAI_BASE_URL',
};

export function modelEnvKeyForHost(host: AgentId): string {
  return MODEL_ENV_KEY_BY_HOST[host] ?? `${host.toUpperCase()}_MODEL`;
}

export function baseUrlEnvKeyForHost(host: AgentId): string | null {
  return BASE_URL_ENV_KEY_BY_HOST[host] ?? null;
}

const AUTH_ENV_KEY_BY_HOST: Partial<Record<AgentId, string>> = {
  claude: 'ANTHROPIC_AUTH_TOKEN',
  codex: 'OPENAI_API_KEY',
  grok: 'XAI_API_KEY',
  opencode: 'OPENCODE_API_KEY',
};

export function authEnvKeyForHost(host: AgentId): string | null {
  return AUTH_ENV_KEY_BY_HOST[host] ?? null;
}

interface HostModelOptions {
  version?: string;
  baseUrl?: string;
  provider?: string;
  authEnvVar?: string;
  description?: string;
}

export function profileFromHostModel(name: string, host: AgentId, model: string, opts: HostModelOptions = {}): Profile {
  const env: Record<string, string> = { [modelEnvKeyForHost(host)]: model };
  if (opts.baseUrl) {
    const key = baseUrlEnvKeyForHost(host);
    if (key) env[key] = opts.baseUrl;
  }
  const profile: Profile = {
    name,
    host: { agent: host, version: opts.version },
    env,
    description: opts.description ?? `Custom harness: ${host} + ${model}`,
    provider: opts.provider ?? host,
    forkedFrom: host,
  };
  if (opts.provider && opts.authEnvVar) {
    profile.auth = { envVar: opts.authEnvVar, keychainItem: profileKeychainItem(opts.provider) };
    profile.authOptional = false;
  }
  return profile;
}

export interface ForkProfileOptions {
  host?: AgentId;
  model?: string;
  baseUrl?: string;
  provider?: string;
  authEnvVar?: string;
  version?: string;
  description?: string;
}

export function forkProfile(source: Profile, name: string, opts: ForkProfileOptions = {}): Profile {


  validateProfileName(name);
  const sourceHost = source.host.agent;
  const host = opts.host ?? sourceHost;
  const env = { ...source.env };
  const sourceModelKey = profileModelEnvKey(source) ?? modelEnvKeyForHost(sourceHost);
  const targetModelKey = modelEnvKeyForHost(host);
  const model = opts.model ?? env[sourceModelKey];
  if (host !== sourceHost && sourceModelKey !== targetModelKey) delete env[sourceModelKey];
  if (model) {
    env[targetModelKey] = model;
  }
  const sourceBaseKey = baseUrlEnvKeyForHost(sourceHost);
  const targetBaseKey = baseUrlEnvKeyForHost(host);
  const baseUrl = opts.baseUrl ?? (sourceBaseKey ? env[sourceBaseKey] : undefined);
  if (host !== sourceHost && sourceBaseKey && sourceBaseKey !== targetBaseKey) delete env[sourceBaseKey];
  if (baseUrl) {
    const key = targetBaseKey;
    if (!key) {
      throw new Error(`Host '${host}' has no known base-URL env var; drop --base-url or fork onto a claude/codex host.`);
    }
    env[key] = baseUrl;
  }
  const forked: Profile = {
    ...source,
    name,
    host: { agent: host, ...(opts.version ? { version: opts.version } : host === sourceHost && source.host.version ? { version: source.host.version } : {}) },
    env,
    description: opts.description ?? (opts.model || host !== sourceHost
      ? `Forked from ${source.name}: ${model ?? host}`
      : source.description),
    forkedFrom: source.name,
  };
  if (forked.auth && host !== sourceHost) {
    const envVar = authEnvKeyForHost(host);
    if (!envVar) throw new Error(`Host '${host}' has no known auth env var; the source auth binding cannot be translated.`);
    forked.auth = { ...forked.auth, envVar };
  }
  if (opts.model || opts.baseUrl || host !== sourceHost) delete forked.preset;
  if (opts.provider) {
    const envVar = opts.authEnvVar ?? source.auth?.envVar ?? authEnvKeyForHost(host);
    if (!envVar) {
      throw new Error(`Host '${host}' has no known auth env var; --provider cannot be attached to this fork.`);
    }
    forked.provider = opts.provider;
    forked.auth = { envVar, keychainItem: profileKeychainItem(opts.provider) };
    forked.authOptional = source.authOptional ?? false;
  }
  return forked;
}

export function editProfile(source: Profile, opts: ForkProfileOptions = {}): Profile {
  const edited = forkProfile(source, source.name, opts);
  edited.forkedFrom = source.forkedFrom;
  return edited;
}

export function renameProfile(oldName: string, newName: string): void {
  validateProfileName(newName);
  if (!profileExists(oldName)) {
    throw new Error(`Profile '${oldName}' not found.`);
  }
  if (profileExists(newName)) {
    throw new Error(`Profile '${newName}' already exists; remove it first.`);
  }
  const profile = readProfile(oldName);
  profile.name = newName;
  writeProfile(profile);
  deleteProfile(oldName);
  for (const other of listProfiles()) {
    if (other.name !== newName && other.forkedFrom === oldName) {
      other.forkedFrom = newName;
      writeProfile(other);
    }
  }
}

export function resolveProfileEnv(profile: Profile): Record<string, string> {


  const env: Record<string, string> = { ...profile.env };
  if (profile.account) {
    if (!findAccount(profile.account)) {
      throw new Error(
        `Harness '${profile.name}' references account '${profile.account}', which does not exist on this device. ` +
        `Accounts are per-machine; pick one from 'agents accounts list' and repoint with ` +
        `'agents harness edit ${profile.name} --account <name>', or add it with 'agents accounts add'.`,
      );
    }
    const account = resolveCredentialAccount(profile.account, profile.host.agent, profile.provider);
    Object.assign(env, account.env);
  }
  if (profile.auth) {
    if (profile.authOptional && !hasKeychainTokenSync(profile.auth.keychainItem)) {
      return env;
    }
    let token: string;
    try {
      token = getKeychainTokenSync(profile.auth.keychainItem);
    } catch (err) {
      if (!isSecretsClientError(err, 'NOT_FOUND')) throw err;
      throw new Error(
        `Harness '${profile.name}' needs a ${profile.provider ?? 'provider'} key, but its keychain item ` +
        `'${profile.auth.keychainItem}' is missing on this device. Store one with ` +
        `'agents harness edit ${profile.name} --auth-provider ${profile.provider ?? '<provider>'}' ` +
        `(or --from-secrets <bundle>:<key>), or bind an account with 'agents harness edit ${profile.name} --account <name>'.`,
      );
    }
    env[profile.auth.envVar] = token;
  }
  return env;
}

interface ResolvedProfileRun {
  agent: AgentId;
  version?: string;
  env: Record<string, string>;
  profileName: string;
  fallbackModel?: { envKey: string; model: string };
  tierNote?: string;
  resolvedModel?: string;
}

function resolveProfileTierModel(
  profile: Profile,
  tier: ModelTier,
): { model: string; clampedFrom?: ModelTier } | null {

  if (!profile.models) return null;
  const idx = MODEL_TIERS.indexOf(tier);
  for (let i = idx; i >= 0; i--) {
    const rung = MODEL_TIERS[i];
    const model = profile.models[rung];
    if (model) return { model, clampedFrom: rung === tier ? undefined : rung };
  }
  return null;
}

export function resolveProfileForRun(name: string, requestedModel?: string): ResolvedProfileRun {
  const profile = readProfile(name);
  const env = resolveProfileEnv(profile);
  const resolved: ResolvedProfileRun = {
    agent: profile.host.agent,
    version: profile.host.version,
    env,
    profileName: profile.name,
  };

  if (profile.fallback_model) {
    const envKey = profileModelEnvKey(profile);
    if (envKey) {
      resolved.fallbackModel = { envKey, model: profile.fallback_model };
    }
  }
  if (isTierToken(requestedModel)) {
    const tierPick = resolveProfileTierModel(profile, requestedModel);
    if (tierPick) {
      const envKey = profileModelEnvKey(profile) ?? modelEnvKeyForHost(profile.host.agent);
      env[envKey] = tierPick.model;
      resolved.resolvedModel = tierPick.model;
      if (tierPick.clampedFrom) {
        resolved.tierNote = `no "${requestedModel}" model configured on profile '${profile.name}'; using its "${tierPick.clampedFrom}" tier (${tierPick.model})`;
      }
    }
  }
  if (resolved.resolvedModel === undefined && !requestedModel && profile.host.agent === 'opencode') {

    const envKey = profileModelEnvKey(profile) ?? modelEnvKeyForHost('opencode');
    const pinned = env[envKey];
    if (pinned) resolved.resolvedModel = pinned;
  }
  return resolved;
}
