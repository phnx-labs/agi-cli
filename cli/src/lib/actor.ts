/**
 * Actor provenance -- who initiated a run.
 *
 * One shared account means every session, commit, and event otherwise shows up
 * as the same person. `resolveActor()` answers "which human is behind this run"
 * by looking at how the process was reached:
 *
 *   - Over SSH (the shared-fleet case): `tailscale whois` the SSH client IP to
 *     the connecting tailnet identity -- a real name + login email.
 *   - Locally (non-SSH): the run belongs to whoever owns this device on the
 *     tailnet, so we read that owner from `tailscale status` (`.Self.UserID` ->
 *     `.User[]`). Only if tailscale can't name the device owner either do we fall
 *     back to the honest `UNRESOLVED@<host>` with no personal git identity claimed.
 *   - Inherited: a child spawn trusts the `AGENTS_ACTOR*` env its parent
 *     stamped rather than re-resolving, so the whole spawn tree shares one actor.
 *
 * The resolved actor rides the child-process env (`actorEnv()`, merged into
 * `buildExecEnv`). When the actor is a resolved human, that env also carries
 * `GIT_AUTHOR_*` / `GIT_COMMITTER_*`, so the agent's own `git commit` is credited
 * to the person instead of the shared account.
 *
 * The optional `actors:` map in agents.yaml enriches or overrides a resolved
 * identity (pin a work email, add a github handle, mark an entry as an agent).
 */
import { spawnSync } from 'child_process';
import { machineId } from './machine-id.js';
import { parseSshConnection } from './session/provenance.js';
import { readSession, type PhoenixSession } from './identity/client.js';
import { readMeta } from './state.js';
import type { ActorConfig } from './types.js';

export type ActorKind = 'human' | 'agent';

export interface ResolvedActor {
  /**
   * Stable id for the responsible entity: the tailnet login (usually an email)
   * for a resolved human, or `UNRESOLVED@<host>` when it can't be determined.
   */
  id: string;
  kind: ActorKind;
  /** Human-readable name, for git author + display. */
  name?: string;
  /** Email, for git author + as a durable key. */
  email?: string;
  /** GitHub handle, when the actors map records one. */
  github?: string;
  /**
   * Phoenix (work) identity id for this human, when the actors map records one.
   * Bridges a personal tailnet login (e.g. a personal gmail) to the stable
   * internal work identity, so attribution survives whichever email a person
   * happens to be signed into tailscale with.
   */
  phoenixId?: string;
  /**
   * The human's hosted profile picture (https URL) from the Phoenix ID session
   * signed in on this device, attached only when that session belongs to the
   * same email as the resolved actor. Rides the env as `AGENTS_ACTOR_AVATAR` so
   * tools the agent runs (artifacts, shares) can show the person, not initials.
   */
  avatarUrl?: string;
}

/** Result of `tailscale whois --json <ip>` we care about. */
interface WhoisIdentity {
  login?: string;
  displayName?: string;
}

/** Hard cap on the whois shell-out — it runs on the spawn hot path. */
const WHOIS_TIMEOUT_MS = 2000;

/**
 * Resolve the tailnet identity behind an IP via `tailscale whois`. Returns
 * undefined when tailscale is absent, the peer is unknown, the call fails, or it
 * exceeds WHOIS_TIMEOUT_MS -- every one of those falls back to an unresolved
 * actor, never an error and never a hang (a wedged tailscaled is timed out, not
 * waited on, since this sits in buildExecEnv on every agent spawn).
 */
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

/**
 * Resolve this device's own tailnet owner via `tailscale status --json`:
 * `.Self.UserID` indexes into the `.User` map for the owner's login + display
 * name. Used for a LOCAL run, where there is no SSH client to whois — the run
 * belongs to whoever owns the box on the tailnet. Same graceful-undefined +
 * timeout discipline as `tailscaleWhois`: tailscale absent, a wedged daemon, a
 * tagged (owner-less) device, or a parse failure all yield undefined, never an
 * error and never a hang on the spawn hot path.
 */
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

/**
 * Find the actors-map entry for a resolved tailnet login. Matches on an entry's
 * explicit `login`, its map key, or its `email` (all case-insensitive).
 */
