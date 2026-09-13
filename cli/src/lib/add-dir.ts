/**
 * Cross-harness application of project / `--add-dir` directory grants.
 *
 * A multi-repo project binds several checkouts; the primary becomes cwd and the
 * rest become grants so the agent can read and write the siblings. How a grant
 * lands depends on the harness:
 *
 * - `native-flag`  — Claude, Kimi, Cursor: repeatable `--add-dir <path>`
 * - `codex-policy` — Codex: folded into the named edit profile's workspace_roots
 *                    (handled in buildExecCommand / codex-policy, not here)
 * - `grok-sandbox` — Grok: OS sandbox is off by default (siblings already
 *                    writable); when a non-off sandbox is active, write a
 *                    project-local profile with `read_write` and select it.
 *                    Always appends a short `--rules` note so the model knows
 *                    the siblings are in scope.
 * - `none`         — harness has no multi-root surface; grants are ignored
 *                    (caller may warn). Not a configuration mistake — the CLI
 *                    has nowhere to put the grant.
 *
 * Capability honesty: only strategies that actually change the launch count as
 * support. Silent no-ops stay `none`.
 */

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
  gemini: 'none',
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

/**
 * Append native `--add-dir` flags for harnesses that take them (Claude, Kimi, Cursor).
 * No-op for other strategies — call sites route by ADD_DIR_STRATEGY.
 */
function appendNativeAddDirFlags(cmd: string[], dirs: string[]): void {
  for (const dir of dirs) {
    cmd.push('--add-dir', dir);
  }
}

/** Profile name written into `.grok/sandbox.toml` under the run cwd. */
export const GROK_PROJECT_SANDBOX_PROFILE = 'agents-project';

/**
 * Active Grok sandbox profile from the env, if a non-off profile is set.
 * Returns null when sandbox is off / unset / devbox (no widen needed).
 *
 * Only `GROK_SANDBOX` is consulted — a profile set only in config.toml is not
 * visible here (Grok does not expose it on the CLI), so those runs still get
 * the rules note but not a custom widen. Prefer env when launching sandboxed.
 */
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

/**
 * Ensure `.grok/sandbox.toml` under `cwd` defines `[profiles.agents-project]`
 * with `read_write` covering every grant, **extending the active base profile**
 * (so `GROK_SANDBOX=strict` does not silently widen to `workspace`).
 * Returns the profile name to pass as `--sandbox`, or null when not needed.
 *
 * Idempotent: rewrites only the managed profile block.
 */
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

/**
 * Short rules blob so Grok's model treats sibling dirs as in-scope.
 * Wording tracks whether we actually widened the sandbox for write access.
 */
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

/**
 * Apply directory grants on the argv for harnesses handled here.
 * Codex is intentionally excluded — its path lives next to codexPolicyArgs.
 *
 * @returns true when any argv / on-disk change was made for the grants
 */
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

