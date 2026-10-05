/** The one public command UI and lifecycle consumers use to reopen a session. `agents sessions
 * resume` owns identity resolution, source-device routing, version/home selection and harness
 * continuation; callers must not recreate it. */
export function buildCanonicalResumeCommand(sessionId: string): string[] {
  return ['agents', 'sessions', 'resume', sessionId];
}
