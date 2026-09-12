/**
 * context.ts — everything agents-cli knows that the standalone `computer`
 * engine cannot work out for itself, serialized as one JSON object onto fd 3.
 *
 * This is the whole contract of the consumer half. Read the fields as the
 * answer to "what does the fleet CLI uniquely own?":
 *
 *   transport  which daemon to talk to — including the loopback port a
 *              `--device` tunnel landed on, which only the fleet layer can know.
 *   device     the resolved ssh target, so the engine can PROVISION a remote
 *              helper without re-implementing the devices registry.
 *   policy     which apps are allowed, derived from the agents permissions
 *              resource layer, plus the paths the engine reads and the verb
 *              classes that are gated.
 *   identity   who is acting — the actor id and the agent session, so an action
 *              lands in the right session history.
 *
 * The context is PUSHED (written and closed) rather than exposed as a callback,
 * so the engine never re-enters agents-cli and there is exactly one direction of
 * dependency. Version it: `version: 1` is what the engine matches on, and a
 * field added later must be optional so an older engine keeps working.
 */

import { resolveActor } from '../actor.js';
import { namespacedServiceLabel, serviceManagerRegistrationAllowed, serviceManifestHomeEnv } from '../service-manifest.js';
import { COMPUTER_APP_GATED_VERBS, COMPUTER_INPUT_GATED_VERBS, formatComputerPermissionGrantHint } from '../permissions.js';
import {
  loadComputerAllowList,
  loadDefaultPeers,
  resolveAdmissionCachePath,
  resolveLogPath,
  resolvePeersPath,
  resolvePolicyPath,
  resolveSocketPath,
  resolveTcpEndpoint,
  resolveVncEndpoint,
} from './policy.js';
import { resolveDeviceEndpoint } from './remote.js';
import { resolveRemoteDevice } from '../ssh-tunnel.js';
import { COMPUTER_INVOCATION_ID } from './record.js';

/** The transport the engine should use, already decided by the consumer. */
export interface ComputerTransportContext {
  kind: 'socket' | 'tcp' | 'vnc';
  /** Unix socket the local macOS daemon listens on (`kind: 'socket'`). */
  socketPath?: string;
  /** Loopback endpoint for a remote daemon, tunnelled or configured (`kind: 'tcp'`). */
  tcp?: { host: string; port: number };
  /** RFB/VNC desktop (`kind: 'vnc'`). */
  vnc?: { host: string; port: number; password: string };
}

/** A `--device <name>` target, resolved against the fleet. */
export interface ComputerDeviceContext {
  name: string;
  platform: string;
  /** `user@host`, already validated against ssh option injection. */
  sshTarget: string;
  user: string;
  host: string;
  /** Per-device ssh identity flags, in argv order. Possibly empty. */
  sshArgs: string[];
}

export interface ComputerPolicyContext {
  policyPath: string;
  peersPath: string;
  allowedBundleIds: string[];
  allowedPeerExecPaths: string[];
  /** Verbs gated on `Computer(<bundle-id>)`. */
  appGatedVerbs: readonly string[];
  /** Verbs that additionally admit a target for the rest of the agent session. */
  inputGatedVerbs: readonly string[];
  admissionCachePath: string;
  /** The exact sentence to print when a target is refused, so both sides say the same thing. */
  grantHint: string;
}

/**
 * Whether and under what label the engine may register its daemon with the
 * user's real service manager.
 *
 * This rides the context because the hazard is an agents-cli concept the engine
 * cannot see: `launchctl` and `systemd --user` are per-user-session and
 * HOME-independent, so a process running under one of agents-cli's redirected
 * homes (a version home, a hermetic test fork) would register its job in the
 * REAL service manager and outlive the sandbox that created it (RUSH-2968). Only
 * the CLI that redirected HOME knows it did.
 *
 * So agents-cli computes the verdict and the namespaced label and the engine
 * obeys them. `allowed: false` means refuse to register and print `reason`.
 */
export interface ComputerServiceContext {
  /** launchd/systemd job label, already namespaced when HOME is redirected. */
  label: string;
  /** False when this process must not touch the real service manager. */
  registrationAllowed: boolean;
  /** Why, in the words the user should see if registration is refused. */
  reason: string;
  /**
   * The home-resolution env every generated service manifest must bake, so a
   * service-manager-started daemon resolves the SAME home the caller did.
   */
  homeEnv: { HOME: string; AGENTS_REAL_HOME: string };
}

/** The base launchd label for the computer helper, before HOME namespacing. */
export const COMPUTER_HELPER_SERVICE_LABEL = 'com.phnx-labs.computer-helper';

export interface ComputerIdentityContext {
  actor: string;
  sessionId?: string;
  launchId?: string;
  /** Groups every action of this invocation into one session row. */
  invocationId: string;
}

