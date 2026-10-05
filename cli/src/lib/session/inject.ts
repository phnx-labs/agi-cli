/** Session to Terminal-Engine injection adapter. The engine owns `injectIntoTerminal`
 * (src/lib/terminal/inject.ts); this maps a session's provenance `ReplyRail` to its
 * `InjectTarget`. It lives on the session side because `ReplyRail` is a session concept. */

import type { ReplyRail } from './provenance.js';
import type { InjectTarget } from '../terminal/index.js';

/** Map a session's `ReplyRail` to an engine `InjectTarget`. Only tmux rails are externally
 * addressable today (provenance.ts:143-149); a null rail yields null and the caller must supply a
 * target another way (a macOS window). */
export function injectTargetFromReplyRail(rail: ReplyRail): InjectTarget | null {
  if (rail && rail.rail === 'tmux') {
    return { backend: 'tmux', pane: rail.target, socket: rail.socket };
  }
  return null;
}
