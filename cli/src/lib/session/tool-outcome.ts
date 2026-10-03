import type { SessionEvent } from './types.js';

/** Commands whose exit 1 means no match, rather than a failed operation. */
const BENIGN_EXIT1_RE = /^\s*(rg|grep|diff|test|\[)\b/;

/** Shared by the timeline counters and the glance failure list. */
export function toolFailureKind(event: SessionEvent, call?: Pick<SessionEvent, 'command' | 'args'>): 'failed' | 'blocked' | undefined {
  if (event.type !== 'tool_result' && event.type !== 'error') return undefined;
  if (event.blocked) return 'blocked';
  if (event.type !== 'error' && event.outcome !== 'error' && event.success !== false) return undefined;
  const command = event.command ?? event.args?.command ?? call?.command ?? call?.args?.command;
  if (event.exitCode === 1 && typeof command === 'string' && BENIGN_EXIT1_RE.test(command)) return undefined;
  return 'failed';
}