function findActorConfig(login: string, actors: Record<string, ActorConfig>): ActorConfig | undefined {
  const needle = login.toLowerCase();
  for (const [key, cfg] of Object.entries(actors)) {
    const candidates = [cfg.login, key, cfg.email].filter((v): v is string => !!v);
    if (candidates.some((c) => c.toLowerCase() === needle)) return cfg;
  }
  return undefined;
}

/**
 * Map a resolved tailnet identity (+ the actors map) to a ResolvedActor. Pure --
 * the impure whois/config reads happen in computeActor -- so the enrich/override
 * path is fully testable. No login (local, or an unnameable peer) yields the
 * honest `UNRESOLVED@<host>`; a login without a config entry still credits git
 * from the tailnet DisplayName + login email.
 */
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
function httpsUrl(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed && /^https:\/\/\S+$/i.test(trimmed) ? trimmed : undefined;
}

/**
 * The Phoenix ID profile picture for a resolved human, when the session signed
 * in on this device is that same person (matched on email, case-insensitive).
 * A shared box signed in as someone else must not lend its picture to whoever
 * SSH-ed in, so a mismatch yields nothing. Pure: the session is injected.
 */
export function actorAvatar(actor: ResolvedActor, session: PhoenixSession | null): string | undefined {
  if (actor.kind !== 'human' || !actor.email || !session?.email) return undefined;
  if (actor.email.trim().toLowerCase() !== session.email.trim().toLowerCase()) return undefined;
  return httpsUrl(session.avatarUrl);
}

/**
 * Injectable tailscale resolvers, so tests can drive the SSH-whois and
 * local-self branches deterministically without a real tailscale on the box
 * (a dev machine that *is* on the tailnet would otherwise make the local path
 * non-deterministic). Production callers use the defaults.
 */
interface ActorResolvers {
  whois: (ip: string) => WhoisIdentity | undefined;
  self: () => WhoisIdentity | undefined;
  /** The Phoenix ID session on this device (a local file read, no network). */
  session: () => PhoenixSession | null;
}

const defaultResolvers: ActorResolvers = { whois: tailscaleWhois, self: tailscaleSelf, session: readSession };

/**
 * Compute the actor for a given environment. The only impurity is the tailscale
 * shell-out (injectable via `resolvers`), so tests drive every branch explicitly.
 *
 * Resolution order: an inherited env actor wins; otherwise an SSH run whois-es
 * its client IP; a local run (no SSH) credits the device's own tailnet owner;
 * and anything unresolvable degrades to `UNRESOLVED@<host>`. Note the self
 * fallback fires ONLY for a truly local run — an SSH run whose whois fails must
 * NOT be credited to the box owner (that would misattribute a remote human to
 * whoever owns the machine).
 */
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

/**
 * Resolve the actor for the current process, cached for the process lifetime
 * (the SSH `whois` shell-out runs at most once).
 */
export function resolveActor(): ResolvedActor {
  if (!cached) cached = computeActor(process.env, resolverOverride ?? defaultResolvers);
  return cached;
}

/**
 * Test-only: pin the tailscale resolvers `resolveActor()` uses, so a test that
 * exercises the cached production entrypoint (e.g. `withActorEnv()`) is isolated
 * from whether the box running it is on the tailnet. `computeActor` already takes
 * injected resolvers for its unit tests; this extends the same seam to the cached
 * path. Pass `undefined` to restore the real tailscale resolvers. Resets the
 * cache so the next `resolveActor()` recomputes under the new resolvers.
 */
export function setActorResolvers(resolvers: ActorResolvers | undefined): void {
  resolverOverride = resolvers;
  cached = undefined;
}

/** Clear the per-process cache. For tests, and for env changes within a run. */
export function resetActorCache(): void {
  cached = undefined;
}

/**
 * The env an actor propagates to child processes. Always carries the actor id +
 * kind (so children inherit and don't re-resolve). For a resolved human with a
 * real name and email, it also carries `GIT_AUTHOR_*` / `GIT_COMMITTER_*` so the
 * agent's own commits are credited to the person, not the shared account. An
 * unresolved actor sets no git identity -- git keeps its ambient config.
 */
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
