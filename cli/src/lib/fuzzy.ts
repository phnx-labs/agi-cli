
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
  maxDistance?: number;
  maxRatio?: number;
  damerau?: boolean;
}

export function fuzzyMatch<T extends string>(
  input: string,
  candidates: readonly T[],
  options: FuzzyOptions = {}
): T | null {
  const { maxDistance = 2, maxRatio, damerau = false } = options;
  const lower = input.toLowerCase();

  if (lower.length < 3) return null;

  const threshold = maxRatio
    ? Math.min(maxDistance, Math.floor(lower.length * maxRatio))
    : maxDistance;

  const distance = damerau ? damerauLevenshtein : levenshtein;

  const matches: { candidate: T; dist: number }[] = [];
  for (const candidate of candidates) {
    const dist = distance(lower, candidate.toLowerCase());
    if (dist > 0 && dist <= threshold) {
      matches.push({ candidate, dist });
    }
  }

  if (matches.length === 0) return null;

  matches.sort((a, b) => a.dist - b.dist);

  const minDist = matches[0].dist;
  const atMinDist = matches.filter(m => m.dist === minDist);
  return atMinDist.length === 1 ? atMinDist[0].candidate : null;
}

export const FUZZY_PRESETS = {
  agents: { maxDistance: 1, damerau: true },
  modes: { maxDistance: 2 },
  efforts: { maxDistance: 1 },
  strategies: { maxDistance: 2 },
  beta: { maxDistance: 2 },
  dynamic: { maxDistance: 2, maxRatio: 0.3 },
  skills: { maxDistance: 3, maxRatio: 0.3 },
} as const;
