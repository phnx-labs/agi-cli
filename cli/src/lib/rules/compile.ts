/** Rules file compilation: resolve @-imports into one flat file. Agents that don't natively resolve
 * `@path/to/file` (Codex, Cursor) need a pre-compiled file, for user scope (written into the
 * version home) and project scope (written into the workspace). */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import { AGENTS, agentConfigDirName } from '../agents.js';
import type { AgentId } from '../types.js';
import { getResolvedRulesDir, getVersionsDir, isReservedAgentsDir } from '../state.js';
import { composeRules, composeRulesFromState, type RulesLayer } from './compose.js';

const IMPORT_RE = /(^|\s)@(\S+)/g;
const MAX_DEPTH = 5;
/** Header that the non-@-import compile path (`agents refresh-rules` -> compileRulesForAgent)
 * prepends. Exported so `doctor-diff` can strip it before comparing a home rules file to the raw
 * preset composition; the header isn't source content. */
export const COMPILED_HEADER =
  '<!-- Auto-compiled by agents-cli from ~/.agents/rules/AGENTS.md + imports.\n' +
  '     Edit the source files under ~/.agents/rules/ — edits to this file will be overwritten on next sync. -->\n\n';

export const COMPILED_HEADER_PROJECT =
  '<!-- Auto-compiled by agents-cli from .agents/rules/AGENTS.md + imports.\n' +
  '     Edit the source files under .agents/rules/ — edits to this file will be overwritten on next sync. -->\n\n';

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

/** Replace fenced code blocks and inline code spans with placeholders, since Claude Code's @-import
 * parser ignores those regions and so must we. */
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

interface ResolveResult {
  content: string;
  sources: string[];
}

/** Expand `@path/to/file` imports recursively up to MAX_DEPTH, leaving fenced code and inline code
 * alone (as Claude Code does) and silently skipping missing files. Relative paths resolve against
 * `baseDir`; absolute and tilde paths from root/home. */
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

      if (seen.has(resolved)) return lead;
      if (!fs.existsSync(resolved)) return match;

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

/** Fast staleness check: true when the compiled file or manifest is missing, a recorded source is
 * missing, or a source's sha256 no longer matches. Always false for agents that resolve @-imports
 * natively (nothing to compile). */
export function isRulesStale(agentId: AgentId, version: string): boolean {
  if (supportsRulesImports(agentId)) return false;

  const compiledPath = getCompiledRulesPath(agentId, version);
  const manifestPath = getManifestPath(compiledPath);
  if (!fs.existsSync(compiledPath) || !fs.existsSync(manifestPath)) return true;

  try {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as CompileManifest;
    for (const src of manifest.sources) {
      if (!fs.existsSync(src.path)) return true;
      if (src.mtime !== undefined && src.size !== undefined) {
        const stat = fs.statSync(src.path);
        if (stat.mtimeMs === src.mtime && stat.size === src.size) continue;
      }
      if (sha256(fs.readFileSync(src.path, 'utf8')) !== src.sha256) return true;
    }
    return false;
  } catch {
    return true;
  }
}

/** Resolve the source `rules/AGENTS.md` with all @-imports expanded and write it into the version
 * home beside a sidecar manifest of source hashes for staleness detection. Agents resolving
 * @-imports natively are skipped (their sync uses copyFileSync in `syncResourcesToVersion`). */
