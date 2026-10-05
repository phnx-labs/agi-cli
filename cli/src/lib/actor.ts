/** Actor provenance: who initiated a run. `resolveActor()` uses `tailscale whois` of the SSH client
 * IP, else the device owner from `tailscale status`, else `UNRESOLVED@<host>`; a child spawn
 * inherits `AGENTS_ACTOR*`. Rides `actorEnv()` into buildExecEnv; agents.yaml `actors:` overrides. */
import { spawnSync } from 'child_process';
import { machineId } from './machine-id.js';
import { parseSshConnection } from './session/provenance.js';
import { readSession, type PhoenixSession } from './identity/client.js';
import { readMeta } from './state.js';
import type { ActorConfig } from './types.js';

export type ActorKind = 'human' | 'agent';

export interface ResolvedActor {
  /** Stable id for the responsible entity: the tailnet login (usually an email) for a resolved
   * human, or `UNRESOLVED@<host>` when it can't be determined. */
  id: string;
  kind: ActorKind;
  /** Human-readable name, for git author + display. */
  name?: string;
  /** Email, for git author + as a durable key. */
  email?: string;
  /** GitHub handle, when the actors map records one. */
  github?: string;
  /** Phoenix (work) identity id for this human, when the actors map records one. Bridges a personal
   * tailnet login to the stable work identity so attribution survives whichever email tailscale
   * uses. */
  phoenixId?: string;
  /** The human's hosted profile picture (https URL) from the Phoenix ID session on this device,
   * attached only when it matches the resolved actor's email. Rides the env as
   * `AGENTS_ACTOR_AVATAR`. */
  avatarUrl?: string;
}

/** Result of `tailscale whois --json <ip>` we care about. */
interface WhoisIdentity {
  login?: string;
  displayName?: string;
}

/** Hard cap on the whois shell-out — it runs on the spawn hot path. */
const WHOIS_TIMEOUT_MS = 2000;

/** Resolve the tailnet identity behind an IP via `tailscale whois`. Absent tailscale, unknown peer,
 * failure or WHOIS_TIMEOUT_MS all give an unresolved actor, never an error or hang, since this
 * sits in buildExecEnv on every spawn. */
function tailscaleWhois(ip: string): WhoisIdentity | undefined {
  try {
    const res = spawnSync('tailscale', ['whois', '--json', ip], {
      encoding: 'utf-8',
      windowsHide: true,
      timeout: WHOIS_TIMEOUT_MS,
    });
    // A timeout leaves status null (child killed by SIGTERM) -- the status guard
    // below treats it as an unresolved actor, same as any other failure.
    if (res.status !== 0 || !res.stdout) return undefined;
    const data = JSON.parse(res.stdout) as { UserProfile?: { LoginName?: string; DisplayName?: string } };
    const up = data.UserProfile;
    if (!up) return undefined;
    return { login: up.LoginName, displayName: up.DisplayName };
  } catch {
    return undefined;
  }
}

/** Resolve this device's tailnet owner via `tailscale status --json` (`.Self.UserID` into `.User`),
 * for a local run with no SSH client to whois. Absent tailscale, wedged daemon, tagged device or
 * parse failure give undefined, never an error or hang on the spawn path. */
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
    // The User map is keyed by the UserID rendered as a string.
    const u = data.User?.[String(uid)];
    if (!u?.LoginName) return undefined;
    return { login: u.LoginName, displayName: u.DisplayName };
  } catch {
    return undefined;
  }
}

/** Read the actors map from config, tolerant of a missing/unreadable config. */
function readActors(): Record<string, ActorConfig> {
  try {
    return readMeta().actors ?? {};
  } catch {
    return {};
  }
}

/** Find the actors-map entry for a resolved tailnet login, matching an entry's `login`, map key, or
 * `email` (case-insensitive). */
function findActorConfig(login: string, actors: Record<string, ActorConfig>): ActorConfig | undefined {
  const needle = login.toLowerCase();
  for (const [key, cfg] of Object.entries(actors)) {
    const candidates = [cfg.login, key, cfg.email].filter((v): v is string => !!v);
    if (candidates.some((c) => c.toLowerCase() === needle)) return cfg;
  }
  return undefined;
}

