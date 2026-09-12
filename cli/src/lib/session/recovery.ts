import * as fs from 'fs';
import * as path from 'path';
import { AGENTS, agentConfigDirName } from '../agents.js';
import { isSelfHost } from '../devices/self-host.js';
import { nativeResume } from '../exec.js';
import { machineId, normalizeHost } from '../machine-id.js';
import {
  formatNoHealthyAccountError,
  pickBalancedCandidate,
  readinessFromCandidate,
  type RotateCandidate,
} from '../accounting/rotate.js';
import { collectRunCandidatesForRun } from '../accounting/account-pool-collect.js';
import type { AgentId } from '../types.js';
import { getVersionHomePath } from '../installations/store.js';
import type { SessionAgentId, SessionMeta } from './types.js';

const RESUMABLE_SESSION_AGENTS = new Set<SessionAgentId>(['claude', 'codex', 'muse', 'opencode']);

/** One capability boundary for every surface that advertises faithful Resume. */
export function sessionAgentSupportsResume(agent: SessionAgentId): boolean {
  return RESUMABLE_SESSION_AGENTS.has(agent);
}

/**
 * The account a recovery should authenticate as — the identity that produced
 * the session, or a healthy sibling rotated in when the origin is limited.
 * `selector` is what a caller feeds into the existing account-selection path
 * (`resolveSpawnAccount`'s `explicit` argument / `options.account`); exactly
 * one of `providerAccount` / `nativeAccount` also names which kind it is:
 *
 * - `providerAccount` — a durable setup-token / API-key account (RUSH-3182)
 *   injected via `resolveSpawnAccount` → `accountEnv`. It is the only kind
 *   that can authenticate a NATIVE resume in a DIFFERENT home than the
 *   account that produced it, because it carries no isolated home of its own.
 * - `nativeAccount` — a native login slot (PHNX-3940 T5): resolved to its
 *   spawn HOME via `resolveNativeSpawnHome`. Present even for the plain
 *   healthy-origin case now, because account-first slot candidates for one
 *   harness all share the single installed binary's version label — `version`
 *   alone can no longer identify which account's home to launch.
 *
 * Required on `/continue` when the pick is a provider: exec only injects from
 * this field, so omitting it would launch the version home's native login —
 * the exhausted origin in the PHNX-3674 fixture. Absent means "use the
 * launched version home's own native login" (a legacy pre-account-first
 * installation, where the version home IS the account).
 */
export interface RecoveryAccount {
  selector: string;
  providerAccount?: string;
  nativeAccount?: string;
  label: string;
  email: string | null;
}

export type SessionRecoveryTarget =
  | { mode: 'native'; agent: AgentId; version: string; cwd?: string; account?: RecoveryAccount; reason: string }
  | { mode: 'continue'; agent: AgentId; version: string; account?: RecoveryAccount; reason: string };

export type NativeResumeInspection =
  | { available: true; cwd?: string }
  | { available: false; reason: string };

export class SessionRecoveryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SessionRecoveryError';
  }
}

/** Canonical origin-device label for every recovery consumer. */
export function sessionOriginDevice(
  session: Pick<SessionMeta, 'machine'>,
  self = machineId(),
): string {
  return normalizeHost(session.machine ?? self);
}

/** The peer that must execute recovery, or undefined when this is the origin. */
export function sessionRecoveryPeer(
  session: Pick<SessionMeta, 'machine'>,
  selfCheck: (host: string) => boolean = isSelfHost,
): string | undefined {
  if (!session.machine || selfCheck(session.machine)) return undefined;
  return normalizeHost(session.machine);
}

/** Whether an explicit placement names the session's origin device. */
export function sessionRecoveryDestinationMatches(
  session: Pick<SessionMeta, 'machine'>,
  requestedHost: string,
  self = machineId(),
): boolean {
  const requested = normalizeHost(requestedHost.split('@').pop() || requestedHost);
  return requested === sessionOriginDevice(session, self);
}

