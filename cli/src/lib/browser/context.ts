/** Everything agents-cli knows that the standalone `browser` engine can't work out, serialized as
 * one JSON object on fd 3 (contract §1): `version` (1; new fields optional), `target`
 * (fleet-resolved `--device`), `session` (actor + session), `remoteControl` (consent). Pushed. */

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

/** Which agent session is acting: the harness-native id first, then agents' own, the same
 * precedence as `lib/computer/context.ts`. */
function agentSessionId(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return env.CODEX_THREAD_ID
    || env.CLAUDE_CODE_SESSION_ID
    || env.CLAUDE_SESSION_ID
    || env.AGENTS_SESSION_ID
    || env.AGENT_SESSION_ID
    || env.AGENTS_RUN_ID
    || undefined;
}

/** Whether this machine allows other fleet machines to drive its browser, from the device-scope
 * `browser.remote-control` config key (unset = off). browser-cli reads and writes the same key. */
export function remoteControlEnabled(): boolean {
  return getConfigValue('browser.remote-control').value === true;
}

interface BuildContextOptions {
  /** `--device <name>`, if given (only meaningful on `start`). */
  device?: string;
  /** A precomputed target, when the caller already resolved the device; `device` need not be
   * re-resolved. */
  target?: BrowserTargetContext;
}

/** Resolve `--device <name>` to a fleet target and build the fd-3 context. Unlike `agents
 * computer`, browser drives any platform, so `resolveRemoteDevice` is called with no platform
 * expectation. */
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
