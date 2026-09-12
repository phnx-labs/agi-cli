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
 * The account a recovery should authenticate as. Present when resume rotates
 * AWAY from the session's original login (an account limit) to a healthy
 * sibling of the SAME harness. A `providerAccount` is a durable setup-token /
 * API-key account (RUSH-3182) injected via the `--account` spawn path
 * (`resolveSpawnAccount` → `accountEnv`); it is the only kind that can
 * authenticate a NATIVE resume in the origin version home, because a native
 * login lives in its own isolated home and cannot be forwarded. It is also
 * required on `/continue` when the balanced pick is a provider: exec only
 * injects from this field, so omitting it would launch the version home's
 * native login — the exhausted origin in the PHNX-3674 fixture. Absent means
 * "use the launched version home's own native login" (the healthy-origin happy
 * path, or `/continue` on a healthy native sibling).
 */
export interface RecoveryAccount {
  providerAccount: string;
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

function sourceReason(session: SessionMeta, candidates: RotateCandidate[]): string {
  if (!session.version) return 'the origin version was not recorded';
  const source = candidates.find((candidate) => candidate.version === session.version);
  if (!source) return `origin ${session.agent}@${session.version} is not installed`;
  const readiness = readinessFromCandidate(source);
  return readiness.ready
    ? `origin ${session.agent}@${session.version} has no native resume form`
    : `origin ${session.agent}@${session.version} is ${readiness.reason}`;
}

function recoveryAccountFromCandidate(candidate: RotateCandidate): RecoveryAccount | undefined {
  const providerAccount = candidate.providerAccount;
  if (!providerAccount) return undefined;
  return {
    providerAccount,
    label: candidate.accountLabel || providerAccount,
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
  const source = session.version
    ? candidates.find((candidate) => candidate.version === session.version)
    : undefined;
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
  if (originLimited && source && session.version && supportsNative(agent, session.version)) {
    const inspection = nativeInspection
      ?? inspectNativeResumeSession(session, getVersionHomePath(agent, session.version));
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
          version: session.version,
          cwd: inspection.cwd,
          account,
          reason: `origin ${agent}@${session.version} account is ${why}; rotated to healthy ${account.label} and resuming natively in the same home`,
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
  // Native resume without an injected RecoveryAccount is valid only for the
  // exact healthy origin login. A balanced same-version provider selected for
  // a signed-out/revoked origin must stay on /continue; otherwise we would open
  // the origin home with no usable credential and fail (or fork state).
  if (sourceReady && session.version === version && supportsNative(agent, version)) {
    const inspection = nativeInspection
      ?? inspectNativeResumeSession(session, getVersionHomePath(agent, version));
    if (inspection.available) {
      return {
        mode: 'native',
        agent,
        version,
        cwd: inspection.cwd,
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
 * Whether a session has a transcript recovery could read.
 *
 * Only ONE of the ways a transcript can be absent is this device's to judge.
 *
 * - **A path this box cannot see.** A row pulled over the live fan-out
 *   (`parseRemoteList`) carries the PEER's absolute path, which need not exist
 *   here (`/Users/…` vs `/home/…`). `_remote` marks exactly that case.
 * - **A peer's fleet-synced mirror stub.** `upsertMirrorSession`
 *   (`db.ts:4142`) writes `file_path = ''` by design — the row carries the
 *   peer's metadata and preview digest, not its transcript. `mirrorSyncedAt` is
 *   set for precisely these rows and "absent for a genuine local or
 *   host-dispatch row" (PHNX-3792), and it survives the PHNX-3626 fallback,
 *   which rewrites only `machine`. Judging such a row's empty path locally
 *   would refuse the owner-unreachable `/continue` replay this device is
 *   supposed to fall back to.
 * - **No path, no peer behind it.** What is left is a live-registry row:
 *   `activeSessionToSessionMeta` synthesizes `filePath: ''` for a session the
 *   registry calls running (RUSH-2682, deliberately, so `preview` can render a
 *   just-started one) and sets no mirror fields. That is the only shape this
 *   device can honestly call "no transcript" — see
 *   {@link assertRecoverableTranscript}.
 */
export function sessionTranscriptReadable(
  session: Pick<SessionMeta, 'filePath' | '_remote' | 'mirrorSyncedAt'>,
  exists: (file: string) => boolean = (file) => fs.existsSync(file),
): boolean {
  if (session._remote) return true;
  if (!session.filePath) return session.mirrorSyncedAt !== undefined;
  return exists(session.filePath);
}

/**
 * Refuse recovery for a session with no transcript behind it.
 *
 * Both recovery modes read the prior conversation: `native` replays the
 * harness's own state file, and `continue` hands `/continue <id>` to a fresh
 * agent that reads the indexed transcript. With no transcript, `native` is
 * already rejected by {@link inspectNativeResumeSession} — but `continue` was
 * not, so a registry row that never produced a transcript resolved to
 * `mode: 'continue'` and burned a live agent on an id with nothing to read.
 * That agent then does the only thing it can: report that there is nothing to
 * continue. Fail loud here instead, at the boundary that knows why.
 */
export function assertRecoverableTranscript(
  session: SessionMeta,
  exists: (file: string) => boolean = (file) => fs.existsSync(file),
): void {
  if (sessionTranscriptReadable(session, exists)) return;
  const device = sessionOriginDevice(session);
  // Three shapes reach here with no path, and the message has to be true for
  // all of them: a live-registry row that never wrote a transcript, a
  // host-dispatch shim whose peer never answered the sweep, and a cloud task
  // row whose transcript lives in the cloud (`cloud/session-index.ts:57`).
  // "No transcript was written on <device>" holds for each; "registered as
  // live" would only hold for the first.
  const why = session.filePath
    ? `its transcript is gone from ${device} (${session.filePath})`
    : `no transcript for it was ever written on ${device}`;
  throw new SessionRecoveryError(
    `Session ${session.shortId} has nothing to resume — ${why}. `
    + `A recovered agent would open an empty conversation. `
    + `Start a new session instead: agents run ${session.agent}`
    + (session.cwd ? ` --cwd ${session.cwd}` : ''),
  );
}

/**
 * Resolve recovery for a durable session, reading the live account pool.
 *
 * Refuses a session with no transcript up front (see
 * {@link assertRecoverableTranscript}) — neither recovery mode can read one
 * that was never written.
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
  assertRecoverableTranscript(session);
  return resolveSessionRecoveryFromCandidates(session, await collect(agent));
}

/** Stable self-command used by focus, resume, and attach. The owning device runs
 * the recovery resolver above; callers must not native-resume another version's
 * isolated home themselves. */
export function sessionRecoveryRunArgs(session: Pick<SessionMeta, 'id'>): string[] {
  return ['run', 'auto', '--resume', session.id, '--interactive'];
}
