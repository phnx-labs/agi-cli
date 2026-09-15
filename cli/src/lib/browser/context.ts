/**
 * context.ts — everything agents-cli knows that the standalone `browser` engine
 * cannot work out for itself, serialized as one JSON object onto fd 3.
 *
 * This is the whole contract of the consumer half (browser-cli integration
 * contract §1). The engine accepts exactly this shape:
 *
 *   version        `1`. The engine matches on it; a field added later must be
 *                  optional so an older engine keeps working.
 *   target         the `--device <name>` target, resolved against the fleet:
 *                  device registry, ssh identity, platform. The engine matches
 *                  its own `--device <alias>` against this instead of reading a
 *                  registry it does not have, then falls back to `~/.ssh/config`.
 *                  Absent for a local invocation.
 *   session        who is acting — actor id and agent session — so an action
 *                  lands in the right session history.
 *   remoteControl  whether THIS machine consents to being driven by a peer.
 *                  agents-cli owns the policy; browser-cli enforces the flag.
 *
 * WHAT IS DELIBERATELY NOT HERE. The CDP/BiDi/Arc endpoint, the IPC socket, the
 * chrome-data store and the profile declarations are the ENGINE's: browser-cli
 * keeps every on-disk path the in-repo subsystem used (integration contract §4)
 * and hydrates its own transport from them. agents-cli publishing an endpoint
 * here would be a second, drifting copy of that answer.
 *
 * The context is PUSHED (written and closed) rather than exposed as a callback,
 * so the engine never re-enters agents-cli and there is exactly one direction of
 * dependency.
 */

import { resolveActor } from '../actor.js';
import { resolveRemoteDevice } from '../ssh-tunnel.js';
import { getConfigValue } from '../device-config.js';

/** A `--device <name>` target, resolved against the fleet. */
export interface BrowserTargetContext {
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
interface BrowserSessionContext {
  sessionId?: string;
  launchId?: string;
  actor: string;
}

interface BrowserContext {
  version: 1;
  target?: BrowserTargetContext;
  session: BrowserSessionContext;
  remoteControl: { allowed: boolean };
}

/**
 * Which agent session is acting. The harness-native id first, then agents' own —
 * the same precedence `lib/computer/context.ts` uses.
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

/**
 * Whether this machine allows other fleet machines to drive its browser. Reads
 * the device-scope `browser.remote-control` config key. Unset = off (deny).
 * browser-cli reads and writes the same key, so a `remote-control on` typed at
 * either surface agrees.
 */
export function remoteControlEnabled(): boolean {
  return getConfigValue('browser.remote-control').value === true;
}

interface BuildContextOptions {
  /** `--device <name>`, if given (only meaningful on `start`). */
  device?: string;
  /**
   * A precomputed target, when the caller already resolved the device. When
   * present, `device` need not be re-resolved.
   */
  target?: BrowserTargetContext;
}

/**
 * Resolve `--device <name>` to a fleet target and build the context handed to
 * the engine on fd 3.
 *
 * Unlike `agents computer`, browser drives ANY platform, so `resolveRemoteDevice`
 * is called with no platform expectation — a `--device` pointing at a Mac, Linux
 * box or Windows host all resolve.
 */
export async function buildBrowserContext(opts: BuildContextOptions = {}): Promise<BrowserContext> {
  let target: BrowserTargetContext | undefined = opts.target;
  if (!target && opts.device && opts.device !== 'local') {
    const resolved = await resolveRemoteDevice(opts.device);
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
    // Spread rather than assigned: a local invocation must not ship a `target`
    // key at all, so the engine never has to distinguish absent from null.
    ...(target ? { target } : {}),
    session: {
      sessionId: agentSessionId(),
      launchId: process.env.AGENT_LAUNCH_ID,
      actor: resolveActor().id,
    },
    remoteControl: { allowed: remoteControlEnabled() },
  };
}
