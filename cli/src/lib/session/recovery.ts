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
import type { SessionAgentId, SessionMeta } from './types.js';

const RESUMABLE_SESSION_AGENTS = new Set<SessionAgentId>(['claude', 'codex', 'muse', 'opencode']);

/** One capability boundary for every surface that advertises faithful Resume. */
export function sessionAgentSupportsResume(agent: SessionAgentId): boolean {
  return RESUMABLE_SESSION_AGENTS.has(agent);
}

/** Target-local account selection forwarded through the normal run resolver. */
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

function originCandidate(session: SessionMeta, candidates: RotateCandidate[]): RotateCandidate | undefined {
  if (session.accountKey) return candidates.find((candidate) => candidate.accountKey === session.accountKey);
  // Legacy transcripts can prove ownership by location, never by a binary label.
  return candidates.find((candidate) => candidate.slotDir && inspectNativeResumeSession(session, candidate.slotDir).available);
}

function sourceReason(session: SessionMeta, candidates: RotateCandidate[]): string {
  const source = originCandidate(session, candidates);
  if (!source) return 'the origin account is not available on this device';
  const readiness = readinessFromCandidate(source);
  return readiness.ready
    ? `origin ${session.agent}@${session.version} has no native resume form`
    : `origin ${session.agent}@${session.version} is ${readiness.reason}`;
}

function recoveryAccountFromCandidate(candidate: RotateCandidate): RecoveryAccount | undefined {
  const providerAccount = candidate.providerAccount;
  const selector = candidate.nativeAccount ?? providerAccount;
  if (!selector) return undefined;
  return {
    selector,
    ...(providerAccount ? { providerAccount } : { nativeAccount: selector }),
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

/** Resume only in the healthy origin account slot that owns the transcript.
 * A different account uses /continue so credentials and history stay isolated. */
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
  if (sourceReady && source?.slotDir && supportsNative(agent, version)) {
    const inspection = nativeInspection
      ?? inspectNativeResumeSession(session, source.slotDir);
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

/** Resolve recovery against the same provider-inclusive pool used by run. */
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
