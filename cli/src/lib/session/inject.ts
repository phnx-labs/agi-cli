
import type { ReplyRail } from './provenance.js';
import type { InjectTarget } from '../terminal/index.js';

export function injectTargetFromReplyRail(rail: ReplyRail): InjectTarget | null {
  if (rail && rail.rail === 'tmux') {
    return { backend: 'tmux', pane: rail.target, socket: rail.socket };
  }
  return null;
}
