/**
 * Consent gate for driving THIS machine's browser from another fleet machine.
 *
 * `browser --device <device>` routes a browser command to `<device>` over SSH (the
 * fleet passthrough) and runs `agents browser ...` there. `agents ssh <device>
 * agents browser …` is the same remote drive through the ssh wrapper. Every such
 * remote invocation carries the {@link FLEET_REMOTE_ENV} marker, set at the fleet
 * dispatch site (`maybeRunOnHost` / `streamAgentsOnHost`) and on the ssh wrapper
 * (`buildSshInvocation` via `markFleetRemote`). A machine only accepts being driven
 * when its owner has opted in via `agents browser remote-control on` (the
 * device-scope `browser.remote-control` config key, never synced).
 *
 * Local invocations (no marker) are never gated — this only governs cross-machine
 * drives. Read-only queries are not gated.
 *
 * The authoritative gate is {@link assertRemoteControlAllowedForRequest}, called
 * inside the browser daemon at the top of `resolveOrCreateTask` — the one
 * chokepoint every task-scoped verb resolves through — plus `BrowserService.start`
 * for the task-less `browser start` command and `BrowserService.stopProfile` for
 * the task-less `browser stop --profile` command. It has to live there because ~18
 * page verbs (`navigate`, `click`, `screenshot`, `tab-add`, …) launch OR attach
 * to a browser implicitly, and gating only the `browser start` command left every
 * one of them ungated; gating only the create branch of `resolveOrCreateTask` left
 * the attach paths ungated (RUSH-3064); `stop --profile` is handled by `bindTask`'s
 * early return before `resolveOrCreateTask` ever runs, so it needed its own gate
 * call too (PHNX-3317). {@link assertRemoteControlAllowed} remains as a fast-fail
 * CLI-side check so a refused `start` never auto-creates a profile.
 */

import { getConfigValue } from '../device-config.js';

/** Env marker set on every remote `agents` invocation by `buildRemoteAgentsInvocation` and `markFleetRemote`. */
export const FLEET_REMOTE_ENV = 'AGENTS_FLEET_REMOTE';

/** True when this process was dispatched to this machine by a fleet `--device` or `agents ssh … agents browser` run. */
export function isFleetRemoteInvocation(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[FLEET_REMOTE_ENV] === '1';
}

/**
 * Whether this machine allows other fleet machines to drive its browser. Reads
 * the device-scope `browser.remote-control` config key. Unset = off (deny).
 */
function remoteControlEnabled(): boolean {
  return getConfigValue('browser.remote-control').value === true;
}

/**
 * Guard the browser-drive entry point. A fleet-remote invocation may only drive
 * this machine's browser when the owner opted in; otherwise throw a clear,
 * actionable error. A local invocation is never gated.
 *
 * `env` and `enabled` are injectable so the decision is unit-testable without a
 * real remote hop or a real config store.
 */
export function assertRemoteControlAllowed(opts?: {
  env?: NodeJS.ProcessEnv;
  enabled?: boolean;
}): void {
  const env = opts?.env ?? process.env;
  if (!isFleetRemoteInvocation(env)) return;
  const enabled = opts?.enabled ?? remoteControlEnabled();
  if (enabled) return;

  const who = env.AGENTS_ACTOR_HOST || env.AGENTS_ACTOR || 'A fleet machine';
  throw new Error(remoteControlRefusal(who));
}

/**
 * The daemon-side consent gate.
 *
 * Reads ONLY the per-request marker, never `process.env`: the browser daemon is
 * shared and long-lived, and it may have been auto-started by a fleet-remote CLI
 * that leaked `AGENTS_FLEET_REMOTE=1` into its environment permanently. Reading
 * the daemon's env would then refuse every subsequent LOCAL drive on this
 * machine until the daemon restarted.
 *
 * `actor` is likewise the caller's forwarded identity, not the daemon's.
 */
export function assertRemoteControlAllowedForRequest(
  fleetRemote: boolean | undefined,
  opts: { actor?: string; enabled?: boolean } = {},
): void {
  if (!fleetRemote) return;
  const enabled = opts.enabled ?? remoteControlEnabled();
  if (enabled) return;
  throw new Error(remoteControlRefusal(opts.actor || 'A fleet machine'));
}

/** The refusal text, shared by the CLI-side and daemon-side gates. */
function remoteControlRefusal(who: string): string {
  return (
    `${who} tried to drive this machine's browser over \`browser --device\`, but remote ` +
    `browser control is off here. To allow it, run on THIS machine:\n` +
    `  agents browser remote-control on`
  );
}
