import type { Meta } from '../types.js';
import type { SendResult } from './registry.js';
import type { DeviceProfile } from '../devices/registry.js';
import { loadDevices, isDialableDevice } from '../devices/registry.js';
import { machineId, normalizeHost } from '../machine-id.js';
import { RUSH_CHANNELS } from './providers/rush.js';
import { resolvePeerTarget, sshCapture } from '../session/remote/remote-list.js';
import { buildRemoteAgentsInvocation, stripClixml } from '../hosts/remote-cmd.js';

export const OWNER_FORWARD_GUARD_ENV = 'AGENTS_OWNER_NO_FORWARD';

const PEER_SEND_TIMEOUT_MS = 15_000;

type OwnerForwardSkip = 'guarded' | 'not-rush-backed' | 'no-capable-peer';

interface OwnerForwardPlan {
  candidates: string[];
  skip?: OwnerForwardSkip;
}

export function isRushBackedTransport(channel: string, meta: Meta): boolean {
  const transport = meta.notify?.transports?.[channel] ?? channel;
  return (RUSH_CHANNELS as readonly string[]).includes(transport);
}

export function planOwnerForward(
  channel: string,
  meta: Meta,
  devices: DeviceProfile[],
  self: string,
  opts: { guarded?: boolean } = {},
): OwnerForwardPlan {
  // Only Rush-backed transports need a headed macOS peer; the guard prevents fleet recursion.
  if (opts.guarded) return { candidates: [], skip: 'guarded' };
  if (!isRushBackedTransport(channel, meta)) return { candidates: [], skip: 'not-rush-backed' };

  const selfId = normalizeHost(self);
  const capable = devices.filter(
    (d) => d.platform === 'macos' && isDialableDevice(d) && normalizeHost(d.name) !== selfId,
  );

  const interactiveHost = typeof meta.config?.interactiveHost === 'string'
    ? normalizeHost(meta.config.interactiveHost)
    : undefined;
  // Prefer the configured interactive host, then try other capable peers in stable order.
  const rank = (name: string): number => (interactiveHost && normalizeHost(name) === interactiveHost ? 0 : 1);
  const candidates = capable
    .map((d) => normalizeHost(d.name))
    .sort((a, b) => rank(a) - rank(b));

  if (candidates.length === 0) return { candidates: [], skip: 'no-capable-peer' };
  return { candidates };
}

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
  // Use the shared remote builder for OS quoting and inject the recursion guard remotely.
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

export async function forwardOwnerNotifyToPeer(
  text: string,
  channel: string,
  target: string,
  meta: Meta,
  opts: { self?: string; devices?: DeviceProfile[]; send?: PeerOwnerSender; envelope?: PeerOwnerEnvelope } = {},
): Promise<SendResult | undefined> {
  if (process.env[OWNER_FORWARD_GUARD_ENV] === '1') return undefined;
  if (!isRushBackedTransport(channel, meta)) return undefined;

  const self = opts.self ?? machineId();
  let devices = opts.devices;
  if (!devices) {
    try {
      devices = Object.values(await loadDevices());
    } catch {
      return undefined;
    }
  }

  const plan = planOwnerForward(channel, meta, devices, self);
  if (plan.candidates.length === 0) return undefined;

  const send = opts.send ?? sendOnPeer;
  for (const machine of plan.candidates) {
    const result = await send(machine, text, channel, target, opts.envelope);
    // A successful peer owns delivery; continuing would duplicate the owner notification.
    if (result?.ok) return result;
  }
  return undefined;
}
