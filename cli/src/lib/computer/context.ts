/**
 * context.ts — everything agents-cli knows that the standalone `computer`
 * engine cannot work out for itself, serialized as one JSON object onto fd 3.
 *
 * This is the whole contract of the consumer half, and it is deliberately four
 * fields wide. The engine accepts exactly this shape:
 *
 *   version      `1`. The engine matches on it; a field added later must be
 *                optional so an older engine keeps working.
 *   permissions  which apps are allowed, derived from `Computer(<bundle-id>)`
 *                rules in the agents permissions resource layer. The engine
 *                would have to re-learn resource layering to compute this.
 *   peers        which executables the daemon accepts a connection from.
 *   target       the `--device <name>` target, resolved against the fleet:
 *                devices registry, ssh identity, platform. The engine matches
 *                its own `--device <alias>` against this instead of reading a
 *                registry it does not have. Absent for a local invocation.
 *   session      who is acting — actor id and agent session — so an action
 *                lands in the right session history.
 *
 * WHAT IS DELIBERATELY NOT HERE. The transport (`COMPUTER_HELPER_TCP`,
 * `COMPUTER_HELPER_VNC`, `COMPUTER_HELPER_SOCKET`), the remote helper's auth
 * token, and the policy-file paths are the ENGINE's: it provisions the Windows
 * helper, mints and stores the token, opens the `ssh -L` tunnel and hydrates its
 * own transport from the state it wrote. agents-cli publishing a loopback
 * endpoint here (or on `COMPUTER_HELPER_TCP`) would be a second, drifting copy
 * of that answer — and a copy without the token, which the daemon rejects with
 * `auth_failed`. Service-manager safety (launchd/systemd registration under a
 * redirected HOME) is likewise the standalone's own: it inherits `HOME` and
 * `AGENTS_REAL_HOME` and renders its own manifest, so agents-cli neither
 * computes a label nor issues a verdict for it.
 *
 * The context is PUSHED (written and closed) rather than exposed as a callback,
 * so the engine never re-enters agents-cli and there is exactly one direction of
 * dependency.
 */

import { resolveActor } from '../actor.js';
import { loadComputerAllowList, loadDefaultPeers } from './policy.js';
import { resolveRemoteDevice } from '../ssh-tunnel.js';

/** A `--device <name>` target, resolved against the fleet. */
export interface ComputerTargetContext {
  /** The device name as the user typed it. */
  alias: string;
  /** `user@host`, already validated against ssh option injection. */
  host: string;
  user: string;
  /** Bare host — the ssh-config Host name or address, without the user. */
  hostname: string;
  platform: string;
  /** Per-device ssh identity flags, in argv order. Possibly empty. */
  sshArgs: string[];
}

/** Who is acting, so the engine can stamp the action it reports back. */
export interface ComputerSessionContext {
  sessionId?: string;
  launchId?: string;
  actor: string;
}

export interface ComputerContext {
  version: 1;
  permissions?: { allow: string[] };
  peers: { allow: string[] };
  target?: ComputerTargetContext;
  session: ComputerSessionContext;
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
  /** Direct host targeting, which bypasses fleet resolution. */
  host?: string;
  /** Resolved path of the standalone executable, for the peer allow list. */
  computerBin?: string;
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
  let target: ComputerTargetContext | undefined;
  if (opts.device) {
    const resolved = await resolveRemoteDevice(opts.device, {
      expectPlatform: 'windows',
      forWhat: '`agents computer --device` drives the Windows computer-helper daemon, so it',
    });
    target = {
      alias: opts.device,
      host: resolved.target,
      user: resolved.user,
      hostname: resolved.host,
      platform: resolved.device.platform,
      sshArgs: resolved.identityArgs,
    };
  }

  return {
    version: 1,
    ...(!opts.device && !opts.host && !process.env.COMPUTER_HELPER_TCP && !process.env.COMPUTER_HELPER_VNC
      ? { permissions: { allow: loadComputerAllowList() } } : {}),
    peers: { allow: loadDefaultPeers({ computerBin: opts.computerBin }) },
    // Spread rather than assigned: a local invocation must not ship a `target`
    // key at all, so the engine never has to distinguish absent from null.
    ...(target ? { target } : {}),
    session: {
      sessionId: agentSessionId(),
      launchId: process.env.AGENT_LAUNCH_ID,
      actor: resolveActor().id,
    },
  };
}
