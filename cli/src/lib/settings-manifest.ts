/**
 * Settings carry-forward between version homes.
 *
 * Every installed version gets an isolated `home/`, so user-authored
 * preferences (settings.json, config.toml, keybindings, auth) written while
 * running one version do not exist in a freshly installed one. Resources
 * managed in ~/.agents/ (commands, skills, hooks, rules, MCP YAML, plugins,
 * subagents) are synced into every version home by syncResourcesToVersion and
 * are deliberately NOT listed here — copying them would fight that sync.
 *
 * The manifest below classifies the remaining per-agent files, and
 * carryForwardSettings() fills gaps in a target version home from a source
 * version home. It never overwrites a value the target already has: scalars
 * keep the target's value, objects merge recursively, arrays union. That makes
 * the operation idempotent and safe to run on every `agents add` / `agents use`.
 * (One scoped exception: the 'claude-trust' strategy promotes a stamped-default
 * `hasTrustDialogAccepted: false` to `true` — see the note on that entry.)
 */

import * as fs from 'fs';
import * as path from 'path';
import * as TOML from 'smol-toml';

import type { AgentId } from './types.js';
import { atomicWriteFileSync } from './fs-atomic.js';
import { getBackupsDir } from './state.js';

type MergeStrategy = 'json-merge' | 'toml-merge' | 'copy-if-absent' | 'dir-entries' | 'claude-trust';

interface ManifestEntry {
  /** Path relative to the version home (e.g. ".claude/settings.json"). */
  rel: string;
  strategy: MergeStrategy;
  /**
   * Top-level keys that are machine/onboarding state rather than user
   * preference — stripped from the source before merging so stale state
   * never propagates into a new version.
   */
  stateKeys?: string[];
  /** chmod the copied file to 0600 (credentials). */
  restrictMode?: boolean;
}

const SETTINGS_MANIFEST: Partial<Record<AgentId, ManifestEntry[]>> = {
  claude: [
    { rel: '.claude/settings.json', strategy: 'json-merge' },
    { rel: '.claude/settings.local.json', strategy: 'copy-if-absent' },
    { rel: '.claude/keybindings.json', strategy: 'copy-if-absent' },
    // `.claude.json` holds the login (oauthAccount) and per-session stats, so it
    // must never merge wholesale — but it is also where Claude records workspace
    // trust (`projects[<path>].hasTrustDialogAccepted`). Without carrying that,
    // every newly pinned version re-shows the trust dialog once per project
    // (issue #2776). The 'claude-trust' strategy projects ONLY the trust flags
    // out of the source file; credentials and stats stay per-version.
    { rel: '.claude.json', strategy: 'claude-trust' },
  ],
  codex: [
    {
      rel: '.codex/config.toml',
      strategy: 'toml-merge',
      stateKeys: ['notice', 'windows_wsl_setup_acknowledged'],
    },
    // `.codex/auth.json` is deliberately NOT carried forward. Copying it seeded
    // every new Codex version with the current default's ChatGPT token, so two
    // installed versions always reported the same account and could never sign
    // into separate accounts. Claude never merges `.claude.json` for the same
    // reason (its 'claude-trust' entry extracts only the trust flags) — a
    // version home holds its own login, keeping accounts per-version. A fresh
    // Codex version installs signed-out; run `codex login`
    // (or `agents run codex --version <v>`) inside it to authenticate.
    { rel: '.codex/instructions.md', strategy: 'copy-if-absent' },
    { rel: '.codex/hooks.json', strategy: 'copy-if-absent' },
    { rel: '.codex/prompts', strategy: 'dir-entries' },
    { rel: '.codex/rules', strategy: 'dir-entries' },
  ],
};

