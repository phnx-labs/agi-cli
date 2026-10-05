
import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
import type { HookMatches } from '../types.js';

interface HookInput {
  hook_event_name?: string;
  prompt?: string;
  tool_name?: string;
  tool_args?: unknown;
  cwd?: string;
  permission_mode?: string;
  permissionMode?: string;
}

function arrayOf<T>(v: T | T[] | undefined): T[] {
  if (v === undefined) return [];
  return Array.isArray(v) ? v : [v];
}

function isGitDirty(cwd: string): boolean {
  try {
    const out = execSync('git status --porcelain', {
      cwd,
      stdio: ['ignore', 'pipe', 'ignore'],
      encoding: 'utf-8',
    });
    return out.trim().length > 0;
  } catch {
    return false;
  }
}

function findProjectRoot(start: string): string | null {
  let dir = path.resolve(start);
  while (true) {
    if (fs.existsSync(path.join(dir, '.git'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function maxGroupDepth(source: string): number {
  let depth = 0;
  let max = 0;
  let escaped = false;
  let inClass = false;

  for (const ch of source) {
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === '\\') {
      escaped = true;
      continue;
    }
    if (ch === '[') {
      inClass = true;
      continue;
    }
    if (ch === ']') {
      inClass = false;
      continue;
    }
    if (inClass) continue;
    if (ch === '(') {
      depth += 1;
      max = Math.max(max, depth);
    } else if (ch === ')' && depth > 0) {
      depth -= 1;
    }
  }

  return max;
}

export function isSafeHookRegex(source: string): boolean {
  if (source.length > 200) return false;
  if (maxGroupDepth(source) > 3) return false;
  if (/\((?:\?:)?[^)]*[*+][?+*{,\d}]*[^)]*\)\s*(?:[+*]|\{\d*,?\d*\})/.test(source)) return false;
  return true;
}

function compileHookRegex(source: string): RegExp | null {
  if (!isSafeHookRegex(source)) return null;
  try {
    return new RegExp(source);
  } catch {
    return null;
  }
}

export function shouldFire(matches: HookMatches | undefined, input: HookInput): boolean {
  if (!matches) return true;

  const cwd = input.cwd || process.cwd();

  if (matches.prompt_contains !== undefined) {
    const prompt = input.prompt ?? '';
    if (!prompt.includes(matches.prompt_contains)) return false;
  }

  if (matches.prompt_matches !== undefined) {
    const prompt = input.prompt ?? '';
    const re = compileHookRegex(matches.prompt_matches);
    if (!re) return false;
    if (!re.test(prompt)) return false;
  }

  if (matches.tool_name !== undefined) {
    const allowed = arrayOf(matches.tool_name);
    if (allowed.length > 0) {
      if (!input.tool_name) return false;
      if (!allowed.includes(input.tool_name)) return false;
    }
  }


  if (matches.permission_mode !== undefined) {
    const allowed = arrayOf(matches.permission_mode);
    if (allowed.length > 0) {
      const mode = input.permission_mode || input.permissionMode;
      if (mode && !allowed.includes(mode)) return false;
    }
  }


  if (matches.permission_mode_not !== undefined) {
    const denied = arrayOf(matches.permission_mode_not);
    if (denied.length > 0) {
      const mode = input.permission_mode || input.permissionMode;
      if (mode && denied.includes(mode)) return false;
    }
  }

  if (matches.tool_args_match !== undefined) {
    const serialized =
      typeof input.tool_args === 'string'
        ? input.tool_args
        : JSON.stringify(input.tool_args ?? '');
    const re = compileHookRegex(matches.tool_args_match);
    if (!re) return false;
    if (!re.test(serialized)) return false;
  }

  if (matches.cwd_includes !== undefined) {
    const needles = arrayOf(matches.cwd_includes);
    if (needles.length > 0) {
      const hit = needles.some((n) => cwd.includes(n));
      if (!hit) return false;
    }
  }

  if (matches.project_has !== undefined) {
    const root = findProjectRoot(cwd);
    if (!root) return false;
    if (!fs.existsSync(path.join(root, matches.project_has))) return false;
  }

  if (matches.git_dirty !== undefined) {
    const dirty = isGitDirty(cwd);
    if (matches.git_dirty !== dirty) return false;
  }

  return true;
}
