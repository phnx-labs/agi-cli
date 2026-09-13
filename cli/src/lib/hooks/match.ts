/**
 * Hook predicate evaluator.
 *
 * Evaluates the optional `matches:` block on a hook manifest entry against
 * the runtime input passed by the agent CLI on a hook event. All declared
 * predicates AND together — the hook fires only if every one passes.
 *
 * Empty/missing matches => always passes (backward compat with hooks
 * authored before predicate support).
 *
 * Used at hook-fire time by either:
 *   (a) generated hook wrappers we install alongside the script, or
 *   (b) the script itself, by calling shouldFire() with parsed JSON input.
 */

import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
import type { HookMatches } from '../types.js';

/** Runtime context passed to a hook by the agent CLI. */
interface HookInput {
  hook_event_name?: string;
  prompt?: string;
  tool_name?: string;
  tool_args?: unknown;
  cwd?: string;
  permission_mode?: string;
  /** Grok-style camelCase spelling of permission_mode. */
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

/**
 * Decide whether a hook with the given match config should fire on this input.
 * Pure function — no side effects, no IO except git/cwd checks for predicates
 * that explicitly require them.
 *
 * Returns true if the hook should fire (all declared predicates pass), false
 * if it should be skipped.
 */
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
      // Fail-open on absence: only some harnesses (Claude Code) report the
      // live mode. An input with no mode field passes; an explicit value not
      // in the allowed list skips.
      const mode = input.permission_mode || input.permissionMode;
      if (mode && !allowed.includes(mode)) return false;
    }
  }

  if (matches.permission_mode_not !== undefined) {
    const denied = arrayOf(matches.permission_mode_not);
    if (denied.length > 0) {
      // The negative form exists because the positive one cannot express
      // "everywhere except plan" without enumerating every other mode — and an
      // enumeration silently stops firing the moment a harness adds or renames
      // one, which for a guard means it quietly stops guarding. Naming the mode
      // to skip keeps every unknown mode firing, so the failure direction is
      // "ran unnecessarily", never "did not run".
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
