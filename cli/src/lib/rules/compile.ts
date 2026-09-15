/**
 * Rules file compilation -- resolving @-imports into a single flat file.
 *
 * Agents that do not natively resolve `@path/to/file` imports (Codex, Cursor)
 * need a pre-compiled rules file with all imports inlined. This module
 * handles that expansion for both user-scope (writes into version home) and
 * project-scope (writes into the workspace).
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import { AGENTS, agentConfigDirName } from '../agents.js';
import type { AgentId } from '../types.js';
import { getResolvedRulesDir, getVersionsDir, isReservedAgentsDir } from '../state.js';
import { composeRules, composeRulesFromState, type RulesLayer } from './compose.js';

// Match `@path` preceded by start-of-string or whitespace. This avoids
// matching emails ("foo@bar.com") and the middle of words. The leading
// whitespace (if any) is captured so we can preserve it in the output.
const IMPORT_RE = /(^|\s)@(\S+)/g;
const MAX_DEPTH = 5;
/**
 * Header the non-@-import compile path (`agents refresh-rules` → compileRulesForAgent)
 * prepends to a compiled instruction file. Exported so `doctor-diff` can strip it
 * before content-comparing a home rules file against the raw preset composition —
 * a header-compiled home must still reconcile (the header is not source content).
 */
export const COMPILED_HEADER =
  '<!-- Auto-compiled by agents-cli from ~/.agents/rules/AGENTS.md + imports.\n' +
  '     Edit the source files under ~/.agents/rules/ — edits to this file will be overwritten on next sync. -->\n\n';

export const COMPILED_HEADER_PROJECT =
  '<!-- Auto-compiled by agents-cli from .agents/rules/AGENTS.md + imports.\n' +
  '     Edit the source files under .agents/rules/ — edits to this file will be overwritten on next sync. -->\n\n';

/** Sidecar manifest recording source file hashes for staleness detection. */
interface CompileManifest {
  compiledAt: string;
  sources: { path: string; sha256: string; mtime?: number; size?: number }[];
}

function expandTilde(p: string): string {
  if (p === '~') return os.homedir();
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return p;
}

function sha256(content: string): string {
  return crypto.createHash('sha256').update(content).digest('hex');
}

/**
 * Replace fenced code blocks (```...```) and inline code spans (`...`) with
 * placeholders. Claude Code's @-import parser ignores these regions, so we
 * must too.
 */
