/** Normalize a resource's frontmatter `aliases:` (YAML list or comma/space string) into a clean
 * list: alternate names {@link resolveResource} matches besides the canonical name, which always
 * wins. A leaf module so skills, commands and resources share one definition without a cycle. */
export function normalizeAliases(raw: unknown): string[] {
  const tokens = Array.isArray(raw)
    ? raw
    : typeof raw === 'string'
      ? raw.split(/[,\s]+/)
      : [];
  const out: string[] = [];
  for (const token of tokens) {
    const name = String(token).trim();
    if (name && !out.includes(name)) out.push(name);
  }
  return out;
}
