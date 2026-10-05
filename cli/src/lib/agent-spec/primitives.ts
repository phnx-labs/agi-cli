
/** The only shape a version string may take before it reaches an exec/shim/path boundary: the
 * literal `latest` or 1-64 chars of `[A-Za-z0-9._+-]` with no `..`. Every resolver funnels
 * exact-version tokens through it. */
export const VERSION_RE = /^(?:latest|(?!.*\.\.)[A-Za-z0-9._+-]{1,64})$/;

export const AGENT_QUALIFIERS = ['latest', 'oldest', 'pinned', 'default', 'all'] as const;

function numericParts(v: string): number[] {
  return v.split('.').map((n) => parseInt(n, 10) || 0);
}

/** Trailing `-<digits>` build suffix as a number (0 if absent). OpenClaw's same-day rebuilds
 * (`2026.2.19-2`) are newer at higher `-N`, opposite of a semver pre-release. Used only to break
 * numeric ties. */
function buildSuffix(v: string): number {
  const m = /-(\d+)$/.exec(v);
  return m ? parseInt(m[1], 10) : 0;
}

/** Ascending version order: numeric segments, then the trailing `-N` build suffix, then tie (0).
 * Not full semver: OpenClaw's `-N` is a rebuild marker (higher is newer) that a semver comparator
 * would invert. Suffix-free versions are unaffected. */
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
