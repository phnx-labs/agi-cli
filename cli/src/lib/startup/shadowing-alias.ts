import * as fs from 'fs';
import * as path from 'path';

const RC_FILES = ['.zshrc', '.bashrc', '.bash_aliases', '.zprofile', '.config/fish/config.fish'] as const;
const MAX_RC_BYTES = 1024 * 1024;
const MAX_FUNCTION_LINES = 20;

export interface ShadowingDefinition {
  kind: 'alias' | 'function';
  /** The rc file relative to HOME, e.g. `.zshrc`. */
  file: string;
  /** 1-indexed line of the alias, or of the function header. */
  line: number;
  fish: boolean;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Finds the rc-file line that routes a bare `<group>` back to `agents <group>`: an
 * `alias <group>=... agents <group>` or a `<group>()` / `function <group>` whose body
 * calls `agents <group>`. Read-only and bounded to RC_FILES.
 */
export function findShadowingDefinition(group: string, home: string): ShadowingDefinition | undefined {
  const name = escapeRegExp(group);
  const callsAgents = new RegExp(`(?:^|[\\s'"/;&|(])(?:agents|ag)\\s+${name}\\b`);
  const alias = new RegExp(`^\\s*alias\\s+(?:--\\s+)?${name}(?:=|\\s+)(.*)$`);
  const fn = new RegExp(`^\\s*(?:function\\s+${name}\\b|${name}\\s*\\(\\s*\\))`);

  for (const file of RC_FILES) {
    const full = path.join(home, file);
    let text: string;
    try {
      if (fs.statSync(full).size > MAX_RC_BYTES) continue;
      text = fs.readFileSync(full, 'utf-8');
    } catch {
      continue;
    }
    const fish = file.endsWith('.fish');
    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const aliasMatch = alias.exec(lines[i]!);
      if (aliasMatch && callsAgents.test(aliasMatch[1]!)) {
        return { kind: 'alias', file, line: i + 1, fish };
      }
      if (!fn.test(lines[i]!)) continue;
      const end = Math.min(lines.length, i + MAX_FUNCTION_LINES);
      for (let j = i; j < end; j++) {
        if (callsAgents.test(lines[j]!)) return { kind: 'function', file, line: i + 1, fish };
        if (j > i && /^\s*(?:\}|end\b)/.test(lines[j]!)) break;
      }
    }
  }
  return undefined;
}

export function shadowFixCommand(group: string, def: ShadowingDefinition): string {
  if (def.fish) return `functions --erase ${group}`;
  return def.kind === 'alias' ? `unalias ${group}` : `unset -f ${group}`;
}