function compileRulesForAgent(
  agentId: AgentId,
  version: string
): { compiled: boolean; compiledPath: string; sources: number } {
  if (supportsRulesImports(agentId)) {
    return { compiled: false, compiledPath: '', sources: 0 };
  }

  // Route through the layered composer (project > user > extras > system). The old code read only
  // the system AGENTS.md, dropping user/extras/project subrules for @-import-incapable agents
  // (Cursor, older Codex), so edits to ~/.agents/rules/subrules/ never arrived.
  let composed: ReturnType<typeof composeRulesFromState>;
  try {
    composed = composeRulesFromState({ preset: undefined });
  } catch {
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

/** Recompile rules if stale; safe on every agent invocation since the check is fast (sha256 of 8-10
 * small files, ~10-20ms). Returns true if a recompile happened. */
export function ensureRulesFresh(agentId: AgentId, version: string): boolean {
  if (supportsRulesImports(agentId)) return false;
  if (!isRulesStale(agentId, version)) return false;
  const result = compileRulesForAgent(agentId, version);
  return result.compiled;
}

interface ProjectCompileResult {
  compiled: boolean;
  agentsPath: string;
  symlinks: string[];
  sources: number;
  skippedClobber: string[];
}

/** Compile project-scope rules into a workspace's root memory files: compose all layers (project
 * highest), write `cwd/AGENTS.md` with COMPILED_HEADER_PROJECT, symlink CLAUDE.md etc. to it. A
 * file lacking our header is user-authored and left alone. No-op without `cwd/.agents/rules/`. */
export function compileRulesForProject(
  cwd: string,
  opts: { preset?: string; layers?: RulesLayer[] } = {}
): ProjectCompileResult {
  // Only files bearing our compiled header are mutable; authored instructions stay untouched.
  const projectRulesDir = path.join(cwd, '.agents', 'rules');

  const empty: ProjectCompileResult = {
    compiled: false, agentsPath: '', symlinks: [], sources: 0, skippedClobber: [],
  };

  if (!fs.existsSync(projectRulesDir)) return empty;

  // The user layer's home satisfies the rules-dir test (~/.agents/rules exists everywhere), which
  // compiled $HOME as a "project" and injected the ruleset twice (RUSH-2725). Reserved roots (user,
  // system, canonical DotAgents checkouts) never compile as a project.
  if (isReservedAgentsDir(path.join(cwd, '.agents'))) return empty;

  let composed: { content: string; subrules: { sourcePath: string }[] };
  try {
    const result = opts.layers
      ? composeRules({ preset: opts.preset, layers: opts.layers })
      : composeRulesFromState({ cwd, preset: opts.preset });
    composed = { content: result.content, subrules: result.subrules };
  } catch {
    return empty;
  }

  const newContent = COMPILED_HEADER_PROJECT + composed.content;

  const agentsPath = path.join(cwd, 'AGENTS.md');
  const skippedClobber: string[] = [];
  let compiled = false;
  let weOwnAgentsMd = false;

  let agentsLstat: fs.Stats | null = null;
  try { agentsLstat = fs.lstatSync(agentsPath); } catch {  }

  if (!agentsLstat) {
    fs.writeFileSync(agentsPath, newContent);
    compiled = true;
    weOwnAgentsMd = true;
  } else if (agentsLstat.isFile()) {
    let existing = '';
    try { existing = fs.readFileSync(agentsPath, 'utf8'); } catch {  }
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
    skippedClobber.push('AGENTS.md');
  }

  const symlinks: string[] = [];
  // Native instruction links are managed only when this compiler owns AGENTS.md.
  if (weOwnAgentsMd) {
    const seen = new Set<string>(['AGENTS.md']);
    for (const agent of Object.values(AGENTS)) {
      const fname = agent.instructionsFile;
      if (seen.has(fname)) continue;
      // Hard-deprecated agents (e.g. Gemini, retired by Google) never get an instruction-file
      // symlink; GEMINI.md would only litter the tree. Mirrors the `deprecated?.hard` skip in
      // capabilities.ts, MANAGED_AGENT_IDS and modes.ts.
      if (agent.deprecated?.hard) continue;
      if (fname.includes('/') || fname.includes('\\')) continue;
      seen.add(fname);

      const linkPath = path.join(cwd, fname);
      let lstat: fs.Stats | null = null;
      try { lstat = fs.lstatSync(linkPath); } catch {  }

      if (lstat) {
        if (lstat.isSymbolicLink()) {
          let target = '';
          try { target = fs.readlinkSync(linkPath); } catch {  }
          if (target === 'AGENTS.md') {
            symlinks.push(fname);
            continue;
          }
          skippedClobber.push(fname);
          continue;
        }
        skippedClobber.push(fname);
        continue;
      }

      try {
        fs.symlinkSync('AGENTS.md', linkPath);
        symlinks.push(fname);
      } catch {
        try {
          fs.copyFileSync(agentsPath, linkPath);
          symlinks.push(fname);
        } catch {
        }
      }
    }
  }

  return { compiled, agentsPath, symlinks, sources: composed.subrules.length, skippedClobber };
}
