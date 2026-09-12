import * as fs from 'fs';
import * as path from 'path';
import { AGENTS, agentConfigDirName } from '../agents.js';
import { isSelfHost } from '../devices/self-host.js';
import { nativeResume } from '../exec.js';
import { machineId, normalizeHost } from '../machine-id.js';
import type { NativeAccount } from '../account-registry.js';
import {
  formatNoHealthyAccountError,
  matchAccountCandidate,
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
 * A {@link SessionMeta} widened with the optional persisted account identity
 * (PHNX-3940 T6): the SessionStart sidecar's `accountId`, which root is
 * adding to `SessionMeta` proper. Declared locally rather than editing
 * `types.ts` (owned by root) — structurally compatible with both a plain
 * `SessionMeta` today and the real field once it lands there.
 */
export type SessionWithAccountId = SessionMeta & { accountId?: string };

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

/**
 * Optional explicit constraints on how a session should recover (PHNX-3940).
 * Absent means "let the resolver pick" (the existing native-first/balanced
 * behavior below).
 */
export interface SessionRecoverySelection {
  /**
   * Constrain recovery to one account — a native slot name, provider account
   * name, login email, or `accountKey`, matched via
   * {@link matchAccountCandidate}. When the matched account is NOT the
   * proven owner of the session's transcript, recovery stays on `/continue`
   * with an honest reason naming the switch — it never silently native-
   * resumes under a different identity than the one that produced the
   * transcript. Callers that want to replay under the new account anyway are
   * expected to get explicit interactive confirmation first; this resolver
   * never does that implicitly.
   */
  account?: string;
  /**
   * Constrain recovery to one model. Recorded on the target as a pass-
   * through so the caller (`lib/exec`, which owns model-limit refusal
   * persistence) can honor it; this resolver has no per-model quota data to
   * validate against.
   */
  model?: string;
}

export type SessionRecoveryTarget =
  | {
      mode: 'native';
      agent: AgentId;
      version: string;
      cwd?: string;
      /** The actual native context root used (a version home, or an account slot dir). */
      execHome?: string;
      /** The exact account/version candidate recovery resolved to — never re-derive from `version` alone (PHNX-3940: several accounts can share one managed binary). */
      candidate: RotateCandidate;
      account?: RecoveryAccount;
      reason: string;
    }
  | {
      mode: 'continue';
      agent: AgentId;
      version: string;
      candidate: RotateCandidate;
      account?: RecoveryAccount;
      reason: string;
    };

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

function runnableSessionAgent(session: Pick<SessionMeta, 'shortId' | 'agent'>): AgentId {
  if (!(session.agent in AGENTS)) {
    throw new SessionRecoveryError(
      `Session ${session.shortId} belongs to ${session.agent}, which is indexed but cannot be launched by agents run.`,
    );
  }
  return session.agent as AgentId;
}

function sourceReason(
  session: SessionWithAccountId,
  source: RotateCandidate | undefined,
  sameVersionCount: number,
): string {
  if (!session.version) return 'the origin version was not recorded';
  if (source) {
    const readiness = readinessFromCandidate(source);
    return readiness.ready
      ? `origin ${session.agent}@${source.version} has no native resume form`
      : `origin ${session.agent}@${source.version} is ${readiness.reason}`;
  }
  if (sameVersionCount > 1) {
    return `origin ${session.agent}@${session.version} is installed under ${sameVersionCount} accounts and the session does not identify which one; attribution is unknown`;
  }
  return `origin ${session.agent}@${session.version} is not installed`;
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

/**
 * Realpath of `filePath` when it is genuinely reachable from `homeRoot` (or
 * that root's agent config subdir), else `null`. The one place transcript
 * ownership is decided — reused by native-resume inspection, account
 * attribution, and disambiguation between several accounts sharing one
 * managed binary. Retained trash/backup transcripts are intentionally
 * rejected: they remain readable by `/continue`, but a home must not claim to
 * natively own a transcript it does not.
 */
function resolveOwnedTranscriptRealpath(filePath: string, homeRoot: string, agent: AgentId): string | null {
  let realFile: string;
  try {
    realFile = fs.realpathSync(filePath);
  } catch {
    return null;
  }
  const roots = [homeRoot, path.join(homeRoot, agentConfigDirName(agent))];
  const owned = roots.some((root) => {
    try {
      return isPathInside(realFile, fs.realpathSync(root));
    } catch {
      return false;
    }
  });
  return owned ? realFile : null;
}

function transcriptOwnedByHome(filePath: string, homeRoot: string, agent: AgentId): boolean {
  return resolveOwnedTranscriptRealpath(filePath, homeRoot, agent) !== null;
}

/**
 * Whether `session` was produced by `account`, the one precise predicate for
 * "is this the right identity" — used both here (disambiguating several
 * accounts that share one managed binary/version) and by the picker /
 * explicit `--account` source constraint. Two proofs, in order:
 *
 *  1. The persisted sidecar `accountId` (PHNX-3940 T6) — a stable identity
 *     recorded at launch, correct even after a vendor auto-update relabels
 *     the installed binary out from under the recorded version.
 *  2. Canonical transcript ownership: the session's real (symlink-resolved)
 *     file lives under `home`, the account's own context root.
 *
 * Deliberately NOT a proof: the org-scoped `accountKey` (`claude:org=<uuid>`)
 * alone, and "whichever credential is currently active in an old home" — both
 * can misattribute across accounts that share an org or a reused home.
 */
export function sessionMatchesAccount(
  session: Pick<SessionMeta, 'agent' | 'filePath'> & { accountId?: string },
  account: Pick<NativeAccount, 'id' | 'agent'>,
  home?: string,
): boolean {
  if (session.agent !== account.agent) return false;
  if (session.accountId) return session.accountId === account.id;
  if (!home) return false;
  return transcriptOwnedByHome(session.filePath, home, session.agent as AgentId);
}

/** The account id a slot-backed candidate belongs to (its slot dir's own name — see `accounts/slots.ts` `slotDir()`). Undefined for a legacy version-home candidate, which has no separate account identity from its version. */
function candidateAccountId(candidate: RotateCandidate): string | undefined {
  if (!candidate.fromSlot || !candidate.slotDir) return undefined;
  return path.basename(candidate.slotDir);
}

/** The actual native context root for a candidate: its account slot dir when it has one, else the managed version home. */
function candidateHome(candidate: RotateCandidate): string {
  return candidate.slotDir || getVersionHomePath(candidate.agent, candidate.version);
}

/**
 * Whether `candidate` is the proven native owner of `session`'s transcript.
 * A provider (injected credential) candidate never qualifies: it has no
 * isolated context of its own, so a transcript sitting in the version home it
 * happens to ride in is not evidence it produced that transcript (the exact
 * "current credentials in an old home as historical proof" mistake this must
 * not repeat).
 */
function candidateOwnsTranscript(candidate: RotateCandidate, session: SessionWithAccountId): boolean {
  if (candidate.providerAccount) return false;
  const home = candidateHome(candidate);
  const acctId = candidateAccountId(candidate);
  if (acctId) return sessionMatchesAccount(session, { id: acctId, agent: candidate.agent }, home);
  return transcriptOwnedByHome(session.filePath, home, candidate.agent);
}

/**
 * Resolve the exact candidate that produced `session`, across every
 * installed account/version — not just a version-label match, since several
 * accounts can share one managed binary (PHNX-3940) and a vendor auto-update
 * can relabel the binary a recorded version once pointed at. Order:
 *
 *  1. A sidecar `accountId` match, any version — survives a relabel.
 *  2. The lone same-version candidate, when there is only one.
 *  3. Among several same-version candidates, the one that provably owns the
 *     transcript (native context ownership).
 *
 * Returns `undefined` when attribution is genuinely ambiguous — several
 * accounts share the version and none can be proven — rather than guessing;
 * the caller falls back to balanced selection and an honest reason.
 */
function pickOriginCandidate(session: SessionWithAccountId, candidates: RotateCandidate[]): RotateCandidate | undefined {
  const nonProvider = candidates.filter((c) => !c.providerAccount);
  if (session.accountId) {
    const byId = nonProvider.find((c) => candidateAccountId(c) === session.accountId);
    if (byId) return byId;
  }
  if (!session.version) return undefined;
  const sameVersion = nonProvider.filter((c) => c.version === session.version);
  if (sameVersion.length <= 1) return sameVersion[0];
  const owned = sameVersion.filter((c) => candidateOwnsTranscript(c, session));
  return owned.length === 1 ? owned[0] : undefined;
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
 * Prove that the indexed transcript is reachable from the exact active
 * native context root that would receive native resume (a version home, or
 * an account slot dir). Retained trash/backup transcripts are intentionally
 * rejected here: they remain readable by `/continue`, but a new installation
 * or account slot must not native-resume an empty isolated home.
 */
export function inspectNativeResumeSession(
  session: SessionWithAccountId,
  versionHome: string,
): NativeResumeInspection {
  const realFile = resolveOwnedTranscriptRealpath(session.filePath, versionHome, session.agent as AgentId);
  if (!realFile) {
    try {
      fs.realpathSync(session.filePath);
    } catch {
      return { available: false, reason: 'the indexed transcript is no longer present in the origin home' };
    }
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
 * Resolve recovery when the caller (root) or the user explicitly names the
 * account to resume as. The requested account MUST be a signed-in, healthy
 * candidate of this session's harness (`matchAccountCandidate`), and it
 * native-resumes ONLY when it is the proven origin of this session's
 * transcript ({@link candidateOwnsTranscript}). Switching to a different
 * account than the one that produced the transcript always stays on
 * `/continue`, with an honest reason — this resolver never implicitly
 * replays a transcript under a new identity; that requires the caller to get
 * explicit interactive confirmation first (PHNX-3940).
 */
function resolveExplicitAccountRecovery(
  session: SessionWithAccountId,
  candidates: RotateCandidate[],
  agent: AgentId,
  device: string,
  supportsNative: (agent: AgentId, version?: string) => boolean,
  nativeInspection: NativeResumeInspection | undefined,
  options: SessionRecoverySelection,
): SessionRecoveryTarget {
  const requested = options.account!.trim();
  const matched = matchAccountCandidate(candidates, requested, session.version);
  if (!matched) {
    throw new SessionRecoveryError(
      `Cannot recover session ${session.shortId} on ${device} as '${requested}': no signed-in ${agent} account matches that name/email/key.`,
    );
  }
  const readiness = readinessFromCandidate(matched);
  if (!readiness.ready) {
    throw new SessionRecoveryError(
      `Cannot recover session ${session.shortId} on ${device} as '${requested}': ${matched.accountLabel} is ${readiness.reason}.`,
    );
  }

  const account = recoveryAccountFromCandidate(matched);
  const modelSuffix = options.model ? ` on model ${options.model}` : '';
  const isOrigin = candidateOwnsTranscript(matched, session);

  if (isOrigin && supportsNative(agent, matched.version)) {
    const home = candidateHome(matched);
    const inspection = nativeInspection ?? inspectNativeResumeSession(session, home);
    if (inspection.available) {
      return {
        mode: 'native',
        agent,
        version: matched.version,
        cwd: inspection.cwd,
        execHome: home,
        candidate: matched,
        ...(account ? { account } : {}),
        reason: `explicit account '${requested}' is the session origin; resuming natively${modelSuffix}`,
      };
    }
  }

  return {
    mode: 'continue',
    agent,
    version: matched.version,
    candidate: matched,
    ...(account ? { account } : {}),
    reason: isOrigin
      ? `explicit account '${requested}' is the session origin but has no usable native context; continuing${modelSuffix}`
      : `explicit account '${requested}' differs from the session's recorded origin; continuing on ${matched.accountLabel}${modelSuffix} requires interactive confirmation before replay`,
  };
}

/**
 * Decide how a durable session resumes on the device that owns it.
 *
 * Native resume is legal only in the exact origin account's isolated context,
 * and only while that context owns the indexed transcript AND some injectable
 * credential for this harness is healthy: the origin login itself, or a
 * provider account rotated in when the origin is usage-limited (PHNX-3626).
 * Every other successful path stays on the same harness and uses `/continue`,
 * whose indexed transcript reader can reach retained version trash. A
 * `/continue` pick of a provider account carries RecoveryAccount so exec
 * injects it instead of launching the version home's native login
 * (PHNX-3674). No healthy same-harness account is a loud failure.
 *
 * `options.account` pins recovery to one explicit account — see
 * {@link resolveExplicitAccountRecovery}. Absent, the resolver disambiguates
 * the true origin itself via {@link pickOriginCandidate}: several accounts
 * can share one managed binary/version, so an exact `version` match alone is
 * not proof of origin.
 */
export function resolveSessionRecoveryFromCandidates(
  session: SessionWithAccountId,
  candidates: RotateCandidate[],
  supportsNative: (agent: AgentId, version?: string) => boolean = nativeResume,
  nativeInspection?: NativeResumeInspection,
  options: SessionRecoverySelection = {},
): SessionRecoveryTarget {
  const agent = runnableSessionAgent(session);
  const device = sessionOriginDevice(session);

  if (options.account) {
    return resolveExplicitAccountRecovery(session, candidates, agent, device, supportsNative, nativeInspection, options);
  }

  const sameVersionCount = session.version
    ? candidates.filter((c) => !c.providerAccount && c.version === session.version).length
    : 0;
  const source = pickOriginCandidate(session, candidates);
  const sourceReady = source ? readinessFromCandidate(source).ready : false;

  // Native-first with account rotation (PHNX-3626). When the origin login is
  // usage/rate/session-LIMITED (not signed-out or revoked — those need a login,
  // not a rotation, so they keep going to /continue per SES-39) but its native
  // context is installed, native-resume-capable, and still owns the indexed
  // transcript, keep resume NATIVE by rotating to a healthy INJECTABLE (provider)
  // account in that SAME context — rather than dropping to /continue on a
  // different version. Only a provider token/key qualifies: a native login
  // lives in its own isolated context and cannot be forwarded, so it could
  // never authenticate a resume that must read the origin's transcript (see §11).
  const originReadiness = source ? readinessFromCandidate(source) : null;
  const originLimited = !!originReadiness && !originReadiness.ready
    && (originReadiness.reason === 'rate_limited' || originReadiness.reason === 'out_of_credits');
  if (originLimited && source && supportsNative(agent, source.version)) {
    const originHome = candidateHome(source);
    const inspection = nativeInspection ?? inspectNativeResumeSession(session, originHome);
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
          execHome: originHome,
          candidate: rotated!.picked,
          account,
          reason: `origin ${agent}@${source.version} account is ${why}; rotated to healthy ${account.label} and resuming natively in the same context`,
        };
      }
    }
  }

  // An exact healthy origin is deterministic: preserve its isolated context.
  // If native resume is unavailable for that harness, /continue still
  // launches there. Only an unusable/missing/ambiguous origin enters balanced
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
  // exact healthy origin login — when sourceReady, `selection.picked` IS
  // `source` by construction above, so no separate version comparison is
  // needed (and none would be safe: an accountId-matched origin can carry a
  // version different from the session's recorded one after a vendor
  // relabel). A balanced same-version provider selected for a signed-out/
  // revoked origin must stay on /continue; otherwise we would open the origin
  // context with no usable credential and fail (or fork state).
  if (sourceReady && supportsNative(agent, version)) {
    const home = candidateHome(selection.picked);
    const inspection = nativeInspection ?? inspectNativeResumeSession(session, home);
    if (inspection.available) {
      return {
        mode: 'native',
        agent,
        version,
        cwd: inspection.cwd,
        execHome: home,
        candidate: selection.picked,
        reason: `origin ${agent}@${version} is installed, healthy, and owns the indexed transcript`,
      };
    }
    return {
      mode: 'continue',
      agent,
      version,
      candidate: selection.picked,
      ...(account ? { account } : {}),
      reason: `${inspection.reason}; continuing with ${continueWith}`,
    };
  }

  return {
    mode: 'continue',
    agent,
    version,
    candidate: selection.picked,
    ...(account ? { account } : {}),
    reason: `${sourceReason(session, source, sameVersionCount)}; continuing with ${continueWith}`,
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
  session: SessionWithAccountId,
  collect: (agent: AgentId) => Promise<RotateCandidate[]> = collectRunCandidatesForRun,
  options: SessionRecoverySelection = {},
): Promise<SessionRecoveryTarget> {
  const agent = runnableSessionAgent(session);
  return resolveSessionRecoveryFromCandidates(session, await collect(agent), undefined, undefined, options);
}

/** Stable self-command used by focus, resume, and attach. The owning device runs
 * the recovery resolver above; callers must not native-resume another version's
 * isolated home themselves. */
export function sessionRecoveryRunArgs(session: Pick<SessionMeta, 'id'>): string[] {
  return ['run', 'auto', '--resume', session.id, '--interactive'];
}
