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
import { parseOpenCode, splitSessionFilePath } from '@phnx-labs/sessions-cli/reader';
import type { SessionAgentId, SessionMeta } from '@phnx-labs/sessions-cli/reader';

const RESUMABLE_SESSION_AGENTS = new Set<SessionAgentId>(['claude', 'codex', 'muse', 'opencode']);

export function sessionAgentSupportsResume(agent: SessionAgentId): boolean {
  return RESUMABLE_SESSION_AGENTS.has(agent);
}

export interface RecoveryAccount {
  providerAccount: string;
  label: string;
  email: string | null;
}

interface SessionRecoverySelection {
  executableVersion?: string;
  account?: string;
  model?: string;
}

export type SessionRecoveryTarget =
  | {
      mode: 'native';
      agent: AgentId;
      version: string;
      cwd?: string;
      execHome?: string;
      configVersion?: string;
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

type NativeResumeInspection =
  | { available: true; cwd?: string }
  | { available: false; reason: string };

export class SessionRecoveryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SessionRecoveryError';
  }
}

export function sessionOriginDevice(
  session: Pick<SessionMeta, 'machine'>,
  self = machineId(),
): string {
  return normalizeHost(session.machine ?? self);
}

export function sessionRecoveryPeer(
  session: Pick<SessionMeta, 'machine'>,
  selfCheck: (host: string) => boolean = isSelfHost,
): string | undefined {
  if (!session.machine || selfCheck(session.machine)) return undefined;
  return normalizeHost(session.machine);
}

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

function candidateHome(candidate: RotateCandidate): string {
  return candidate.slotDir || getVersionHomePath(candidate.agent, candidate.version);
}

function candidateOwnsTranscript(candidate: RotateCandidate, session: SessionMeta): boolean {

  if (candidate.providerAccount && !session.accountId) return false;
  const home = candidateHome(candidate);
  const acctId = candidateAccountId(candidate);
  if (session.accountId) return session.accountId === acctId;
  return transcriptOwnedByHome(session.filePath, home, candidate.agent);
}

function pickOriginCandidate(session: SessionMeta, candidates: RotateCandidate[]): RotateCandidate | undefined {
  if (session.accountId) return candidates.find(candidate => candidateAccountId(candidate) === session.accountId);
  const native = candidates.filter(candidate => !candidate.providerAccount);
  const owners = native.filter(candidate => candidateOwnsTranscript(candidate, session));
  return owners.length === 1 ? owners[0] : undefined;
}

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
      }
    }
  } finally {
    fs.closeSync(fd);
  }
  return undefined;
}

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

export function sessionTranscriptReadable(session: SessionMeta): boolean {
  const file = splitSessionFilePath(session.filePath).container;
  try {
    if (file && fs.statSync(file).isFile() && fs.statSync(file).size > 0
      && (session.agent !== 'opencode' || parseOpenCode(session.filePath).length > 0)) return true;
  } catch {  }
  return !session.mirrorSyncedAt && !session.mirrorSource && Boolean(readSessionContent(session.id)?.trim());
}

export function assertRecoverableTranscript(session: SessionMeta): void {
  if (sessionTranscriptReadable(session)) return;
  throw new SessionRecoveryError(
    `Session ${session.shortId} has no readable transcript after checking its account homes and index. ` +
    `No agent was started. Start a new conversation with: agents run ${session.agent}`,
  );
}

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

export function sessionRecoveryRunArgs(session: Pick<SessionMeta, 'id'>): string[] {
  return ['run', 'auto', '--resume', session.id, '--interactive'];
}
