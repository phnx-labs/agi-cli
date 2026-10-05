/** Everything agents-cli knows that the standalone `computer` engine cannot work out, sent on fd 3:
 * `version` (1; later fields optional), `permissions` (from `Computer(<bundle-id>)` rules),
 * `peers`, `target`, `session`. Transport and token belong to the engine. */

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
interface ComputerSessionContext {
  sessionId?: string;
  launchId?: string;
  actor: string;
}

interface ComputerContext {
  version: 1;
  permissions?: { allow: string[] };
  peers: { allow: string[] };
  target?: ComputerTargetContext;
  session: ComputerSessionContext;
}

/** Which agent session is acting: the harness-native id first, then agents' own (same precedence as
 * the pre-extraction admission cache). */
function agentSessionId(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return env.CODEX_THREAD_ID
    || env.CLAUDE_CODE_SESSION_ID
    || env.CLAUDE_SESSION_ID
    || env.AGENTS_SESSION_ID
    || env.AGENT_SESSION_ID
    || env.AGENTS_RUN_ID
    || undefined;
}

interface BuildContextOptions {
  /** `--device <name>`, if given. */
  device?: string;
  /** Direct host targeting, which bypasses fleet resolution. */
  host?: string;
  /** Resolved path of the standalone executable, for the peer allow list. */
  computerBin?: string;
  /** A precomputed target (PHNX-4090: `resolveDeviceHost` already resolved the device's
   * `computer.host` or ssh fallback). `device` then only gates the local-permissions branch,
   * skipping a second fleet resolution. */
  target?: ComputerTargetContext;
}

/** Build the context handed to the engine on fd 3. `device` resolution uses the shared fleet
 * resolver and keeps the Windows expectation: a `--device` pointing at a Mac gets the same refusal
 * as before. */
export async function buildComputerContext(opts: BuildContextOptions = {}): Promise<ComputerContext> {
  let target: ComputerTargetContext | undefined = opts.target;
  if (!target && opts.device) {
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
