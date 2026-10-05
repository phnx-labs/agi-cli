import { spawnSync } from 'child_process';
import { machineId } from './machine-id.js';
import { parseSshConnection } from './session/provenance.js';
import { readSession, type PhoenixSession } from './identity/client.js';
import { readMeta } from './state.js';
import type { ActorConfig } from './types.js';

export type ActorKind = 'human' | 'agent';

export interface ResolvedActor {
  id: string;
  kind: ActorKind;
  name?: string;
  email?: string;
  github?: string;
  phoenixId?: string;
  avatarUrl?: string;
}

interface WhoisIdentity {
  login?: string;
  displayName?: string;
}

const WHOIS_TIMEOUT_MS = 2000;

function tailscaleWhois(ip: string): WhoisIdentity | undefined {
  try {
    const res = spawnSync('tailscale', ['whois', '--json', ip], {
      encoding: 'utf-8',
      windowsHide: true,
      timeout: WHOIS_TIMEOUT_MS,
    });
    if (res.status !== 0 || !res.stdout) return undefined;
    const data = JSON.parse(res.stdout) as { UserProfile?: { LoginName?: string; DisplayName?: string } };
    const up = data.UserProfile;
    if (!up) return undefined;
    return { login: up.LoginName, displayName: up.DisplayName };
  } catch {
    return undefined;
  }
}

function tailscaleSelf(): WhoisIdentity | undefined {
  try {
    const res = spawnSync('tailscale', ['status', '--json'], {
      encoding: 'utf-8',
      windowsHide: true,
      timeout: WHOIS_TIMEOUT_MS,
    });
    if (res.status !== 0 || !res.stdout) return undefined;
    const data = JSON.parse(res.stdout) as {
      Self?: { UserID?: number };
      User?: Record<string, { LoginName?: string; DisplayName?: string }>;
    };
    const uid = data.Self?.UserID;
    if (uid == null) return undefined;
    const u = data.User?.[String(uid)];
    if (!u?.LoginName) return undefined;
    return { login: u.LoginName, displayName: u.DisplayName };
  } catch {
    return undefined;
  }
}

function readActors(): Record<string, ActorConfig> {
  try {
    return readMeta().actors ?? {};
  } catch {
    return {};
  }
}

function findActorConfig(login: string, actors: Record<string, ActorConfig>): ActorConfig | undefined {
  const needle = login.toLowerCase();
  for (const [key, cfg] of Object.entries(actors)) {
    const candidates = [cfg.login, key, cfg.email].filter((v): v is string => !!v);
    if (candidates.some((c) => c.toLowerCase() === needle)) return cfg;
  }
  return undefined;
}

export function actorFromIdentity(
  who: WhoisIdentity | undefined,
  host: string,
  actors: Record<string, ActorConfig>,
): ResolvedActor {
  const login = who?.login;
  if (!login) {
    return { id: `UNRESOLVED@${host}`, kind: 'human' };
  }
  const cfg = findActorConfig(login, actors);
  const emailFromLogin = login.includes('@') ? login : undefined;
  return {
    id: login,
    kind: cfg?.kind ?? 'human',
    name: cfg?.name ?? who?.displayName,
    email: cfg?.email ?? emailFromLogin,
    github: cfg?.github,
    phoenixId: cfg?.phoenixId,
  };
}

function inheritedActor(env: NodeJS.ProcessEnv): ResolvedActor | undefined {
  const id = env.AGENTS_ACTOR;
  if (!id) return undefined;
  return {
    id,
    kind: env.AGENTS_ACTOR_KIND === 'agent' ? 'agent' : 'human',
    name: env.AGENTS_ACTOR_NAME || undefined,
    email: env.AGENTS_ACTOR_EMAIL || undefined,
    github: env.AGENTS_ACTOR_GITHUB || undefined,
    phoenixId: env.AGENTS_ACTOR_PHOENIX_ID || undefined,
    avatarUrl: httpsUrl(env.AGENTS_ACTOR_AVATAR),
  };
}

export function httpsUrl(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed && /^https:\/\/\S+$/i.test(trimmed) ? trimmed : undefined;
}

export function actorAvatar(actor: ResolvedActor, session: PhoenixSession | null): string | undefined {

  if (actor.kind !== 'human' || !actor.email || !session?.email) return undefined;
  if (actor.email.trim().toLowerCase() !== session.email.trim().toLowerCase()) return undefined;
  return httpsUrl(session.avatarUrl);
}

interface ActorResolvers {
  whois: (ip: string) => WhoisIdentity | undefined;
  self: () => WhoisIdentity | undefined;
  session: () => PhoenixSession | null;
}

const defaultResolvers: ActorResolvers = { whois: tailscaleWhois, self: tailscaleSelf, session: readSession };

export function computeActor(
  env: NodeJS.ProcessEnv = process.env,
  resolvers: ActorResolvers = defaultResolvers,
): ResolvedActor {
  const inherited = inheritedActor(env);
  if (inherited) return inherited;

  const sshRaw = env.SSH_CONNECTION;
  const ssh = sshRaw ? parseSshConnection(sshRaw) : undefined;

  let who = ssh?.clientIp ? resolvers.whois(ssh.clientIp) : undefined;
  if (!who && !sshRaw) who = resolvers.self();
  const actor = actorFromIdentity(who, machineId(), readActors());
  const avatarUrl = actorAvatar(actor, resolvers.session());
  return avatarUrl ? { ...actor, avatarUrl } : actor;
}

let cached: ResolvedActor | undefined;
let resolverOverride: ActorResolvers | undefined;

export function resolveActor(): ResolvedActor {
  if (!cached) cached = computeActor(process.env, resolverOverride ?? defaultResolvers);
  return cached;
}

export function setActorResolvers(resolvers: ActorResolvers | undefined): void {
  resolverOverride = resolvers;
  cached = undefined;
}

export function resetActorCache(): void {
  cached = undefined;
}

export function actorEnv(actor: ResolvedActor): Record<string, string> {
  const env: Record<string, string> = {
    AGENTS_ACTOR: actor.id,
    AGENTS_ACTOR_KIND: actor.kind,
  };
  if (actor.name) env.AGENTS_ACTOR_NAME = actor.name;
  if (actor.email) env.AGENTS_ACTOR_EMAIL = actor.email;
  if (actor.github) env.AGENTS_ACTOR_GITHUB = actor.github;
  if (actor.phoenixId) env.AGENTS_ACTOR_PHOENIX_ID = actor.phoenixId;
  if (actor.avatarUrl) env.AGENTS_ACTOR_AVATAR = actor.avatarUrl;

  if (actor.kind === 'human' && actor.name && actor.email) {
    env.GIT_AUTHOR_NAME = actor.name;
    env.GIT_AUTHOR_EMAIL = actor.email;
    env.GIT_COMMITTER_NAME = actor.name;
    env.GIT_COMMITTER_EMAIL = actor.email;
  }
  return env;
}