function runnableSessionAgent(session: SessionMeta): AgentId {
  if (!(session.agent in AGENTS)) {
    throw new SessionRecoveryError(
      `Session ${session.shortId} belongs to ${session.agent}, which is indexed but cannot be launched by agents run.`,
    );
  }
  return session.agent as AgentId;
}

/** The home a candidate resumes from: its own slot when it's an account-first
 * native login, else the shared version home (a legacy install, or a provider
 * account, which has no isolated home of its own and runs in the version home
 * its credential is injected into). */
function candidateHome(candidate: RotateCandidate): string {
  return candidate.slotDir ?? getVersionHomePath(candidate.agent, candidate.version);
}

/**
 * The candidate that actually produced this session — proven by canonical
 * identity (`accountKey`) or by owning the indexed transcript on disk, never
 * by a recorded version LABEL alone. Account-first native slots for one
 * harness all share the single installed binary's version label, so version
 * cannot disambiguate between them; a self-updating or aliased install can
 * also report a live version that no longer matches the label a session
 * recorded against, which used to send a perfectly healthy origin to
 * `/continue` under a brand-new id instead of resuming it natively. Falls
 * back to a version-label match only when neither signal resolves anything
 * (a legacy session with no `accountKey`, whose transcript's home is not
 * among today's candidates — e.g. every account for that harness rotated out).
 */
function originCandidate(session: SessionMeta, candidates: RotateCandidate[]): RotateCandidate | undefined {
  if (session.accountKey) {
    const byIdentity = candidates.find((candidate) => candidate.accountKey === session.accountKey);
    if (byIdentity) return byIdentity;
  }
  const proven = candidates.find((candidate) => inspectNativeResumeSession(session, candidateHome(candidate)).available);
  if (proven) return proven;
  if (!session.version) return undefined;
  return candidates.find((candidate) => candidate.version === session.version);
}

function sourceReason(session: SessionMeta, candidates: RotateCandidate[]): string {
  if (!session.version && !session.accountKey) return 'the origin version was not recorded';
  const source = originCandidate(session, candidates);
  if (!source) return `origin ${session.agent}@${session.version ?? 'unknown'} is not installed`;
  const readiness = readinessFromCandidate(source);
  return readiness.ready
    ? `origin ${session.agent}@${source.version} has no native resume form`
    : `origin ${session.agent}@${source.version} is ${readiness.reason}`;
}

function recoveryAccountFromCandidate(candidate: RotateCandidate): RecoveryAccount | undefined {
  const selector = candidate.nativeAccount ?? candidate.providerAccount;
  if (!selector) return undefined;
  return {
    selector,
    ...(candidate.providerAccount ? { providerAccount: candidate.providerAccount } : {}),
    ...(candidate.nativeAccount ? { nativeAccount: candidate.nativeAccount } : {}),
    label: candidate.accountLabel || selector,
    email: candidate.email,
  };
}

function isPathInside(candidate: string, dir: string): boolean {
  const rel = path.relative(dir, candidate);
  return rel === '' || (!!rel && !rel.startsWith('..') && !path.isAbsolute(rel));
}

function existingDirectory(dir: string | undefined): string | undefined {
  if (!dir) return undefined;
  try {
    return fs.statSync(dir, { throwIfNoEntry: false })?.isDirectory() ? dir : undefined;
  } catch {
    return undefined;
  }
}

/** Read the launch cwd Claude used to choose its projects/<cwd-key> directory.
 * Claude can record attachment envelopes before the first user turn, and those
 * envelopes retain the actual launch cwd even after the session changes dirs. */
