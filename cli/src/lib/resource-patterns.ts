/** Resource selection patterns for agents.yaml `versions:` entries: `[!]source:name`, where source
 * is system, user, project or an extra-repo alias (`rush:*`) and name is `*` or a resource.
 * Evaluation: union all inclusions, then subtract all exclusions (e.g. `!user:temp`). */

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

/** Expand patterns against a name->source map: union of matches minus exclusions. Comma-grouped
 * names avoid repeating the prefix (`system:brain-scan,mq`, `!user:temp,draft`). In YAML flow
 * sequences a pattern containing a comma needs quoting; block items and yaml.stringify handle it. */
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

/** Build the default pattern list for a resource type, ordered system, user, extra aliases, project
 * (base to override). `extraAliases` are enabled extra repos in insertion order; `includeProject`
 * is false for hooks (security). */
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