interface CarryForwardResult {
  /** Manifest rel paths that were created or updated in the target home. */
  applied: string[];
  /** Backup directory holding pre-merge copies of modified target files, if any. */
  backupDir?: string;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Fill gaps in `target` from `source` without overwriting target values:
 * missing keys are copied, plain objects recurse, and everything else —
 * scalars AND arrays — keeps the target's value. Arrays deliberately do not
 * union: other writers (factory sync, hooks registration) mutate array entries
 * in place, so a union would keep re-appending stale pre-mutation copies from
 * the source on every carry (e.g. a user hook duplicated after the system
 * hooks were merged into it). Returns a new object.
 */
export function fillGaps(
  target: Record<string, unknown>,
  source: Record<string, unknown>
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...target };
  for (const [key, sourceValue] of Object.entries(source)) {
    if (!(key in out)) {
      out[key] = sourceValue;
      continue;
    }
    const targetValue = out[key];
    if (isPlainObject(targetValue) && isPlainObject(sourceValue)) {
      out[key] = fillGaps(targetValue, sourceValue);
    }
    // scalar, array, or type mismatch: target wins
  }
  return out;
}

/**
 * Project paths the source `.claude.json` records an accepted trust dialog for.
 * Only an explicit `true` counts: Claude Code never persists a decline (the
 * dialog exits without writing), so `false` is only ever the stamped default —
 * not a user decision worth propagating. Verified against Claude Code
 * 2.1.219/2.1.220 (decline paths exit via code 1 / code 0 without a config
 * write); if a future Claude Code starts persisting declines, this premise —
 * and the false→true promotion in the 'claude-trust' case — must be revisited.
 */
function trustedClaudeProjects(source: Record<string, unknown>): string[] {
  const projects = isPlainObject(source.projects) ? source.projects : {};
  return Object.entries(projects)
    .filter(([, project]) => isPlainObject(project) && project.hasTrustDialogAccepted === true)
    .map(([projectPath]) => projectPath);
}

function stripStateKeys(
  obj: Record<string, unknown>,
  stateKeys: string[] | undefined
): Record<string, unknown> {
  if (!stateKeys?.length) return obj;
  const out = { ...obj };
  for (const key of stateKeys) delete out[key];
  return out;
}

function backupFile(backupRoot: string, home: string, rel: string): void {
  const src = path.join(home, rel);
  const dest = path.join(backupRoot, rel);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
}

/**
 * Carry user settings forward from one version home into another. Both paths
 * are version-home roots (the directory containing `.claude/` / `.codex/`).
 * Only fills gaps — never overwrites target values — so it is idempotent.
 */
