/**
 * Resource selection patterns for agents.yaml versions: entries.
 *
 * Pattern syntax: [!]source:name
 *   "system:*"     — all resources from ~/.agents/.system/
 *   "user:*"       — all resources from ~/.agents/
 *   "rush:*"       — all resources from ~/.agents-rush/  (extra repo alias)
 *   "project:*"    — all resources from .agents/ in the project root
 *   "user:foo"     — specifically the resource named "foo" from ~/.agents/
 *   "!user:temp"   — exclude "temp" from the user repo
 *
 * Evaluation rule: union all inclusions, then subtract all exclusions.
 */

interface ParsedPattern {
  negate: boolean;
  source: string;
  name: string; // '*' = wildcard
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

/** Returns true if the string is a legacy plain name with no source: prefix. */
export function isLegacyName(p: string): boolean {
  return !p.startsWith('!') && !p.includes(':');
}

/**
 * Expand a list of patterns against an available name→source map.
 * Returns the union of matching names with exclusions subtracted.
 *
 * Supports comma-grouped names to avoid repeating the source prefix:
 *   "system:brain-scan,mq"  →  includes brain-scan and mq from system
 *   "!user:temp,draft"      →  excludes temp and draft from user
 *
 * Note: in YAML flow sequences ([...]) a comma inside a pattern requires
 * quoting ("system:brain-scan,mq"). Block-style items and yaml.stringify
 * output handle this automatically.
 */
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
      // Comma-grouped names: "system:brain-scan,mq" → ['brain-scan', 'mq']
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
      // Skip malformed patterns
    }
  }

  return [...included].filter(n => !excluded.has(n));
}

/**
 * Build the default pattern list for a resource type.
 * Order: system → user → alias1 → alias2 → ... → project (base-to-override).
 * @param extraAliases  Alias names of enabled extra repos, in insertion order.
 * @param includeProject  Whether to append "project:*". False for hooks (security).
 */
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
