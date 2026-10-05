
export const VERSION_RE = /^(?:latest|(?!.*\.\.)[A-Za-z0-9._+-]{1,64})$/;

export const AGENT_QUALIFIERS = ['latest', 'oldest', 'pinned', 'default', 'all'] as const;

function numericParts(v: string): number[] {
  return v.split('.').map((n) => parseInt(n, 10) || 0);
}

// OpenClaw's trailing -N is a rebuild counter: larger is newer, unlike a SemVer prerelease.
function buildSuffix(v: string): number {
  const m = /-(\d+)$/.exec(v);
  return m ? parseInt(m[1], 10) : 0;
}

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
