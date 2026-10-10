import { spawn } from 'child_process';
import chalk from 'chalk';
import {
  SSH_OPTS,
  controlOpts,
  assertValidSshTarget,
  shellQuote,
  SSH_CONN_FAILURE_CODE,
  REMOTE_STDOUT_MAX_BYTES,
  RemoteUtf8Accumulator,
} from '../../ssh-exec.js';
import { connectionEndedNotice } from '../../hosts/reconnect.js';
import { sshTargetFor } from '../../devices/connect.js';
import { loadDevices, isDialableDevice, type DeviceProfile } from '../../devices/registry.js';
import { remoteShellFor, buildWindowsAgentsCommand, stripClixml } from '../../hosts/remote-cmd.js';
import { gatherRemoteAgentsJson, type RemoteAgentsJsonParseResult } from '../../remote-agents-json.js';
import { normalizeHost } from '../sync/config.js';
import { NO_FANOUT_ENV } from '../remote-active.js';
import { terminalWidth } from '../../text/width.js';
import { sanitizeForTerminal } from '../../redact.js';
import type { SessionMeta } from '@phnx-labs/sessions-cli/reader';

export function remoteListCommand(forwardedArgs: string[], os?: string): string {
  if (remoteShellFor(os) === 'powershell') {
    return buildWindowsAgentsCommand({
      args: forwardedArgs,
      env: { [NO_FANOUT_ENV]: '1' },
    });
  }
  const inner = [`${NO_FANOUT_ENV}=1`, 'agents', ...forwardedArgs].map((t, i) =>
    i === 0 ? t : shellQuote(t),
  ).join(' ');
  return `bash -lc ${shellQuote(inner)}`;
}

export function parseRemoteList(stdout: string, machine: string): SessionMeta[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripClixml(stdout));
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed.flatMap((value) => value && typeof value === 'object' && !Array.isArray(value)
    ? [{ ...(value as SessionMeta), machine, _remote: true }]
    : []);
}

const SAFE_RESOLVER_KEYS = new Set([
  'id', 'shortId', 'agent', 'origin', 'timestamp', 'lastActivity', 'project',
  'version', 'harness', 'mode', 'label', 'topic', 'machine',
]);

function isSafeResolverRow(value: Record<string, unknown>): boolean {
  if (typeof value.id !== 'string' || typeof value.shortId !== 'string'
    || typeof value.agent !== 'string' || typeof value.timestamp !== 'string') return false;
  return Object.keys(value).every(key => SAFE_RESOLVER_KEYS.has(key));
}

export function parseRemoteListPayload(stdout: string, machine: string, safeResolver = false): {
  items: SessionMeta[];
  valid: boolean;
} {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripClixml(stdout));
  } catch {
    return { items: [], valid: false };
  }
  if (!Array.isArray(parsed)) return { items: [], valid: false };
  const out: SessionMeta[] = [];
  for (const x of parsed) {
    if (!x || typeof x !== 'object' || Array.isArray(x)) return { items: [], valid: false };
    if (safeResolver && !isSafeResolverRow(x as Record<string, unknown>)) {
      return { items: [], valid: false };
    }
    out.push({ ...(x as SessionMeta), machine, _remote: true });
  }
  return { items: out, valid: true };
}

export function sshCapture(
  target: string,
  remoteCmd: string,
  timeoutMs: number,
  options: { multiplex?: boolean; port?: number; hostKeyOpts?: string[] } = {},
): Promise<{ code: number | null; stdout: string }> {
  assertValidSshTarget(target);
  return new Promise((resolve) => {
    const args = [
      ...(options.hostKeyOpts ?? []),
      ...SSH_OPTS,
      ...(options.multiplex === false ? [] : controlOpts()),
      ...(options.port === undefined ? [] : ['-p', String(options.port)]),
      target,
      remoteCmd,
    ];
    const child = spawn('ssh', args, { stdio: ['ignore', 'pipe', 'ignore'] });
    const decoded = new RemoteUtf8Accumulator();
    let stdoutBytes = 0;
    let settled = false;
    const done = (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const stdout = code === null ? decoded.current() : decoded.end();
      resolve({ code, stdout });
    };
    const timer = setTimeout(() => { child.kill('SIGKILL'); done(null); }, timeoutMs);
    child.stdout.on('data', (d: Buffer) => {
      if (stdoutBytes + d.byteLength > REMOTE_STDOUT_MAX_BYTES) {
        child.kill('SIGKILL');
        done(null);
        return;
      }
      stdoutBytes += d.byteLength;
      decoded.write(d);
    });
    child.on('error', () => done(null));
    child.on('close', (code) => done(code));
  });
}

interface RemoteListResult {
  sessions: SessionMeta[];
  deviceCount: number;
  unreachable: string[];
}

export function isAutomaticSessionPeer(d: DeviceProfile, self: string): boolean {
  if (!isDialableDevice(d)) return false;
  if (normalizeHost(d.name) === self) return false;
  return d.platform === 'windows' || d.platform === 'linux' || d.platform === 'macos';
}

interface GatherRemoteListOptions {
  isDefinitive?: (session: SessionMeta, machine: string) => boolean;
  timeoutMs?: number;
}

