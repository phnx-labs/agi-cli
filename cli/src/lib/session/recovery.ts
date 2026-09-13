import * as fs from 'fs';
import * as path from 'path';
import { AGENTS, agentConfigDirName } from '../agents.js';
import { isSelfHost } from '../devices/self-host.js';
import { nativeResume } from '../exec.js';
import { machineId, normalizeHost } from '../machine-id.js';
import type { UnifiedAccount } from '../account-registry.js';
import { readSlots, slotDir } from '../accounts/slots.js';
import { readMeta } from '../state.js';
import {
  formatNoHealthyAccountError,
  matchAccountCandidate,
  pickBalancedCandidate,
  readinessFromCandidate,
  type RotateCandidate,
} from '../accounting/rotate.js';
import { collectRunCandidatesForRun } from '../accounting/account-pool-collect.js';
import type { AgentId } from '../types.js';
import { getVersionHomePath, resolveManagedInstallation } from '../installations/store.js';
import { readSessionContent } from './db.js';
import { parseOpenCode, splitSessionFilePath } from './parse.js';
import type { SessionAgentId, SessionMeta } from './types.js';

const RESUMABLE_SESSION_AGENTS = new Set<SessionAgentId>(['claude', 'codex', 'muse', 'opencode']);

/** One capability boundary for every surface that advertises faithful Resume. */
export function sessionAgentSupportsResume(agent: SessionAgentId): boolean {
  return RESUMABLE_SESSION_AGENTS.has(agent);
}

/** Injectable credentials can authenticate the existing native context. */
export interface RecoveryAccount {
  providerAccount: string;
  label: string;
  email: string | null;
}