export interface ComputerContext {
  version: 1;
  transport: ComputerTransportContext;
  device?: ComputerDeviceContext;
  policy: ComputerPolicyContext;
  identity: ComputerIdentityContext;
  service: ComputerServiceContext;
  /** Where the engine should write its daemon log, so `agents computer status` can find it. */
  logPath: string;
}

/**
 * Which agent session is acting. Same precedence the admission cache used
 * before the extraction — the harness-native id first, then agents' own.
 */
function agentSessionId(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return env.CODEX_THREAD_ID
    || env.CLAUDE_CODE_SESSION_ID
    || env.CLAUDE_SESSION_ID
    || env.AGENTS_SESSION_ID
    || env.AGENT_SESSION_ID
    || env.AGENTS_RUN_ID
    || undefined;
}

export interface BuildContextOptions {
  /** `--device <name>`, if given. */
  device?: string;
  /** An endpoint the caller just created (`start --device`), before state is re-read. */
  tcpOverride?: { host: string; port: number };
  /** Resolved path of the standalone executable, for the peer allow list. */
  computerBin?: string;
}

/**
 * Pick the transport. Precedence matches the pre-extraction client so a user's
 * existing environment keeps selecting the same backend:
 *   1. COMPUTER_HELPER_VNC — an RFB/VNC desktop (Linux GUI over the wire).
 *   2. an explicit endpoint from the caller, or a live `--device` tunnel.
 *   3. COMPUTER_HELPER_TCP — a remote daemon over an externally managed tunnel.
 *   4. the local macOS socket.
 *
 * Pure with respect to everything but env and the tunnel state file, so the
 * precedence is testable without spawning anything.
 */
export function resolveTransport(opts: BuildContextOptions = {}): ComputerTransportContext {
  const vnc = resolveVncEndpoint();
  if (vnc) return { kind: 'vnc', vnc };

  if (opts.tcpOverride) return { kind: 'tcp', tcp: opts.tcpOverride };

  if (opts.device) {
    const endpoint = resolveDeviceEndpoint(opts.device);
    if (endpoint) return { kind: 'tcp', tcp: endpoint };
  }

  const tcp = resolveTcpEndpoint();
  if (tcp) return { kind: 'tcp', tcp: { host: tcp.host, port: tcp.port } };

  return { kind: 'socket', socketPath: resolveSocketPath() };
}

/**
 * Build the context handed to the engine on fd 3.
 *
 * `device` resolution goes through the shared fleet resolver and keeps the
 * Windows expectation the computer subsystem has always enforced — a
 * `--device` pointing at a Mac gets the same refusal as before, from the fleet
 * layer that can actually see the device's platform.
 */
export async function buildComputerContext(opts: BuildContextOptions = {}): Promise<ComputerContext> {
  let device: ComputerDeviceContext | undefined;
  if (opts.device) {
    const resolved = await resolveRemoteDevice(opts.device, {
      expectPlatform: 'windows',
      forWhat: '`agents computer --device` drives the Windows computer-helper daemon, so it',
    });
    device = {
      name: opts.device,
      platform: resolved.device.platform,
      sshTarget: resolved.target,
      user: resolved.user,
      host: resolved.host,
      sshArgs: resolved.identityArgs,
    };
  }

  const allowedBundleIds = loadComputerAllowList();

  return {
    version: 1,
    transport: resolveTransport(opts),
    device,
    policy: {
      policyPath: resolvePolicyPath(),
      peersPath: resolvePeersPath(),
      allowedBundleIds,
      allowedPeerExecPaths: loadDefaultPeers({ computerBin: opts.computerBin }),
      appGatedVerbs: COMPUTER_APP_GATED_VERBS,
      inputGatedVerbs: COMPUTER_INPUT_GATED_VERBS,
      admissionCachePath: resolveAdmissionCachePath(),
      grantHint: formatComputerPermissionGrantHint(),
    },
    identity: {
      actor: resolveActor().id,
      sessionId: agentSessionId(),
      launchId: process.env.AGENT_LAUNCH_ID,
      invocationId: COMPUTER_INVOCATION_ID,
    },
    service: buildServiceContext(),
    logPath: resolveLogPath(),
  };
}

/**
 * The service-registration verdict and label the engine must obey. Exported so
 * the redirected-HOME invariant is testable directly, which is how it was pinned
 * before the engine moved out of this repo.
 */
export function buildServiceContext(): ComputerServiceContext {
  const verdict = serviceManagerRegistrationAllowed();
  return {
    label: namespacedServiceLabel(COMPUTER_HELPER_SERVICE_LABEL),
    registrationAllowed: verdict.allowed,
    reason: verdict.reason,
    homeEnv: serviceManifestHomeEnv(),
  };
}