export async function gatherRemoteList(
  forwardedArgs: string[],
  hosts?: string[],
  opts?: GatherRemoteListOptions,
): Promise<RemoteListResult> {
  const safeResolver = forwardedArgs.includes('--resolve-safe-v1');
  const result = await gatherRemoteAgentsJson<SessionMeta>({
    args: forwardedArgs,
    noFanoutEnv: NO_FANOUT_ENV,
    hosts,
    timeoutMs: opts?.timeoutMs,
    earlyExit: opts?.isDefinitive ? { isDefinitive: opts.isDefinitive } : undefined,
    parse: (stdout, machine): RemoteAgentsJsonParseResult<SessionMeta> =>
      parseRemoteListPayload(stdout, machine, safeResolver),
  });
  return {
    sessions: result.items,
    deviceCount: result.deviceCount,
    unreachable: [
      ...(result.discoveryFailed ? ['device registry'] : []),
      ...result.skipped,
      ...result.parseFailed,
    ],
  };
}

export async function resolvePeerTarget(machine: string): Promise<{ target: string; os?: string } | undefined> {
  let reg: Record<string, DeviceProfile>;
  try {
    reg = await loadDevices();
  } catch {
    return undefined;
  }
  for (const d of Object.values(reg)) {
    if (normalizeHost(d.name) !== machine) continue;
    try {
      return { target: sshTargetFor(d), os: d.platform };
    } catch {
      return undefined;
    }
  }
  return undefined;
}

const PEER_PREVIEW_TIMEOUT_MS = 15_000;

export async function fetchPeerPreviewDigest(
  sessionId: string,
  machine: string,
  timeoutMs = PEER_PREVIEW_TIMEOUT_MS,
): Promise<unknown | undefined> {
  const envelope = await fetchPeerPreviewEnvelope(sessionId, machine, timeoutMs);
  if (!envelope.ok) return undefined;
  return parsePeerPreviewDigest(envelope.envelope);
}

export type PeerPreviewEnvelopeResult =
  | { ok: true; envelope: unknown }
  | { ok: false; reason: 'no-target' | 'unreachable' | 'invalid-json' };

export async function fetchPeerPreviewEnvelope(
  sessionId: string,
  machine: string,
  timeoutMs = PEER_PREVIEW_TIMEOUT_MS,
): Promise<PeerPreviewEnvelopeResult> {
  const peer = await resolvePeerTarget(machine);
  if (!peer) return { ok: false, reason: 'no-target' };
  const cmd = remoteListCommand(['sessions', 'preview', sessionId, '--local', '--json'], peer.os);
  const capture = await sshCapture(peer.target, cmd, timeoutMs);
  if (capture.code !== 0) return { ok: false, reason: 'unreachable' };
  try {
    return { ok: true, envelope: JSON.parse(stripClixml(capture.stdout)) };
  } catch {
    return { ok: false, reason: 'invalid-json' };
  }
}

export function parsePeerPreviewDigest(parsed: unknown): unknown | undefined {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
  const preview = (parsed as { preview?: unknown }).preview;
  if (!preview || typeof preview !== 'object' || Array.isArray(preview)) return undefined;
  return preview;
}

export function peerHopOutcome(code: number | null): 'ok' | 'unreachable' {
  return code === SSH_CONN_FAILURE_CODE || code === null ? 'unreachable' : 'ok';
}

export function peerHopCloseNotice(
  opts: { tty?: boolean; sessionId?: string },
  machine: string,
  code: number | null,
): string | undefined {
  if (!opts.tty || !opts.sessionId) return undefined;
  return connectionEndedNotice(
    { kind: 'session', id: opts.sessionId },
    machine,
    { dropped: code === SSH_CONN_FAILURE_CODE },
  );
}


export async function runOnPeer(
  args: string[],
  machine: string,
  opts: { tty?: boolean; env?: Record<string, string>; sessionId?: string } = {},
): Promise<'ok' | 'no-target' | 'unreachable'> {
  const peer = await resolvePeerTarget(machine);
  if (!peer) return 'no-target';
  assertValidSshTarget(peer.target);

  const cols = terminalWidth();
  const env: Record<string, string> = { ...(cols > 0 ? { COLUMNS: String(cols) } : {}), ...opts.env };
  const assignments = Object.entries(env).map(([k, v]) => `${k}=${shellQuote(v)}`);
  const invocation = assignments.concat(['agents', ...args].map(shellQuote)).join(' ');
  const remoteCmd = remoteShellFor(peer.os) === 'powershell'
    ? buildWindowsAgentsCommand({ args, env: assignments.length ? env : undefined, remapExit255: true })
    : `bash -lc ${shellQuote(`${invocation}; agents_rc=$?; if [ "$agents_rc" -eq 255 ]; then exit 254; fi; exit "$agents_rc"`)}`;

  const sshArgs = [...SSH_OPTS, ...controlOpts()];
  if (opts.tty) sshArgs.push('-tt');
  sshArgs.push(peer.target, remoteCmd);

  return new Promise((resolve) => {
    const child = spawn('ssh', sshArgs, { stdio: 'inherit' });
    child.on('error', (err: any) => {
      process.stderr.write(chalk.red(`Failed to reach ${machine}: ${err?.message ?? 'ssh failed to launch'}\n`));
      resolve('unreachable');
    });
    child.on('close', (code) => {
      const notice = peerHopCloseNotice(opts, machine, code);
      if (notice) process.stderr.write(notice);
      resolve(peerHopOutcome(code));
    });
  });
}

export function hostToken(h: string): string {
  return normalizeHost(h.split('@').pop() || h);
}

export function shouldIncludeLocal(hosts: string[] | undefined, self: string): boolean {
  if (!hosts || hosts.length === 0) return true;
  return hosts.some(h => hostToken(h) === self);
}

export function remoteHostsToDial(hosts: string[] | undefined, self: string): string[] | undefined {
  if (!hosts || hosts.length === 0) return undefined;
  return hosts.filter(h => hostToken(h) !== self);
}