export interface SessionRecoverySelection {
  /** Installed binary only; account homes retain their own context label. */
  executableVersion?: string;
  /** Explicit account selector resolved against the local candidate pool. */
  account?: string;
  /** Effective model for readiness checks. */
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
      configVersion?: string;
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

function sourceReason(session: SessionMeta, source: RotateCandidate | undefined, model?: string): string {
  if (!source) return session.accountId
    ? 'the recorded account is not available on this device'
    : 'the original account attribution is unknown';
  const readiness = readinessFromCandidate(source, undefined, model);
  return readiness.ready ? 'the account has no usable native resume context' : `the original account is ${readiness.reason}`;
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
    realFile = fs.realpathSync(splitSessionFilePath(filePath).container);
  } catch {
    return null;
  }
  const roots = [path.join(homeRoot, agentConfigDirName(agent))];
  if (agent === 'muse' || agent === 'opencode') roots.push(path.join(homeRoot, '.local', 'share', agent));
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

/** History filtering uses login identity, never an organization quota key. */
export function sessionMatchesAccount(
  session: Pick<SessionMeta, 'agent' | 'filePath' | 'accountId'>,
  account: Pick<UnifiedAccount, 'id' | 'kind'> & { agent?: AgentId },
  home?: string,
): boolean {
  if (account.kind === 'native' && session.agent !== account.agent) return false;
  if (session.accountId) return session.accountId === account.id;
  if (account.kind !== 'native') return false;
  const slot = readSlots(readMeta())[account.id];
  const context = home ?? slot?.slotDir ?? slotDir(session.agent as AgentId, account.id);
  return transcriptOwnedByHome(session.filePath, context, session.agent as AgentId);
}

function candidateAccountId(candidate: RotateCandidate): string | undefined {
  return candidate.providerAccountId ?? candidate.nativeAccountId ?? (candidate.fromSlot && candidate.slotDir ? path.basename(candidate.slotDir) : undefined);
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
function candidateOwnsTranscript(candidate: RotateCandidate, session: SessionMeta): boolean {
  if (candidate.providerAccount && !session.accountId) return false;
  const home = candidateHome(candidate);
  const acctId = candidateAccountId(candidate);
  if (session.accountId) return session.accountId === acctId;
  return transcriptOwnedByHome(session.filePath, home, candidate.agent);
}

/** Stored login identity wins; otherwise require actual native context ownership. */
function pickOriginCandidate(session: SessionMeta, candidates: RotateCandidate[]): RotateCandidate | undefined {
  if (session.accountId) return candidates.find(candidate => candidateAccountId(candidate) === session.accountId);
  const native = candidates.filter(candidate => !candidate.providerAccount);
  const owners = native.filter(candidate => candidateOwnsTranscript(candidate, session));
  return owners.length === 1 ? owners[0] : undefined;
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
  session: SessionMeta,
  versionHome: string,
): NativeResumeInspection {
  if (session.agent === 'opencode' && (!fs.existsSync(splitSessionFilePath(session.filePath).container) || parseOpenCode(session.filePath).length === 0)) {
    return { available: false, reason: 'the native database has no readable conversation for this session' };
  }
  const realFile = resolveOwnedTranscriptRealpath(session.filePath, versionHome, session.agent as AgentId);
  if (!realFile) {
    try {
      fs.realpathSync(splitSessionFilePath(session.filePath).container);
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

function resolveExplicitAccountRecovery(
  session: SessionMeta,
  candidates: RotateCandidate[],
  agent: AgentId,
  device: string,
  supportsNative: (agent: AgentId, version?: string) => boolean,
  nativeInspection: NativeResumeInspection | undefined,
  options: SessionRecoverySelection,
): SessionRecoveryTarget {
  const requested = options.account!.trim();
  const matched = matchAccountCandidate(candidates, requested);
  if (!matched) {
    throw new SessionRecoveryError(
      `Cannot recover session ${session.shortId} on ${device} as '${requested}': no signed-in ${agent} account matches that name/email/key.`,
    );
  }
  const readiness = readinessFromCandidate(matched, undefined, options.model ?? session.model);
  if (!readiness.ready) {
    throw new SessionRecoveryError(
      `Cannot recover session ${session.shortId} on ${device} as '${requested}': ${matched.accountLabel} is ${readiness.reason}.`,
    );
  }

  const account = recoveryAccountFromCandidate(matched);
  const modelSuffix = options.model ? ` on model ${options.model}` : '';
  const isOrigin = candidateOwnsTranscript(matched, session);

  if (isOrigin && supportsNative(agent, options.executableVersion ?? matched.version)) {
    const home = candidateHome(matched);
    const inspection = nativeInspection ?? inspectNativeResumeSession(session, home);
    if (inspection.available) {
      return {
        mode: 'native',
        agent,
        version: options.executableVersion ?? matched.version,
        cwd: inspection.cwd,
        execHome: home,
        configVersion: matched.fromSlot ? undefined : matched.version,
        candidate: matched,
        ...(account ? { account } : {}),
        reason: `explicit account '${requested}' is the session origin; resuming natively${modelSuffix}`,
      };
    }
  }

  return {
    mode: 'continue',
    agent,
    version: options.executableVersion ?? matched.version,
    candidate: matched,
    ...(account ? { account } : {}),
    reason: isOrigin
      ? `explicit account '${requested}' is the session origin but has no usable native context; continuing${modelSuffix}`
      : `explicit account '${requested}' differs from the session's recorded origin; continuing on ${matched.accountLabel}${modelSuffix} requires interactive confirmation before replay`,
  };
}

/** Keep the native conversation where possible; replay remains a separate choice. */
export function resolveSessionRecoveryFromCandidates(
  session: SessionMeta,
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

  const source = pickOriginCandidate(session, candidates);
  const sourceReady = source ? readinessFromCandidate(source, undefined, options.model ?? session.model).ready : false;

  // Native-first with account rotation (PHNX-3626). When the origin login is
  // usage/rate/session-LIMITED (not signed-out or revoked — those need a login,
  // not a rotation, so they keep going to /continue per SES-39) but its native
  // context is installed, native-resume-capable, and still owns the indexed
  // transcript, keep resume NATIVE by rotating to a healthy INJECTABLE (provider)
  // account in that SAME context — rather than dropping to /continue on a
  // different version. Only a provider token/key qualifies: a native login
  // lives in its own isolated context and cannot be forwarded, so it could
  // never authenticate a resume that must read the origin's transcript (see §11).
  const originReadiness = source ? readinessFromCandidate(source, undefined, options.model ?? session.model) : null;
  const originLimited = !!originReadiness && !originReadiness.ready
    && (originReadiness.reason === 'rate_limited' || originReadiness.reason === 'out_of_credits' || originReadiness.reason === 'model_limited');
  if (originLimited && source && supportsNative(agent, options.executableVersion ?? source.version)) {
    const originHome = candidateHome(source);
    const inspection = nativeInspection ?? inspectNativeResumeSession(session, originHome);
    if (inspection.available) {
      const rotated = pickBalancedCandidate(
        candidates.filter((c) => c.providerAccount && c.accountKey !== source.accountKey),
        undefined, options.model ?? session.model,
      );
      const account = rotated ? recoveryAccountFromCandidate(rotated.picked) : undefined;
      if (account) {
        // `originLimited` guarantees the origin is unhealthy with a limit reason.
        const why = originReadiness!.ready ? 'limited' : originReadiness!.reason;
        return {
          mode: 'native',
          agent,
          version: options.executableVersion ?? source.version,
          cwd: inspection.cwd,
          execHome: originHome,
          configVersion: source.fromSlot ? undefined : source.version,
          candidate: rotated!.picked,
          account,
          reason: `the original account is ${why}; using ${account.label} in the same native context`,
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
    : pickBalancedCandidate(candidates, undefined, options.model ?? session.model);
  if (!selection) {
    const detail = formatNoHealthyAccountError(agent, 'balanced', candidates);
    throw new SessionRecoveryError(
      `Cannot recover session ${session.shortId} on ${device}; origin ${agent}@${session.version ?? 'unknown'}. ${detail}`,
    );
  }

  const version = options.executableVersion ?? selection.picked.version;
  const account = recoveryAccountFromCandidate(selection.picked);
  const continueWith = account ? `healthy ${account.label}` : `the selected ${agent} account`;
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
        configVersion: selection.picked.fromSlot ? undefined : selection.picked.version,
        candidate: selection.picked,
        reason: `the selected account owns the native transcript and has no known launch restriction`,
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
    reason: `${sourceReason(session, source, options.model ?? session.model)}; continuing with ${continueWith}`,
  };
}

/**
 * Whether recovery has conversation content to replay for this session: a
 * non-empty transcript file, or archived content in the index for a row this
 * device owns. A mirror digest or live registry entry is not conversation
 * content. The picker consults this before spending a terminal tab on a pick
 * that {@link assertRecoverableTranscript} would refuse one hop later.
 */
export function sessionTranscriptReadable(session: SessionMeta): boolean {
  const file = splitSessionFilePath(session.filePath).container;
  try {
    if (file && fs.statSync(file).isFile() && fs.statSync(file).size > 0
      && (session.agent !== 'opencode' || parseOpenCode(session.filePath).length > 0)) return true;
  } catch { /* The canonical scan already tried to repair this path. */ }
  return !session.mirrorSyncedAt && !session.mirrorSource && Boolean(readSessionContent(session.id)?.trim());
}

/** Refuse recovery for a session with nothing to replay (PHNX-4080). */
export function assertRecoverableTranscript(session: SessionMeta): void {
  if (sessionTranscriptReadable(session)) return;
  throw new SessionRecoveryError(
    `Session ${session.shortId} has no readable transcript after checking its account homes and index. ` +
    `No agent was started. Start a new conversation with: agents run ${session.agent}`,
  );
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
  options: SessionRecoverySelection = {},
): Promise<SessionRecoveryTarget> {
  const agent = runnableSessionAgent(session);
  const { hydrateSessionTranscript } = await import('./discover.js');
  session = await hydrateSessionTranscript(session);
  assertRecoverableTranscript(session);
  const installation = resolveManagedInstallation(agent);
  if (!installation) throw new SessionRecoveryError(`No managed ${agent} installation is available. Install it with: agents add ${agent}`);
  return resolveSessionRecoveryFromCandidates(session, await collect(agent), undefined, undefined, {
    ...options, executableVersion: installation.label,
  });
}

/** Stable self-command used by focus, resume, and attach. The owning device runs
 * the recovery resolver above; callers must not native-resume another version's
 * isolated home themselves. */
export function sessionRecoveryRunArgs(session: Pick<SessionMeta, 'id'>): string[] {
  return ['run', 'auto', '--resume', session.id, '--interactive'];
}
