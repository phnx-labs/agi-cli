/**
 * Forward an owner notification to a capable fleet peer over SSH (PHNX-3303).
 *
 * The owner's delivery provider for the rush-backed channels (imessage /
 * telegram / slack / discord via the `rush` CLI) is macOS-only and
 * keychain-bound, so a headless Linux worker structurally CANNOT ring the
 * owner's phone: `agents feed post --level important` records the post but the
 * owner sink fails with `rush CLI not found on PATH`, and the important post
 * reaches nobody. `probeOwnerSink` (owner-sink.ts) already reports this as the
 * `owner-sink-unreachable` doctor finding; this module is the runtime answer to
 * it — instead of stranding the failure, hand the delivery to a reachable macOS
 * peer that DOES have the provider.
 *
 * This mirrors the SSH reroute `agents message` (decideHostTaskRoute →
 * runOnPeer) and the sessions fan-out already use for work that lives on another
 * box: pick a reachable peer from the device registry and run the same `agents`
 * verb there. Here the verb is `agents send --channel <channel> --to <target>`.
 * Keeping the destination explicit and delivering through the peer's local rush
 * destination explicit prevents a multi-channel owner policy from expanding a
 * second time on the peer and duplicating already-successful channels.
 *
 * Best-effort seam: it never throws and never blocks the post. When no capable
 * peer is reachable it resolves `undefined` and the caller keeps its original
 * clean local error, exactly as before.
 */
import type { Meta } from '../types.js';
import type { SendResult } from './registry.js';
import type { DeviceProfile } from '../devices/registry.js';
import { loadDevices, isDialableDevice } from '../devices/registry.js';
import { machineId, normalizeHost } from '../machine-id.js';
import { RUSH_CHANNELS } from './providers/rush.js';
import { resolvePeerTarget, sshCapture } from '../session/remote/remote-list.js';
import { buildRemoteAgentsInvocation, stripClixml } from '../hosts/remote-cmd.js';

/**
 * Env marker set on the forwarded `agents send` so a box that received a
 * forwarded owner notify never forwards it onward. `agents send` does not route
 * through this module today, so this is defense-in-depth against a future
 * consumer wiring forwarding into the send path and creating a fan-out loop.
 */
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

/**
 * True when the resolved owner transport is the macOS-only rush family — the
 * one case a Linux/headless box structurally cannot deliver and a peer can.
 * `openclaw-telegram` and the local `desktop`/`mailbox` providers are NOT
 * rush-backed, so a failure there is not a wrong-OS problem and is left as-is.
 * Mirrors the same `RUSH_CHANNELS.includes(transport)` gate in owner-sink.ts.
 */
export function isRushBackedTransport(channel: string, meta: Meta): boolean {
  const transport = meta.notify?.transports?.[channel] ?? channel;
  return (RUSH_CHANNELS as readonly string[]).includes(transport);
}

/**
 * Decide which peers can deliver the owner notification, in try order. Pure —
 * no I/O — so the channel gate, the recursion guard, self-exclusion, and the
 * capability/ordering rules are unit-testable without a live tailnet.
 *
 * Only macOS peers are candidates: the rush owner transport is macOS-only, so a
 * Linux/Windows peer could not deliver it either. The configured
 * `interactive.host` (the box the operator sits at, where rush is signed in) is
 * tried first when it is among the candidates.
 */
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

/**
 * Deliver `text` to the owner FROM one peer over SSH. Runs the peer's own
 * `agents send --channel <channel> --to <target> --text <text> --json`, which
 * delivers the already-resolved destination through its local provider.
 * Resolves the parsed `SendResult`, or `undefined` when the peer is
 * unreachable / not a dialable device / answered with unparseable output —
 * every one of which means "try the next peer".
 */
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
  // Reuse the one injection-tested remote-command builder every `--device`
  // dispatch uses (posix `bash -lc` / Windows `-EncodedCommand`), rather than a
  // second hand-rolled quoting path on a security-sensitive seam. The env map is
  // the loop guard, exported the same way every remote invocation exports env.
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

/**
 * Try each capable peer in order and return the first successful delivery. A
 * peer that is unreachable or reports its own delivery failure is skipped and
 * the next is tried; the first `ok:true` wins and stops the sweep so the owner's
 * phone rings once. Resolves `undefined` when forwarding does not apply or no
 * peer delivered — the caller then keeps its original local error.
 *
 * The transport (`send`) is injectable so the try-order / first-success / stop
 * orchestration is testable without a live SSH host; the default runs the real
 * explicit-destination `agents send` over SSH.
 */
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