function readClaudeLaunchCwd(filePath: string): string | undefined {
  const maxBytes = 2 * 1024 * 1024;
  let fd: number;
  try {
    fd = fs.openSync(filePath, 'r');
  } catch {
    return undefined;
  }

  try {
    const chunk = Buffer.alloc(maxBytes);
    const bytesRead = fs.readSync(fd, chunk, 0, maxBytes, 0);
    const lines = chunk.toString('utf8', 0, bytesRead).split('\n');
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line);
        if (typeof parsed?.cwd !== 'string' || !path.isAbsolute(parsed.cwd)) continue;
        if (existingDirectory(parsed.cwd)) return parsed.cwd;
      } catch {
        // A malformed line or vanished cwd cannot identify a usable native home.
      }
    }
  } finally {
    fs.closeSync(fd);
  }
  return undefined;
}

/**
 * Prove that the indexed transcript is reachable from the exact active version
 * home that would receive native resume. Retained trash/backup transcripts are
 * intentionally rejected here: they remain readable by `/continue`, but a new
 * installation with the same version number must not native-resume an empty
 * isolated home.
 */
export function inspectNativeResumeSession(
  session: SessionMeta,
  versionHome: string,
): NativeResumeInspection {
  let realFile: string;
  try {
    realFile = fs.realpathSync(session.filePath);
  } catch {
    return { available: false, reason: 'the indexed transcript is no longer present in the origin home' };
  }

  const roots = [versionHome, path.join(versionHome, agentConfigDirName(session.agent as AgentId))];
  const owned = roots.some((root) => {
    try {
      return isPathInside(realFile, fs.realpathSync(root));
    } catch {
      return false;
    }
  });
  if (!owned) {
    return {
      available: false,
      reason: `the indexed transcript is retained outside the active ${session.agent}@${session.version ?? 'unknown'} home`,
    };
  }

  if (session.agent === 'claude') {
    const cwd = readClaudeLaunchCwd(realFile);
    if (!cwd) {
      return {
        available: false,
        reason: 'the Claude transcript does not identify an existing original project directory',
      };
    }
    return { available: true, cwd };
  }

  const cwd = existingDirectory(session.cwd);
  return { available: true, cwd };
}

/**
 * Decide how a durable session resumes on the device that owns it.
 *
 * Native resume is legal only in the exact origin version's isolated home,
 * and only while that home owns the indexed transcript AND some injectable
 * credential for this harness is healthy: the origin login itself, or a
 * provider account rotated in when the origin is usage-limited (PHNX-3626).
 * Every other successful path stays on the same harness and uses `/continue`,
 * whose indexed transcript reader can reach retained version trash. A
 * `/continue` pick of a provider account carries RecoveryAccount so exec
 * injects it instead of launching the version home's native login
 * (PHNX-3674). No healthy same-harness account is a loud failure.
 */
