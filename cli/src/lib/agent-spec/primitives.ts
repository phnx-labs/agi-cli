// Pure version primitives for the agent-spec engine — zero dependencies, so the
// whole module (and versions.ts, which re-uses these) stays trivially testable.

/**
 * The only shape a version string may take before it reaches an exec/shim/path
 * boundary. Accepts the literal `latest` or a 1–64 char run of `[A-Za-z0-9._+-]`
 * with no `..` traversal. This is THE validation gate — every resolver funnels
 * exact-version tokens through it.
 */
export const VERSION_RE = /^(?:latest|(?!.*\.\.)[A-Za-z0-9._+-]{1,64})$/;

/** Canonical qualifier set, in help/display order. `pinned` ≡ `default`. */
export const AGENT_QUALIFIERS = ['latest', 'oldest', 'pinned', 'default', 'all'] as const;

/** Split a version into numeric `.`-segments (non-numeric tail → 0), e.g. `2026.2.19-2` → [2026,2,19]. */
function numericParts(v: string): number[] {
  return v.split('.').map((n) => parseInt(n, 10) || 0);
}

/**
 * Trailing `-<digits>` build suffix as a number (0 when absent). OpenClaw ships
 * same-day rebuilds as `2026.2.19-2` where a higher `-N` is NEWER — the opposite
 * of a semver pre-release. Used only to break exact numeric ties, so semver-style
 * versions (which carry no `-N`) are unaffected.
 */
function buildSuffix(v: string): number {
  const m = /-(\d+)$/.exec(v);
  return m ? parseInt(m[1], 10) : 0;
}

/**
 * Ordering for version strings (ascending).
 *   1. numeric segment comparison (semver-ish: `2.1.187` > `2.1.143`)
 *   2. tie → trailing `-N` build suffix, numerically (`2026.2.19-2` > `2026.2.19`)
 *   3. still tied → 0 (legacy behavior: `1.0` == `1.0.0`, non-numeric tails == 0)
 *
 * Deliberately NOT a full semver comparator: OpenClaw's `-N` is a rebuild marker
 * (higher = newer); a semver comparator would invert it. The `-N` tiebreak is the
 * only addition over the historical numeric-only compare, so suffix-free versions
 * (claude/codex semver) are unaffected.
 */
export function compareVersions(a: string, b: string): number {
  const na = numericParts(a);
  const nb = numericParts(b);
  for (let i = 0; i < Math.max(na.length, nb.length); i++) {
    const av = na[i] || 0;
    const bv = nb[i] || 0;
    if (av !== bv) return av - bv;
  }
  const sa = buildSuffix(a);
  const sb = buildSuffix(b);
  if (sa !== sb) return sa - sb;
  return 0;
}