export function carryForwardSettings(
  agent: AgentId,
  fromHome: string,
  toHome: string
): CarryForwardResult {
  const manifest = SETTINGS_MANIFEST[agent];
  const result: CarryForwardResult = { applied: [] };
  if (!manifest || !fs.existsSync(fromHome) || fromHome === toHome) return result;

  const backupRoot = path.join(
    getBackupsDir(),
    'settings-carry',
    agent,
    new Date().toISOString().replace(/[:.]/g, '-')
  );

  for (const entry of manifest) {
    const sourcePath = path.join(fromHome, entry.rel);
    const targetPath = path.join(toHome, entry.rel);
    if (!fs.existsSync(sourcePath)) continue;

    try {
      switch (entry.strategy) {
        case 'copy-if-absent': {
          if (fs.existsSync(targetPath)) break;
          fs.mkdirSync(path.dirname(targetPath), { recursive: true });
          fs.copyFileSync(sourcePath, targetPath);
          if (entry.restrictMode) fs.chmodSync(targetPath, 0o600);
          result.applied.push(entry.rel);
          break;
        }
        case 'dir-entries': {
          if (!fs.statSync(sourcePath).isDirectory()) break;
          let copied = false;
          fs.mkdirSync(targetPath, { recursive: true });
          for (const name of fs.readdirSync(sourcePath)) {
            const childTarget = path.join(targetPath, name);
            if (fs.existsSync(childTarget)) continue;
            fs.cpSync(path.join(sourcePath, name), childTarget, { recursive: true });
            copied = true;
          }
          if (copied) result.applied.push(entry.rel);
          break;
        }
        case 'claude-trust': {
          // Projection, not a merge: pull ONLY `projects[<path>].hasTrustDialogAccepted`
          // out of the source `.claude.json`. Everything else in that file
          // (oauthAccount, onboarding state, per-session stats) stays per-version.
          // Trust granted anywhere wins over the target's stamped-default `false`
          // (headless runs create project entries with the flag unset-as-false
          // without ever showing the dialog), but a target entry's other keys
          // are preserved untouched.
          const source = JSON.parse(fs.readFileSync(sourcePath, 'utf-8')) as Record<string, unknown>;
          const trusted = trustedClaudeProjects(source);
          if (trusted.length === 0) break;

          const targetExists = fs.existsSync(targetPath);
          const parsedTarget: unknown = targetExists
            ? JSON.parse(fs.readFileSync(targetPath, 'utf-8'))
            : {};
          // A target that isn't an object (or whose `projects` isn't) is not
          // ours to repair — skip rather than clobber it with a rebuilt shape.
          if (!isPlainObject(parsedTarget)) break;
          const targetObj = parsedTarget;
          if ('projects' in targetObj && !isPlainObject(targetObj.projects)) break;
          const targetProjects = isPlainObject(targetObj.projects) ? { ...targetObj.projects } : {};
          let changed = false;
          for (const projectPath of trusted) {
            const existing = isPlainObject(targetProjects[projectPath])
              ? targetProjects[projectPath] as Record<string, unknown>
              : {};
            if (existing.hasTrustDialogAccepted === true) continue;
            targetProjects[projectPath] = { ...existing, hasTrustDialogAccepted: true };
            changed = true;
          }
          if (!changed) break;

          if (targetExists) {
            backupFile(backupRoot, toHome, entry.rel);
            result.backupDir = backupRoot;
          } else {
            fs.mkdirSync(path.dirname(targetPath), { recursive: true });
          }
          // Atomic (tmp + rename): a running Claude session rewrites this exact
          // file (it holds the login and session stats), so a plain write risks
          // a reader seeing a partial file. The OUTSIDE `.claude.json` is the
          // real file (the INSIDE `.claude/.claude.json` symlink resolves to it
          // and survives the rename).
          atomicWriteFileSync(
            targetPath,
            JSON.stringify({ ...targetObj, projects: targetProjects }, null, 2) + '\n'
          );
          result.applied.push(entry.rel);
          break;
        }
        case 'json-merge':
        case 'toml-merge': {
          const parse = entry.strategy === 'json-merge'
            ? (text: string) => JSON.parse(text) as Record<string, unknown>
            : (text: string) => TOML.parse(text) as Record<string, unknown>;
          const stringify = entry.strategy === 'json-merge'
            ? (obj: Record<string, unknown>) => JSON.stringify(obj, null, 2) + '\n'
            : (obj: Record<string, unknown>) => TOML.stringify(obj as never) + '\n';

          const source = stripStateKeys(parse(fs.readFileSync(sourcePath, 'utf-8')), entry.stateKeys);

          if (!fs.existsSync(targetPath)) {
            if (Object.keys(source).length === 0) break;
            fs.mkdirSync(path.dirname(targetPath), { recursive: true });
            fs.writeFileSync(targetPath, stringify(source), 'utf-8');
            result.applied.push(entry.rel);
            break;
          }

          const targetText = fs.readFileSync(targetPath, 'utf-8');
          const targetObj = parse(targetText);
          const merged = fillGaps(targetObj, source);
          // Compare parsed content, not text: other writers format differently,
          // and a semantic no-op must not trigger a rewrite/backup every switch.
          if (JSON.stringify(merged) === JSON.stringify(targetObj)) break;

          backupFile(backupRoot, toHome, entry.rel);
          result.backupDir = backupRoot;
          fs.writeFileSync(targetPath, stringify(merged), 'utf-8');
          result.applied.push(entry.rel);
          break;
        }
      }
    } catch {
      // A malformed source or target file must not break install/use.
      // Leave the target untouched for this entry and move on.
    }
  }

  return result;
}
