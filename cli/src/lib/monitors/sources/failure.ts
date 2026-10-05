
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

export function matchFailureText(text: string): string | null {
  for (const { re, reason } of FAILURE_TEXT_PATTERNS) {
    if (re.test(text)) return reason;
  }
  return null;
}

export function classifyPollFailure(input: { exitCode?: number; text: string }): string | null {
  const textReason = matchFailureText(input.text);
  const badExit = typeof input.exitCode === 'number' && input.exitCode !== 0;
  if (badExit) {
    return textReason ? `${textReason} (exit ${input.exitCode})` : `command exited ${input.exitCode}`;
  }
  return textReason;
}
