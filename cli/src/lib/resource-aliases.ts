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
