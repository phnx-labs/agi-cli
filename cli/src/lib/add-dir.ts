/** Cross-harness application of project / `--add-dir` grants. By harness: `native-flag` (Claude,
 * Kimi, Cursor) repeatable `--add-dir`; `codex-policy` folds into workspace_roots; `grok-sandbox`
 * writes a project profile plus a `--rules` note; `none` ignores them. */

import * as fs from 'fs';
import * as path from 'path';
import type { AgentId } from './types.js';
import { expandLocalHome } from './project-root.js';

type AddDirStrategy = 'native-flag' | 'codex-policy' | 'grok-sandbox' | 'none';

/** How each harness consumes directory grants. Keep in lockstep with apply* below. */
export const ADD_DIR_STRATEGY: Record<AgentId, AddDirStrategy> = {
  claude: 'native-flag',
  kimi: 'native-flag',
  cursor: 'native-flag',
  codex: 'codex-policy',
  grok: 'grok-sandbox',
  // No multi-root CLI surface today (single --dir / project path).
  opencode: 'none',
  openclaw: 'none',
  copilot: 'none',
  amp: 'none',
  goose: 'none',
  antigravity: 'none',
  droid: 'none',
  hermes: 'none',
  muse: 'none',
  warp: 'none',
};

/** Expand `~` / `$HOME` and de-dupe, preserving order. */
export function normalizeAddDirs(dirs: string[] | undefined): string[] {
  if (!dirs?.length) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of dirs) {
    const expanded = expandLocalHome(raw);
    if (!expanded || seen.has(expanded)) continue;
    seen.add(expanded);
    out.push(expanded);
  }
  return out;
}

/** Append native `--add-dir` flags for harnesses that take them (Claude, Kimi, Cursor); call sites
 * route by ADD_DIR_STRATEGY. */
function appendNativeAddDirFlags(cmd: string[], dirs: string[]): void {
  for (const dir of dirs) {
    cmd.push('--add-dir', dir);
  }
}

/** Profile name written into `.grok/sandbox.toml` under the run cwd. */
export const GROK_PROJECT_SANDBOX_PROFILE = 'agents-project';

/** Active Grok sandbox profile from the env, or null when off, unset or devbox. Only `GROK_SANDBOX`
 * is read (config.toml profiles aren't visible on the CLI), so those runs get the rules note but
 * no custom widen. */
function grokActiveSandboxProfile(env: NodeJS.ProcessEnv = process.env): string | null {
  const raw = (env.GROK_SANDBOX ?? '').trim();
  if (!raw) return null;
  const lower = raw.toLowerCase();
  if (lower === 'off' || lower === 'devbox') return null;
  // Never extend our own managed profile (would recurse).
  if (lower === GROK_PROJECT_SANDBOX_PROFILE.toLowerCase()) return 'workspace';
  return raw;
}

/** Whether Grok's active sandbox needs a custom profile with extra read_write. */
export function grokNeedsSandboxWiden(env: NodeJS.ProcessEnv = process.env): boolean {
  return grokActiveSandboxProfile(env) !== null;
}

/** Ensure `.grok/sandbox.toml` defines `[profiles.agents-project]` with `read_write` for every
 * grant, extending the active base profile so `GROK_SANDBOX=strict` doesn't widen to `workspace`.
 * Returns the `--sandbox` profile name or null; idempotent, rewriting only the managed block. */
