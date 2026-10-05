
interface ParsedPattern {
  negate: boolean;
  source: string;
  name: string;
}

export function parsePattern(p: string): ParsedPattern {
  const negate = p.startsWith('!');
  const raw = negate ? p.slice(1) : p;
  const colon = raw.indexOf(':');
  if (colon === -1) {
    throw new Error(`Invalid resource pattern "${p}": expected "source:name" format`);
  }
  return { negate, source: raw.slice(0, colon), name: raw.slice(colon + 1) };
}

export function isLegacyName(p: string): boolean {
  return !p.startsWith('!') && !p.includes(':');
}

export function expandPatterns(
  patterns: string[],
  available: Map<string, string>,
): string[] {
  const included = new Set<string>();
  const excluded = new Set<string>();

  for (const p of patterns) {
    try {
      const { negate, source, name } = parsePattern(p);
      const target = negate ? excluded : included;
      const names = name === '*' ? ['*'] : name.split(',').map(n => n.trim()).filter(Boolean);
      for (const n of names) {
        if (n === '*') {
          for (const [rn, rs] of available) {
            if (rs === source) target.add(rn);
          }
        } else {
          if (available.has(n)) target.add(n);
        }
      }
    } catch {
    }
  }

  return [...included].filter(n => !excluded.has(n));
}

export function defaultPatterns(extraAliases: string[] = [], includeProject = true): string[] {
  const patterns: string[] = ['system:*', 'user:*'];
  for (const alias of extraAliases) {
    patterns.push(`${alias}:*`);
  }
  if (includeProject) {
    patterns.push('project:*');
  }
  return patterns;
}
