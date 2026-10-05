/** Forward an owner notification to a capable macOS fleet peer over SSH (PHNX-3303), since the
 * rush-backed owner transport is macOS-only. Best-effort: never throws or blocks the post;
 * resolves `undefined` when no peer is reachable so the caller keeps its local error. */
import type { Meta } from '../types.js';
import type { SendResult } from './registry.js';
import type { DeviceProfile } from '../devices/registry.js';
import { loadDevices, isDialableDevice } from '../devices/registry.js';
import { machineId, normalizeHost } from '../machine-id.js';
import { RUSH_CHANNELS } from './providers/rush.js';
import { resolvePeerTarget, sshCapture } from '../session/remote/remote-list.js';
import { buildRemoteAgentsInvocation, stripClixml } from '../hosts/remote-cmd.js';

/** Env marker on the forwarded `agents send` so a receiving box never forwards onward; guards
 * against a future fan-out loop. */
export const OWNER_FORWARD_GUARD_ENV = 'AGENTS_OWNER_NO_FORWARD';

/** Per-peer SSH deadline for a one-shot owner delivery. */
const PEER_SEND_TIMEOUT_MS = 15_000;

/** Why forwarding did not run, so a caller/test can assert the decision. */
type OwnerForwardSkip = 'guarded' | 'not-rush-backed' | 'no-capable-peer';

interface OwnerForwardPlan {
  /** Ordered machine ids to try — capable (macOS), reachable, self excluded. */
  candidates: string[];
  /** Set when forwarding does not apply; the caller keeps its local error. */
  skip?: OwnerForwardSkip;
}

/** True when the owner transport is the macOS-only rush family, the one case a Linux box cannot
 * deliver and a peer can. Mirrors the `RUSH_CHANNELS.includes(transport)` check in owner-sink.ts. */
export function isRushBackedTransport(channel: string, meta: Meta): boolean {
  const transport = meta.notify?.transports?.[channel] ?? channel;
  return (RUSH_CHANNELS as readonly string[]).includes(transport);
}

/** Pick the peers that can deliver the owner notification, in try order. Pure, no I/O.
 * Only macOS peers qualify; the configured `interactive.host` is tried first. */
export function planOwnerForward(
  channel: string,
  meta: Meta,
  devices: DeviceProfile[],
  self: string,
  opts: { guarded?: boolean } = {},
): OwnerForwardPlan {
  if (opts.guarded) return { candidates: [], skip: 'guarded' };
  if (!isRushBackedTransport(channel, meta)) return { candidates: [], skip: 'not-rush-backed' };

  const selfId = normalizeHost(self);
  const capable = devices.filter(
    (d) => d.platform === 'macos' && isDialableDevice(d) && normalizeHost(d.name) !== selfId,
  );

  const interactiveHost = typeof meta.config?.interactiveHost === 'string'
    ? normalizeHost(meta.config.interactiveHost)
    : undefined;
  const rank = (name: string): number => (interactiveHost && normalizeHost(name) === interactiveHost ? 0 : 1);
  const candidates = capable
    .map((d) => normalizeHost(d.name))
    .sort((a, b) => rank(a) - rank(b));

  if (candidates.length === 0) return { candidates: [], skip: 'no-capable-peer' };
  return { candidates };
}

/** Deliver `text` to the owner from one peer over SSH via its own `agents send`. Resolves the
 * parsed `SendResult`, or `undefined` for an unreachable peer or unparseable output (try the next
 * peer). */
interface PeerOwnerEnvelope {
  thread?: string;
  from?: string;
}

type PeerOwnerSender = (
  machine: string,
  text: string,
  channel: string,
  target: string,
  envelope?: PeerOwnerEnvelope,
) => Promise<SendResult | undefined>;

async function sendOnPeer(
  machine: string,
  text: string,
  channel: string,
  target: string,
  envelope: PeerOwnerEnvelope = {},
): Promise<SendResult | undefined> {
  const peer = await resolvePeerTarget(machine);
  if (!peer) return undefined;
  const args = ['send', '--channel', channel, '--to', target, '--text', text, '--json'];
  if (envelope.thread) args.push('--thread', envelope.thread);
  if (envelope.from) args.push('--from', envelope.from);
  // Reuse the injection-tested remote-command builder every `--device` dispatch uses rather than a
  // second quoting path on a security-sensitive seam.
  const remoteCmd = buildRemoteAgentsInvocation(args, undefined, peer.os, { [OWNER_FORWARD_GUARD_ENV]: '1' });
  const capture = await sshCapture(peer.target, remoteCmd, PEER_SEND_TIMEOUT_MS);
  if (capture.code !== 0) return undefined;
  try {
    const parsed = JSON.parse(stripClixml(capture.stdout)) as SendResult;
    if (parsed && typeof parsed === 'object' && typeof parsed.ok === 'boolean') return parsed;
  } catch {
    return undefined;
  }
  return undefined;
}

/** Try each capable peer in order and return the first successful delivery, so the owner's phone
 * rings once. Resolves `undefined` when none delivered. `send` is injectable so the orchestration
 * is testable without a live SSH host. */
export async function forwardOwnerNotifyToPeer(
  text: string,
  channel: string,
  target: string,
  meta: Meta,
  opts: { self?: string; devices?: DeviceProfile[]; send?: PeerOwnerSender; envelope?: PeerOwnerEnvelope } = {},
): Promise<SendResult | undefined> {
  // Cheap, I/O-free gate first: a box that already received a forward, or an
  // owner channel that isn't the macOS-only rush family, can never forward — so
  // a normal local success/failure never pays a device-registry disk read.
  if (process.env[OWNER_FORWARD_GUARD_ENV] === '1') return undefined;
  if (!isRushBackedTransport(channel, meta)) return undefined;

  const self = opts.self ?? machineId();
  let devices = opts.devices;
  if (!devices) {
    try {
      devices = Object.values(await loadDevices());
    } catch {
      return undefined; // no registry, nothing to forward to
    }
  }

  const plan = planOwnerForward(channel, meta, devices, self);
  if (plan.candidates.length === 0) return undefined;

  const send = opts.send ?? sendOnPeer;
  for (const machine of plan.candidates) {
    const result = await send(machine, text, channel, target, opts.envelope);
    if (result?.ok) return result;
  }
  return undefined;
}
