/**
 * Fuzzy string matching for user-provided identifiers.
 * Auto-corrects typos like "cladue" -> "claude" based on Levenshtein distance.
 */

/** Levenshtein edit distance between two strings. */
export function levenshtein(a: string, b: string): number {
  const m = a.length, n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  const dp: number[][] = Array.from({ length: m + 1 }, (_, i) =>
    Array.from({ length: n + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0))
  );
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1]
        : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }
  return dp[m][n];
}

/**
 * Damerau-Levenshtein (optimal string alignment) distance.
 * Counts a transposition of two adjacent characters as a single edit,
 * so `cladue` -> `claude` is distance 1, matching the user's notion of
 * "one misspelling."
 */
export function damerauLevenshtein(a: string, b: string): number {
  const m = a.length, n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  const dp: number[][] = Array.from({ length: m + 1 }, (_, i) =>
    Array.from({ length: n + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0))
  );
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + cost,
      );
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        dp[i][j] = Math.min(dp[i][j], dp[i - 2][j - 2] + 1);
      }
    }
  }
  return dp[m][n];
}

interface FuzzyOptions {
  /** Absolute max edit distance allowed. */
  maxDistance?: number;
  /** Max ratio of distance to input length. If set, effective threshold = min(maxDistance, floor(len * maxRatio)). */
  maxRatio?: number;
  /** Use Damerau-Levenshtein (transposition = 1 edit) instead of plain Levenshtein. */
  damerau?: boolean;
}

/**
 * Fuzzy match an input string against a list of candidates.
 * Returns the single best match within tolerance, or null if no match or ambiguous.
 */
export function fuzzyMatch<T extends string>(
  input: string,
  candidates: readonly T[],
  options: FuzzyOptions = {}
): T | null {
  const { maxDistance = 2, maxRatio, damerau = false } = options;
  const lower = input.toLowerCase();

  // Reject inputs that are too short - they're too ambiguous
  if (lower.length < 3) return null;

  // Compute effective threshold
  const threshold = maxRatio
    ? Math.min(maxDistance, Math.floor(lower.length * maxRatio))
    : maxDistance;

  const distance = damerau ? damerauLevenshtein : levenshtein;

  // Find all candidates within threshold (excluding exact matches)
  const matches: { candidate: T; dist: number }[] = [];
  for (const candidate of candidates) {
    const dist = distance(lower, candidate.toLowerCase());
    if (dist > 0 && dist <= threshold) {
      matches.push({ candidate, dist });
    }
  }

  if (matches.length === 0) return null;

  // Sort by distance
  matches.sort((a, b) => a.dist - b.dist);

  // Only return if exactly one candidate at the minimum distance (no ambiguity)
  const minDist = matches[0].dist;
  const atMinDist = matches.filter(m => m.dist === minDist);
  return atMinDist.length === 1 ? atMinDist[0].candidate : null;
}

/**
 * Preset configurations for different identifier types.
 * Based on pairwise distance analysis of candidate pools.
 */
export const FUZZY_PRESETS = {
  /** Agents: 1 mistype (insertion/deletion/substitution/transposition). Damerau so `cladue`->`claude` is 1. */
  agents: { maxDistance: 1, damerau: true },
  /** Modes: plan/edit/full all at dist=4, lenient */
  modes: { maxDistance: 2 },
  /** Efforts: high/xhigh at dist=1, must be strict */
  efforts: { maxDistance: 1 },
  /** Strategies: pinned/available/rotate all far apart */
  strategies: { maxDistance: 2 },
  /** Beta features: drive/factory at dist=7, lenient */
  beta: { maxDistance: 2 },
  /** Dynamic/user-defined: profiles, commands, hooks, etc. */
  dynamic: { maxDistance: 2, maxRatio: 0.3 },
  /** Skills: often longer names, slightly more lenient */
  skills: { maxDistance: 3, maxRatio: 0.3 },
} as const;