function protectCodeRegions(content: string): { protectedText: string; fences: string[]; inlines: string[] } {
  const fences: string[] = [];
  let withFences = content.replace(/```[\s\S]*?```/g, (match) => {
    fences.push(match);
    return `\x00FENCE_${fences.length - 1}\x00`;
  });
  const inlines: string[] = [];
  withFences = withFences.replace(/`[^`\n]+`/g, (match) => {
    inlines.push(match);
    return `\x00INLINE_${inlines.length - 1}\x00`;
  });
  return { protectedText: withFences, fences, inlines };
}

function restoreCodeRegions(content: string, fences: string[], inlines: string[]): string {
  let restored = content.replace(/\x00INLINE_(\d+)\x00/g, (_, i) => inlines[Number(i)]);
  restored = restored.replace(/\x00FENCE_(\d+)\x00/g, (_, i) => fences[Number(i)]);
  return restored;
}

/** Result of resolving @-imports in a rules file. */
interface ResolveResult {
  /** Fully-inlined content. */
  content: string;
  /** Absolute paths of every file read during resolution (including the root). */
  sources: string[];
}

/**
 * Expand all `@path/to/file` imports in `content`, recursively up to
 * MAX_DEPTH. Imports inside fenced code blocks and inline code spans are
 * left alone, matching Claude Code's parser. Missing files are left as-is
 * (silent skip), matching the documented behavior.
 *
 * Relative paths resolve against `baseDir`; absolute and tilde-prefixed
 * paths resolve against the filesystem root / home directory.
 */
export function resolveImports(content: string, baseDir: string): ResolveResult {
  const sources: string[] = [];
  const seen = new Set<string>();

  function expand(text: string, currentDir: string, depth: number): string {
    if (depth > MAX_DEPTH) return text;

    const { protectedText, fences, inlines } = protectCodeRegions(text);

    const expanded = protectedText.replace(IMPORT_RE, (match, lead: string, rawPath: string) => {
      const tildeExpanded = expandTilde(rawPath);
      const resolved = path.isAbsolute(tildeExpanded)
        ? tildeExpanded
        : path.resolve(currentDir, tildeExpanded);

      if (seen.has(resolved)) return lead; // cycle break — keep leading whitespace
      if (!fs.existsSync(resolved)) return match; // preserve literal including lead

      seen.add(resolved);
      sources.push(resolved);
      const body = fs.readFileSync(resolved, 'utf8');
      return lead + expand(body, path.dirname(resolved), depth + 1);
    });

    return restoreCodeRegions(expanded, fences, inlines);
  }

  const result = expand(content, baseDir, 0);
  return { content: result, sources };
}

/** True if the agent's native runtime resolves `@path` imports in its rules file. */
export function supportsRulesImports(agentId: AgentId): boolean {
  return !!AGENTS[agentId].capabilities.rulesImports;
}

function getCompiledRulesPath(agentId: AgentId, version: string): string {
  const agentConfig = AGENTS[agentId];
  const versionHome = path.join(getVersionsDir(), agentId, version, 'home');
  return path.join(versionHome, agentConfigDirName(agentId), agentConfig.instructionsFile);
}

function getManifestPath(compiledPath: string): string {
  return compiledPath + '.manifest.json';
}

/**
 * Fast staleness check. Returns true when:
 *  - the compiled file or its manifest is missing
 *  - any recorded source file is missing
 *  - any recorded source's sha256 no longer matches
 *
 * For agents that support @-imports natively, always returns false — there's
 * nothing to compile.
 */
export function isRulesStale(agentId: AgentId, version: string): boolean {
  if (supportsRulesImports(agentId)) return false;

  const compiledPath = getCompiledRulesPath(agentId, version);
  const manifestPath = getManifestPath(compiledPath);
  if (!fs.existsSync(compiledPath) || !fs.existsSync(manifestPath)) return true;

  try {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as CompileManifest;
    for (const src of manifest.sources) {
      if (!fs.existsSync(src.path)) return true;
      // Tier 1: mtime+size fast path (no file read needed)
      if (src.mtime !== undefined && src.size !== undefined) {
        const stat = fs.statSync(src.path);
        if (stat.mtimeMs === src.mtime && stat.size === src.size) continue;
      }
      // Tier 2: content hash
      if (sha256(fs.readFileSync(src.path, 'utf8')) !== src.sha256) return true;
    }
    return false;
  } catch {
    return true;
  }
}

/**
 * Resolve the source `rules/AGENTS.md` (with all @-imports expanded) and
 * write the result into the version home, alongside a sidecar manifest that
 * records source file hashes for staleness detection.
 *
 * Agents that natively resolve @-imports are skipped (no-op) — their sync
 * uses the standard copyFileSync path in `syncResourcesToVersion`.
 */
function compileRulesForAgent(
  agentId: AgentId,
  version: string
): { compiled: boolean; compiledPath: string; sources: number } {
  if (supportsRulesImports(agentId)) {
    return { compiled: false, compiledPath: '', sources: 0 };
  }

  // Route through the layered composer (project > user > extras > system).
  // The previous implementation read only `<systemRules>/AGENTS.md` and
  // inlined its @-imports — that dropped user/extras/project subrules
  // entirely for @-import-incapable agents (Cursor, older Codex), so
  // updates to ~/.agents/rules/subrules/ never reached the version home.
  // composeRulesFromState already returns the concatenated content with
  // every fragment resolved across layers; we just need to record the
  // composed source list for staleness detection.
  let composed: ReturnType<typeof composeRulesFromState>;
  try {
    composed = composeRulesFromState({ preset: undefined });
  } catch {
    // No rules.yaml in any layer, or the default preset is missing — leave
    // the version home untouched (matches the previous file-missing branch).
    return { compiled: false, compiledPath: '', sources: 0 };
  }

  const newContent = COMPILED_HEADER + composed.content;

  const compiledPath = getCompiledRulesPath(agentId, version);
  fs.mkdirSync(path.dirname(compiledPath), { recursive: true });

  const existing = fs.existsSync(compiledPath) ? fs.readFileSync(compiledPath, 'utf8') : null;
  if (existing === newContent) {
    return { compiled: false, compiledPath, sources: 0 };
  }

  fs.writeFileSync(compiledPath, newContent);

  // Track every concrete subrule file the composer included as a source for
  // staleness. composeRulesFromState exposes sourcePath on each ComposedSubrule.
  const allSources = composed.subrules.map(s => s.sourcePath);
  const manifest: CompileManifest = {
    compiledAt: new Date().toISOString(),
    sources: allSources.map(p => {
      const content = fs.readFileSync(p, 'utf8');
      const stat = fs.statSync(p);
      return { path: p, sha256: sha256(content), mtime: stat.mtimeMs, size: stat.size };
    }),
  };
  fs.writeFileSync(getManifestPath(compiledPath), JSON.stringify(manifest, null, 2));

  return { compiled: true, compiledPath, sources: allSources.length };
}

/**
 * Recompile rules if stale. Safe to call on every agent invocation — the
 * staleness check is fast (sha256 of 8-10 small files, ~10-20ms). Returns
 * true if a recompile happened, false otherwise.
 */
export function ensureRulesFresh(agentId: AgentId, version: string): boolean {
  if (supportsRulesImports(agentId)) return false;
  if (!isRulesStale(agentId, version)) return false;
  const result = compileRulesForAgent(agentId, version);
  return result.compiled;
}

interface ProjectCompileResult {
  /** True when cwd/AGENTS.md was newly written or rewritten. */
  compiled: boolean;
  /** Absolute path to cwd/AGENTS.md. Empty when no project rules dir was present. */
  agentsPath: string;
  /** Per-agent instruction filenames symlinked (or copied) to AGENTS.md. */
  symlinks: string[];
  /** Number of source files inlined (root + recursive @-imports). */
  sources: number;
  /** Per-agent files we left alone because the user wrote/owns them. */
  skippedClobber: string[];
}

/**
 * Compile project-scope rules into a workspace's root memory files so each
 * agent's native loader picks them up.
 *
 * Composes rules from all available layers (project > user > extras > system)
 * with project highest priority — so a project's `subrules/` and `rules.yaml`
 * shadow user/system fragments and presets. Writes `cwd/AGENTS.md` with
 * COMPILED_HEADER_PROJECT and creates symlinks (CLAUDE.md, GEMINI.md,
 * .cursorrules, etc.) → AGENTS.md so every agent finds its expected file at
 * cwd. The agent's own loader merges this project-level file with its
 * user-level rules (in version home) at runtime.
 *
 * Don't-clobber guard: if `cwd/AGENTS.md` exists without our header, the user
 * authored it — leave it alone and report via `skippedClobber`. Same for any
 * pre-existing per-agent file or symlink that doesn't already point at
 * AGENTS.md.
 *
 * No-op when `cwd/.agents/rules/` does not exist. Idempotent on repeated
 * calls — content equality short-circuits the write.
 */
export function compileRulesForProject(
  cwd: string,
  opts: { preset?: string; layers?: RulesLayer[] } = {}
): ProjectCompileResult {
  const projectRulesDir = path.join(cwd, '.agents', 'rules');

  const empty: ProjectCompileResult = {
    compiled: false, agentsPath: '', symlinks: [], sources: 0, skippedClobber: [],
  };

  if (!fs.existsSync(projectRulesDir)) return empty;

  // The user layer's own home satisfies the rules-dir test — ~/.agents/rules
  // exists on every configured machine — which compiled $HOME as a "project",
  // wrote ~/AGENTS.md (+ per-agent symlinks), and injected the whole ruleset
  // into every session twice: once as global memory, once as "project" memory
  // (RUSH-2725). Reserved roots (user layer, system layer, or a checkout of
  // either canonical DotAgents repo) never compile as a project.
  if (isReservedAgentsDir(path.join(cwd, '.agents'))) return empty;

  let composed: { content: string; subrules: { sourcePath: string }[] };
  try {
    // Tests inject `layers` to isolate from real ~/.agents-system / ~/.agents
    // state. Production callers omit it and compose from discovered state.
    const result = opts.layers
      ? composeRules({ preset: opts.preset, layers: opts.layers })
      : composeRulesFromState({ cwd, preset: opts.preset });
    composed = { content: result.content, subrules: result.subrules };
  } catch {
    // Composer threw (no preset, malformed yaml). Don't write a half-baked
    // file — bail out cleanly, same as if the rules dir didn't exist.
    return empty;
  }

  const newContent = COMPILED_HEADER_PROJECT + composed.content;

  const agentsPath = path.join(cwd, 'AGENTS.md');
  const skippedClobber: string[] = [];
  let compiled = false;
  let weOwnAgentsMd = false;

  let agentsLstat: fs.Stats | null = null;
  try { agentsLstat = fs.lstatSync(agentsPath); } catch { /* missing */ }

  if (!agentsLstat) {
    fs.writeFileSync(agentsPath, newContent);
    compiled = true;
    weOwnAgentsMd = true;
  } else if (agentsLstat.isFile()) {
    let existing = '';
    try { existing = fs.readFileSync(agentsPath, 'utf8'); } catch { /* unreadable */ }
    if (existing.startsWith(COMPILED_HEADER_PROJECT)) {
      if (existing !== newContent) {
        fs.writeFileSync(agentsPath, newContent);
        compiled = true;
      }
      weOwnAgentsMd = true;
    } else {
      skippedClobber.push('AGENTS.md');
    }
  } else {
    // Symlink or other non-regular file — treat as user-owned, do not clobber
    skippedClobber.push('AGENTS.md');
  }

  // Per-agent symlinks. Only attempt when we own AGENTS.md — never create a
  // dangling symlink to a file we couldn't write.
  const symlinks: string[] = [];
  if (weOwnAgentsMd) {
    const seen = new Set<string>(['AGENTS.md']);
    for (const agent of Object.values(AGENTS)) {
      const fname = agent.instructionsFile;
      if (seen.has(fname)) continue;
      // Hard-deprecated agents (e.g. Gemini, retired by Google) never get an
      // instruction-file symlink — the harness is gone, so GEMINI.md would only
      // litter the tree. Mirrors the deprecated?.hard skip used everywhere else
      // (capabilities.ts, MANAGED_AGENT_IDS, modes.ts).
      if (agent.deprecated?.hard) continue;
      // Skip agents whose instructions live at a nested path (e.g. OpenClaw's
      // workspace/AGENTS.md) — those are managed by their own setup paths.
      if (fname.includes('/') || fname.includes('\\')) continue;
      seen.add(fname);

      const linkPath = path.join(cwd, fname);
      let lstat: fs.Stats | null = null;
      try { lstat = fs.lstatSync(linkPath); } catch { /* missing */ }

      if (lstat) {
        if (lstat.isSymbolicLink()) {
          let target = '';
          try { target = fs.readlinkSync(linkPath); } catch { /* unreadable */ }
          if (target === 'AGENTS.md') {
            symlinks.push(fname);
            continue;
          }
          skippedClobber.push(fname);
          continue;
        }
        // Regular file — user authored
        skippedClobber.push(fname);
        continue;
      }

      try {
        fs.symlinkSync('AGENTS.md', linkPath);
        symlinks.push(fname);
      } catch {
        // Filesystems that disallow symlinks (some Windows configs) — fall
        // back to a copy. The agent reads the same content either way.
        try {
          fs.copyFileSync(agentsPath, linkPath);
          symlinks.push(fname);
        } catch {
          // Give up on this one quietly; the agent that needs this filename
          // will fall back to its own discovery rules.
        }
      }
    }
  }

  return { compiled, agentsPath, symlinks, sources: composed.subrules.length, skippedClobber };
}