/** Map a resolved tailnet identity plus the actors map to a ResolvedActor. Pure: the impure reads
 * happen in computeActor. No login yields `UNRESOLVED@<host>`; a login without a config entry still
 * credits git from the tailnet DisplayName and login email. */
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

/** Reconstruct an actor an ancestor process already resolved into the env. */
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

/** An avatar is only ever an https URL; anything else is not an avatar. */
export function httpsUrl(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed && /^https:\/\/\S+$/i.test(trimmed) ? trimmed : undefined;
}

/** The Phoenix ID profile picture for a resolved human, only when the session signed in on this
 * device is the same person (email match). A shared box signed in as someone else must not lend
 * its picture to an SSH-ed user. */
export function actorAvatar(actor: ResolvedActor, session: PhoenixSession | null): string | undefined {
  if (actor.kind !== 'human' || !actor.email || !session?.email) return undefined;
  if (actor.email.trim().toLowerCase() !== session.email.trim().toLowerCase()) return undefined;
  return httpsUrl(session.avatarUrl);
}

/** Injectable tailscale resolvers so tests drive the SSH-whois and local-self branches
 * deterministically; a dev machine on the tailnet would otherwise make the local path
 * non-deterministic. */
interface ActorResolvers {
  whois: (ip: string) => WhoisIdentity | undefined;
  self: () => WhoisIdentity | undefined;
  /** The Phoenix ID session on this device (a local file read, no network). */
  session: () => PhoenixSession | null;
}

const defaultResolvers: ActorResolvers = { whois: tailscaleWhois, self: tailscaleSelf, session: readSession };

/** Compute the actor for an environment; the only impurity is the injectable tailscale shell-out.
 * Order: inherited env actor, SSH whois, local tailnet owner, else `UNRESOLVED@<host>`. The self
 * fallback is for local runs only: an SSH run whose whois fails must not credit the box owner. */
export function computeActor(
  env: NodeJS.ProcessEnv = process.env,
  resolvers: ActorResolvers = defaultResolvers,
): ResolvedActor {
  const inherited = inheritedActor(env);
  if (inherited) return inherited;

  const sshRaw = env.SSH_CONNECTION;
  const ssh = sshRaw ? parseSshConnection(sshRaw) : undefined;
  let who = ssh?.clientIp ? resolvers.whois(ssh.clientIp) : undefined;
  // Self-credit only for a genuinely LOCAL run (no SSH_CONNECTION at all). An
  // SSH session whose connection is unparseable or unresolvable stays
  // UNRESOLVED rather than being misattributed to the box's owner.
  if (!who && !sshRaw) who = resolvers.self();
  const actor = actorFromIdentity(who, machineId(), readActors());
  const avatarUrl = actorAvatar(actor, resolvers.session());
  return avatarUrl ? { ...actor, avatarUrl } : actor;
}

let cached: ResolvedActor | undefined;
let resolverOverride: ActorResolvers | undefined;

/** Resolve the actor for the current process, cached for its lifetime (the SSH `whois` runs at most
 * once). */
export function resolveActor(): ResolvedActor {
  if (!cached) cached = computeActor(process.env, resolverOverride ?? defaultResolvers);
  return cached;
}

/** Test-only: pin the tailscale resolvers `resolveActor()` uses so tests of the cached entrypoint
 * are isolated from whether the box is on the tailnet. `undefined` restores the real ones; resets
 * the cache. */
export function setActorResolvers(resolvers: ActorResolvers | undefined): void {
  resolverOverride = resolvers;
  cached = undefined;
}

/** Clear the per-process cache. For tests, and for env changes within a run. */
export function resetActorCache(): void {
  cached = undefined;
}

/** The env an actor propagates to children: actor id + kind (so they don't re-resolve), and for a
 * resolved human with name and email, `GIT_AUTHOR_*`/`GIT_COMMITTER_*` so commits credit the
 * person. An unresolved actor sets no git identity. */
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