export function ensureGrokProjectSandboxProfile(
  cwd: string,
  dirs: string[],
  opts: { extendsBase?: string } = {},
): string | null {
  if (!dirs.length) return null;
  if (!cwd) return null;

  const base = opts.extendsBase ?? 'workspace';
  // Refuse to extend ourselves or an empty name.
  const extendsBase =
    !base || base.toLowerCase() === GROK_PROJECT_SANDBOX_PROFILE.toLowerCase()
      ? 'workspace'
      : base;

  const grokDir = path.join(cwd, '.grok');
  const sandboxPath = path.join(grokDir, 'sandbox.toml');

  const readWriteLines = dirs
    .map((d) => `  ${JSON.stringify(d)},`)
    .join('\n');

  const managedBlock = [
    '# BEGIN agents-cli managed — project multi-repo grants (do not edit by hand)',
    `[profiles.${GROK_PROJECT_SANDBOX_PROFILE}]`,
    `extends = ${JSON.stringify(extendsBase)}`,
    'read_write = [',
    readWriteLines,
    ']',
    '# END agents-cli managed',
    '',
  ].join('\n');

  let existing = '';
  try {
    existing = fs.readFileSync(sandboxPath, 'utf-8');
  } catch {
    // create fresh
  }

  const begin = '# BEGIN agents-cli managed';
  const end = '# END agents-cli managed';
  let next: string;
  const beginIdx = existing.indexOf(begin);
  const endIdx = existing.indexOf(end);
  if (beginIdx !== -1 && endIdx !== -1 && endIdx > beginIdx) {
    // Replace through end of the end-marker line
    const afterEnd = existing.indexOf('\n', endIdx);
    const endCut = afterEnd === -1 ? existing.length : afterEnd + 1;
    next = existing.slice(0, beginIdx) + managedBlock + existing.slice(endCut);
  } else if (existing.trim()) {
    // If a hand-written [profiles.agents-project] already exists without our
    // markers, refuse to append a second block with the same name.
    const bare = new RegExp(
      `\\[profiles\\.${GROK_PROJECT_SANDBOX_PROFILE}\\]`,
    );
    if (bare.test(existing)) {
      return null;
    }
    next = existing.replace(/\s*$/, '\n\n') + managedBlock;
  } else {
    next = managedBlock;
  }

  fs.mkdirSync(grokDir, { recursive: true });
  fs.writeFileSync(sandboxPath, next, 'utf-8');
  return GROK_PROJECT_SANDBOX_PROFILE;
}

/** Short rules blob so Grok's model treats sibling dirs as in scope; wording tracks whether the
 * sandbox was widened for write access. */
export function grokAddDirRules(dirs: string[], opts: { writeGranted?: boolean } = {}): string {
  const list = dirs.map((d) => `- ${d}`).join('\n');
  const access = opts.writeGranted === false
    ? 'intended as first-class workspace roots (OS sandbox may still restrict writes unless GROK_SANDBOX is set so agents-cli can widen it)'
    : 'read + write';
  return [
    `Project sibling directories (part of this multi-repo project; ${access}):`,
    list,
    'Treat these as first-class workspace roots alongside the primary cwd.',
  ].join('\n');
}

/** Apply directory grants on the argv for harnesses handled here (Codex is excluded; see
 * codexPolicyArgs). Returns true when any argv or on-disk change was made. */
export function applyAddDirs(
  agent: AgentId,
  cmd: string[],
  dirs: string[] | undefined,
  opts: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
): boolean {
  const normalized = normalizeAddDirs(dirs);
  if (normalized.length === 0) return false;

  const strategy = ADD_DIR_STRATEGY[agent];
  if (strategy === 'native-flag') {
    appendNativeAddDirFlags(cmd, normalized);
    return true;
  }

  if (strategy === 'grok-sandbox') {
    const env = opts.env ?? process.env;
    const activeBase = grokActiveSandboxProfile(env);
    let writeGranted = true; // default off sandbox = unrestricted FS
    if (activeBase) {
      const cwd = opts.cwd ?? process.cwd();
      const profile = ensureGrokProjectSandboxProfile(cwd, normalized, {
        extendsBase: activeBase,
      });
      if (profile) {
        // Drop a prior --sandbox <x> pair so the managed profile wins.
        for (let i = cmd.length - 2; i >= 0; i--) {
          if (cmd[i] === '--sandbox') {
            cmd.splice(i, 2);
          }
        }
        cmd.push('--sandbox', profile);
        writeGranted = true;
      } else {
        // Could not write the profile (e.g. hand-owned agents-project block).
        writeGranted = false;
      }
    }
    // Model awareness always — even when the OS sandbox is off.
    cmd.push('--rules', grokAddDirRules(normalized, { writeGranted }));
    return true;
  }

  // codex-policy / none — not applied here
  return false;
}

/** Whether this harness effectively consumes directory grants. */
export function supportsAddDir(agent: AgentId): boolean {
  const s = ADD_DIR_STRATEGY[agent];
  return s === 'native-flag' || s === 'codex-policy' || s === 'grok-sandbox';
}

/** One-line note for harnesses that ignore grants (used by callers that want to warn). */
export function addDirUnsupportedNote(agent: AgentId): string | null {
  if (supportsAddDir(agent)) return null;
  return (
    `${agent} has no multi-root / --add-dir surface; project sibling directory ` +
    `grants are ignored (cwd only). Claude, Codex, Cursor, Kimi, and Grok consume them.`
  );
}