export function resolveSessionRecoveryFromCandidates(
  session: SessionMeta,
  candidates: RotateCandidate[],
  supportsNative: (agent: AgentId, version?: string) => boolean = nativeResume,
  nativeInspection?: NativeResumeInspection,
): SessionRecoveryTarget {
  const agent = runnableSessionAgent(session);
  const device = sessionOriginDevice(session);
  const source = originCandidate(session, candidates);
  const sourceReady = source ? readinessFromCandidate(source).ready : false;

  // Native-first with account rotation (PHNX-3626). When the origin login is
  // usage/rate/session-LIMITED (not signed-out or revoked — those need a login,
  // not a rotation, so they keep going to /continue per SES-39) but its version
  // home is installed, native-resume-capable, and still owns the indexed
  // transcript, keep resume NATIVE by rotating to a healthy INJECTABLE (provider)
  // account in that SAME home — rather than dropping to /continue on a different
  // version. Only a provider token/key qualifies: a native login lives in its own
  // isolated home and cannot be forwarded, so it could never authenticate a
  // resume that must read the origin home's transcript (see §11).
  const originReadiness = source ? readinessFromCandidate(source) : null;
  const originLimited = !!originReadiness && !originReadiness.ready
    && (originReadiness.reason === 'rate_limited' || originReadiness.reason === 'out_of_credits');
  if (originLimited && source && supportsNative(agent, source.version)) {
    const inspection = nativeInspection
      ?? inspectNativeResumeSession(session, candidateHome(source));
    if (inspection.available) {
      const rotated = pickBalancedCandidate(
        candidates.filter((c) => c.providerAccount && c.accountKey !== source.accountKey),
      );
      const account = rotated ? recoveryAccountFromCandidate(rotated.picked) : undefined;
      if (account) {
        // `originLimited` guarantees the origin is unhealthy with a limit reason.
        const why = originReadiness!.ready ? 'limited' : originReadiness!.reason;
        return {
          mode: 'native',
          agent,
          version: source.version,
          cwd: inspection.cwd,
          account,
          reason: `origin ${agent}@${source.version} account is ${why}; rotated to healthy ${account.label} and resuming natively in the same home`,
        };
      }
    }
  }

  // An exact healthy origin is deterministic: preserve its isolated home. If
  // native resume is unavailable for that harness, /continue still launches in
  // that same healthy home. Only an unusable/missing origin enters balanced
  // account selection.
  const selection = sourceReady
    ? { picked: source! }
    : pickBalancedCandidate(candidates);
  if (!selection) {
    const detail = formatNoHealthyAccountError(agent, 'balanced', candidates);
    throw new SessionRecoveryError(
      `Cannot recover session ${session.shortId} on ${device}; origin ${agent}@${session.version ?? 'unknown'}. ${detail}`,
    );
  }

  const version = selection.picked.version;
  const account = recoveryAccountFromCandidate(selection.picked);
  const continueWith = account ? `healthy ${account.label}` : `healthy ${agent}@${version}`;
  // Native resume is valid whenever `source` itself was picked (the exact
  // healthy origin, proven by identity/transcript ownership above) — never by
  // re-comparing the recorded session.version label, which a self-updating or
  // aliased install can legitimately no longer match (the origin is still the
  // origin). A balanced pick that is NOT `source` (a different, rotated-to
  // account) must stay on /continue; otherwise we would open a home that never
  // produced this transcript.
  if (sourceReady && supportsNative(agent, version)) {
    const inspection = nativeInspection
      ?? inspectNativeResumeSession(session, candidateHome(source!));
    if (inspection.available) {
      return {
        mode: 'native',
        agent,
        version,
        cwd: inspection.cwd,
        ...(account ? { account } : {}),
        reason: `origin ${agent}@${version} is installed, healthy, and owns the indexed transcript`,
      };
    }
    return {
      mode: 'continue',
      agent,
      version,
      ...(account ? { account } : {}),
      reason: `${inspection.reason}; continuing with ${continueWith}`,
    };
  }

  return {
    mode: 'continue',
    agent,
    version,
    ...(account ? { account } : {}),
    reason: `${sourceReason(session, candidates)}; continuing with ${continueWith}`,
  };
}

/**
 * Resolve recovery for a durable session, reading the live account pool.
 *
 * Uses {@link collectRunCandidatesForRun} (native version-home logins PLUS
 * durable provider accounts, RUSH-3182) rather than the native-only
 * {@link collectRunCandidates}, so an origin-account limit can rotate to a
 * healthy provider account and stay NATIVE (PHNX-3626). `collect` is injectable
 * for tests and for callers that must stay native-only.
 */
export async function resolveSessionRecovery(
  session: SessionMeta,
  collect: (agent: AgentId) => Promise<RotateCandidate[]> = collectRunCandidatesForRun,
): Promise<SessionRecoveryTarget> {
  const agent = runnableSessionAgent(session);
  return resolveSessionRecoveryFromCandidates(session, await collect(agent));
}

/** Stable self-command used by focus, resume, and attach. The owning device runs
 * the recovery resolver above; callers must not native-resume another version's
 * isolated home themselves. */
export function sessionRecoveryRunArgs(session: Pick<SessionMeta, 'id'>): string[] {
  return ['run', 'auto', '--resume', session.id, '--interactive'];
}
