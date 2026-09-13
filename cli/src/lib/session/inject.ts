/**
 * Session → Terminal-Engine injection adapter.
 *
 * The Terminal Engine owns the injection primitive (`injectIntoTerminal`,
 * src/lib/terminal/inject.ts). This thin adapter maps a session's provenance
 * `ReplyRail` (the addressable terminal the feed already derives — provenance.ts:47)
 * to the engine's `InjectTarget`, so a caller can go session → keystrokes in one
 * hop. Kept on the session side because `ReplyRail` is a session concept; the
 * engine stays agnostic of how a target was discovered.
 */

import type { ReplyRail } from './provenance.js';
import type { InjectTarget } from '../terminal/index.js';

/**
 * Map a session's `ReplyRail` to an engine `InjectTarget`. Today only tmux rails
 * are externally addressable (provenance.ts:143-149); a null rail yields null and
 * the caller must supply a target another way (a macOS window).
 */
export function injectTargetFromReplyRail(rail: ReplyRail): InjectTarget | null {
  if (rail && rail.rail === 'tmux') {
    return { backend: 'tmux', pane: rail.target, socket: rail.socket };
  }
  return null;
}
