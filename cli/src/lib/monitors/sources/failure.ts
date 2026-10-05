/** Poll-failure classifier (PHNX-3510). A poll that FAILS to observe (non-zero exit, or
 * transport/auth/rate-limit output) is not a value: a `gh pr list | jq` monitor flapped
 * empty/error/empty and ran a full agent. Exit code alone isn't enough, so text patterns catch it. */

/** A failure text pattern and the short reason it maps to (used in drought health). */
interface FailurePattern {
  re: RegExp;
  reason: string;
}

const FAILURE_TEXT_PATTERNS: FailurePattern[] = [
  { re: /\bAPI rate limit (?:already )?exceeded\b/i, reason: 'API rate limit exceeded' },
  { re: /\bsecondary rate limit\b/i, reason: 'secondary rate limit' },
  { re: /^\s*GraphQL:\s/im, reason: 'GraphQL error' },
  { re: /\bbad credentials\b/i, reason: 'bad credentials' },
  { re: /\b(?:401 Unauthorized|403 Forbidden)\b/i, reason: 'auth error' },
  { re: /\bcould not resolve host\b/i, reason: 'transport error (DNS)' },
  { re: /\bconnection (?:refused|reset|timed out)\b/i, reason: 'connection error' },
  { re: /\bnetwork is unreachable\b/i, reason: 'network unreachable' },
];

/** The failure reason matched in a poll's output text, or null when it looks clean. */
export function matchFailureText(text: string): string | null {
  for (const { re, reason } of FAILURE_TEXT_PATTERNS) {
    if (re.test(text)) return reason;
  }
  return null;
}

/** Classifies one poll snapshot: a short failure reason for an observation failure, else null (a
 * genuine value to diff). Failure-shaped OUTPUT is checked even on exit 0 (a piped command
 * swallows the failing half's exit code); non-zero exit always fails. */
export function classifyPollFailure(input: { exitCode?: number; text: string }): string | null {
  const textReason = matchFailureText(input.text);
  const badExit = typeof input.exitCode === 'number' && input.exitCode !== 0;
  if (badExit) {
    return textReason ? `${textReason} (exit ${input.exitCode})` : `command exited ${input.exitCode}`;
  }
  return textReason;
}
