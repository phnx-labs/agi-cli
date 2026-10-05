/** Top-level command spellcheck (RUSH-2329). Candidates are plain strings from
 * KNOWN_TOP_LEVEL_COMMANDS, not the commander registry, so a typo avoids registerAllEagerCommands
 * (~250-330ms). */

/** Calculate the Levenshtein edit distance between two strings. */
export function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array(m + 1)
    .fill(null)
    .map(() => Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] =
        a[i - 1] === b[j - 1]
          ? dp[i - 1][j - 1]
          : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }
  return dp[m][n];
}

/** Closest top-level command by Levenshtein distance, iterating in first-seen order so ties break
 * like the historical registerAllEagerCommands order (RUSH-2329). */
export function closestTopLevelCommand(
  unknown: string,
  candidates: Iterable<string>,
): { closest: string | null; minDist: number } {
  let closest: string | null = null;
  let minDist = Infinity;
  for (const cmd of candidates) {
    const dist = levenshtein(unknown, cmd);
    if (dist < minDist) {
      minDist = dist;
      closest = cmd;
    }
  }
  return { closest, minDist };
}
