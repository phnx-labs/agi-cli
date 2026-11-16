import * as fs from 'fs';
import * as path from 'path';

const RC_FILES = [
  '.zshrc', '.zshenv', '.zprofile', '.bashrc', '.bash_aliases', '.bash_profile', '.profile',
  '.config/fish/config.fish',
] as const;
const MAX_RC_BYTES = 1024 * 1024;
const MAX_FUNCTION_LINES = 20;

export interface ShadowingDefinition {
  kind: 'alias' | 'function';
  file: string;
  line: number;
  fish: boolean;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function findShadowingDefinition(group: string, home: string): ShadowingDefinition | undefined {
  const name = `${escapeRegExp(group)}(?![\\w-])`;
  const callsAgents = new RegExp(`(?:^|[\\s'"/;&|({])(?:agents|ag)\\s+${name}`);
  const alias = new RegExp(`^\\s*alias\\s+(?:-\\w+\\s+)*(?:--\\s+)?${name}(?:=|\\s+)(.*)$`);
  const fn = new RegExp(`^\\s*(?:function\\s+${name}|${name}\\s*\\(\\s*\\))(.*)$`);
  const comment = /^\s*#/;

  for (const file of RC_FILES) {
    const full = path.join(home, file);
    let text: string;
    try {
      const stat = fs.statSync(full);
      if (!stat.isFile() || stat.size > MAX_RC_BYTES) continue;
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
      const fnMatch = fn.exec(lines[i]!);
      if (!fnMatch) continue;
      const header = fnMatch[1]!;
      if (callsAgents.test(header)) return { kind: 'function', file, line: i + 1, fish };
      if (/\}\s*;?\s*$/.test(header)) continue;
      let depth = 0;
      const end = Math.min(lines.length, i + MAX_FUNCTION_LINES);
      for (let j = i + 1; j < end; j++) {
        const body = lines[j]!;
        if (comment.test(body)) continue;
        if (callsAgents.test(body)) return { kind: 'function', file, line: i + 1, fish };
        if (fish && /^\s*(?:if|for|while|switch|begin|function)\b/.test(body)) depth++;
        if (/^\s*(?:\}|end\b)/.test(body) && depth-- === 0) break;
      }
    }
  }
  return undefined;
}

export function shadowFixCommand(group: string, def: ShadowingDefinition): string {
  if (def.fish) return `functions --erase ${group}`;
  return def.kind === 'alias' ? `unalias ${group}` : `unset -f ${group}`;
}
