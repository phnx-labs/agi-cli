import type { SessionAgentId } from './types.js';

/**
 * The single authority for "can `agents sessions resume` faithfully reopen a
 * session from this harness?" — the harnesses for which
 * {@link buildResumeCommand} (src/commands/sessions.ts) yields a real command
 * (its `resumeArgv` is non-null): a native `--resume` / `resume` / `--session`
 * continuation exists.
 *
 * A captured-only harness — gemini, antigravity, openclaw, rush, hermes, grok,
 * kimi, droid, cursor — is deliberately absent: its transcript is readable and
 * indexable, but there is no native resume path, so any `recovery` command built
 * for it would dead-end at a launcher that has no continuation verb.
 *
 * This lives in the leaf so both consumers agree without re-deriving the list or
 * importing across the commands→lib boundary (which is circular):
 *   - the SessionPicker projection and `buildResumeCommand` itself, and
 *   - the watch stream's durable "Previous" set (`buildPreviousRows`), which
 *     MUST exclude a harness it cannot recover rather than emit a dead Resume
 *     (PHNX-3621).
 */
export const RESUMABLE_HARNESSES: ReadonlySet<SessionAgentId> = new Set<SessionAgentId>([
  'claude',
  'codex',
  'opencode',
  'muse',
]);

/** True when a session from `agent` has a native resume path — see {@link RESUMABLE_HARNESSES}. */
export function isResumableHarness(agent: SessionAgentId): boolean {
  return RESUMABLE_HARNESSES.has(agent);
}
