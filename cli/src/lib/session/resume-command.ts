export function buildCanonicalResumeCommand(sessionId: string): string[] {
  return ['agents', 'sessions', 'resume', sessionId];
}
