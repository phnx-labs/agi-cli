import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { AGENTS, agentConfigDirName, isAgentHardDeprecated } from './agents.js';
import { supports } from './capabilities.js';
import { buildCommandSkillContent, commandSkillName, readSkillSourceCommandMarker, shouldAlsoInstallCommandAsSkill, shouldInstallCommandAsSkill } from './command-skills.js';
import { commandAppliesTo, parseCommandMetadata } from './commands.js';
import { markdownToToml } from './convert.js';
import { safeJoin } from './paths.js';
import { subagentTarget } from './subagents-registry.js';
import { parseSubagentFrontmatter } from './subagents.js';
import type { AgentId, InstalledSubagent } from './types.js';
import { syncWorkflowToVersion } from './workflows-registry.js';

const MANIFEST_FILE = '.agents-managed.json';
const MANIFEST_VERSION = 1;
const COPY_IGNORE = new Set(['.DS_Store', '.git', '.gitignore', '.venv', '__pycache__', 'node_modules']);

interface ProjectManagedManifest {
  v: typeof MANIFEST_VERSION;
  paths: string[];
}

interface ProjectResourceSyncResult {
  synced: string[];
  skipped: string[];
}

type ProjectKind = 'commands' | 'skills' | 'subagents' | 'workflows';

function projectAgentRoot(projectRoot: string, agent: AgentId): string {
  return path.join(projectRoot, agentConfigDirName(agent));
}

export function syncProjectResourcesToAgent(
  agent: AgentId,
  version: string,
  projectAgentsDir: string,
): ProjectResourceSyncResult {
  if (isAgentHardDeprecated(agent)) {
    return { synced: [], skipped: [] };
  }

  const projectRoot = path.dirname(projectAgentsDir);
  const agentRoot = projectAgentRoot(projectRoot, agent);
  const manifest = loadProjectManifest(agentRoot);
  const result: ProjectResourceSyncResult = { synced: [], skipped: [] };
  const next = new Set<string>();

  if (manifest) {
    for (const rel of manifest.paths) removeManagedPath(agentRoot, rel);
  }

  syncProjectCommands(agent, version, projectAgentsDir, agentRoot, result, next);
  syncProjectSkills(agent, version, projectAgentsDir, agentRoot, result, next);
  syncProjectSubagents(agent, version, projectAgentsDir, projectRoot, agentRoot, result, next);
  syncProjectWorkflows(agent, version, projectAgentsDir, projectRoot, agentRoot, result, next);

  // Launch-time copies are clone-local: manifest-owned paths go to Git's
  // per-clone exclude, never the tracked .gitignore.
  if (next.size > 0 || manifest) {
    writeProjectManifest(agentRoot, Array.from(next).sort());
    // The sync is a code generator whose per-harness dir would dirty `git status`, so it owns an
    // ignore block in `.git/info/exclude`, not the tracked `.gitignore`, which left a permanent `M
    // .gitignore` blocking `git pull` (PHNX-3718, PHNX-3717).
    reconcileManagedIgnore(projectRoot, agent, agentRoot, Array.from(next).sort());
  }

  return result;
}

function loadProjectManifest(agentRoot: string): ProjectManagedManifest | null {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(agentRoot, MANIFEST_FILE), 'utf-8')) as ProjectManagedManifest;
    if (raw.v !== MANIFEST_VERSION || !Array.isArray(raw.paths)) return null;
    if (!raw.paths.every((p) => typeof p === 'string' && p.length > 0)) return null;
    return { ...raw, paths: raw.paths.map(toPosixRel) };
  } catch {
    return null;
  }
}

function writeProjectManifest(agentRoot: string, paths: string[]): void {
  fs.mkdirSync(agentRoot, { recursive: true });
  const p = path.join(agentRoot, MANIFEST_FILE);
  const tmp = p + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify({ v: MANIFEST_VERSION, paths }, null, 2));
  fs.renameSync(tmp, p);
}

const GITIGNORE_MARKER = 'agents-cli project resources';

function gitignoreMarkers(agent: AgentId): { begin: string; end: string } {
  return {
    begin: `# >>> ${GITIGNORE_MARKER}: ${agent} (generated on launch — do not edit) >>>`,
    end: `# <<< ${GITIGNORE_MARKER}: ${agent} <<<`,
  };
}

/** Turn the manifest's managed paths into anchored POSIX ignore entries relative to `referenceRoot`
 * (the worktree root for info/exclude). Drops paths escaping the harness dir (grok, PHNX-3718); the
 * manifest holds only sync-generated paths, so committed files are never masked. */
export function managedGitignoreEntries(agentRoot: string, referenceRoot: string, managed: string[]): string[] {
  // Ignore only manifest-owned paths inside the harness root, anchored to the worktree.
  const root = path.resolve(agentRoot);
  const entries = new Set<string>();
  for (const rel of managed) {
    if (path.isAbsolute(rel)) continue;
    const abs = path.resolve(agentRoot, rel);
    if (abs !== root && !abs.startsWith(root + path.sep)) continue;
    const fromRoot = toPosixRel(path.relative(referenceRoot, abs));
    if (!fromRoot || fromRoot === '..' || fromRoot.startsWith('../')) continue;
    entries.add('/' + fromRoot);
  }
  return Array.from(entries).sort();
}

interface GitExcludeTarget {
  excludePath: string;
  worktreeRoot: string;
}

/** Ask git (one `rev-parse`) for the per-clone ignore file and worktree top: normal repo, monorepo
 * subdir, or linked worktree/submodule (shared common dir via `--git-path info/exclude`).
 * `--path-format=absolute` forces absolute paths. Null outside a git repo (fails open). */
function resolveGitExcludeTarget(dir: string): GitExcludeTarget | null {
  // Git resolves common-dir/worktree layout; guessing .git breaks linked worktrees and submodules.
  // Non-absolute output fails open rather than writing an uncertain path.
  try {
    const out = execFileSync(
      'git',
      ['-C', dir, 'rev-parse', '--path-format=absolute', '--git-path', 'info/exclude', '--show-toplevel'],
      { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] },
    );
    const [excludePath, worktreeRoot] = out.split('\n').map((l) => l.trim());
    if (!excludePath || !worktreeRoot) return null;
    // Fail open unless both are ABSOLUTE paths: git older than 2.31 echoes the unknown
    // `--path-format` flag on stdout, shifting the parse so mkdirSync creates a stray
    // `--path-format=absolute` dir.
    if (!path.isAbsolute(excludePath) || !path.isAbsolute(worktreeRoot)) return null;
    return { excludePath, worktreeRoot };
  } catch {
    return null;
  }
}

function isTrackedByGit(dir: string, absPath: string): boolean {
  try {
    execFileSync('git', ['-C', dir, 'ls-files', '--error-unmatch', '--', absPath], {
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    return true;
  } catch {
    return false;
  }
}

/** Apply this agent's managed block to ignore-file content IN PLACE (also strips a legacy block from
 * `.gitignore` when entries is `[]`). Replace, not append: appending would move the block behind
 * other agents' on each resync and rewrite the file every launch. Null for an unparseable block. */
function applyManagedBlock(content: string, begin: string, end: string, entries: string[]): string | null {
  // Replace blocks in place for convergence. An orphan begin marker is corruption,
  // so never treat the user's remaining excludes as managed content.
  const lines = content.split('\n');
  const bi = lines.indexOf(begin);
  if (bi !== -1) {
    const ei = lines.indexOf(end, bi + 1);
    if (ei === -1) return null;
    if (entries.length > 0) {
      return [...lines.slice(0, bi), begin, ...entries, end, ...lines.slice(ei + 1)].join('\n');
    }
    // Prune the block, tidying hugging blank lines. Unreached on the reconcileManagedIgnore path
    // (entries include the manifest), but load-bearing for stripLegacyManagedGitignoreBlock, which
    // passes entries=[].
    const before = lines.slice(0, bi);
    const after = lines.slice(ei + 1);
    while (before.length && before[before.length - 1].trim() === '') before.pop();
    while (after.length && after[0].trim() === '') after.shift();
    const rest = [...before, ...after].join('\n').replace(/\n+$/, '');
    return rest.length > 0 ? `${rest}\n` : '';
  }
  if (entries.length === 0) return content;
  const body = content.replace(/\n+$/, '');
  const block = [begin, ...entries, end].join('\n');
  return body.length > 0 ? `${body}\n\n${block}\n` : `${block}\n`;
}

/** Reconcile a per-agent managed block in `.git/info/exclude` so the generated harness dir never
 * shows untracked, without dirtying `.gitignore`. Idempotent; written only on change; fails open
 * outside git. Self-heals PHNX-3717's `.gitignore` blocks (PHNX-3718). */
function reconcileManagedIgnore(
  projectRoot: string,
  agent: AgentId,
  agentRoot: string,
  managed: string[],
): void {
  stripLegacyManagedGitignoreBlock(projectRoot, agent);

  const target = resolveGitExcludeTarget(projectRoot);
  if (!target) return;

  const { begin, end } = gitignoreMarkers(agent);
  // Ignore the manifest marker file too: the sync always writes `<agentRoot>/.agents-managed.json`,
  // which otherwise keeps the harness dir untracked. Same anchoring and escape guard, anchored to
  // the worktree root.
  const entries = managedGitignoreEntries(agentRoot, target.worktreeRoot, [MANIFEST_FILE, ...managed]);

  let original = '';
  try {
    original = fs.readFileSync(target.excludePath, 'utf-8');
  } catch {
    original = '';
  }

  const next = applyManagedBlock(original, begin, end, entries);
  if (next === null || next === original) return;
  fs.mkdirSync(path.dirname(target.excludePath), { recursive: true });
  const tmp = target.excludePath + '.tmp';
  fs.writeFileSync(tmp, next);
  fs.renameSync(tmp, target.excludePath);
}

/** Remove this agent's leftover managed block from a tracked `.gitignore` written before PHNX-3718.
 * Strips ONLY the fenced block, never creates the file, and removes it if that empties an untracked
 * file we created (it would read as `?? .gitignore`). */
function stripLegacyManagedGitignoreBlock(projectRoot: string, agent: AgentId): void {
  // Migration removes only the legacy generated block and preserves every user rule.
  const gitignorePath = path.join(projectRoot, '.gitignore');
  let original: string;
  try {
    original = fs.readFileSync(gitignorePath, 'utf-8');
  } catch {
    return;
  }

  const { begin, end } = gitignoreMarkers(agent);
  const stripped = applyManagedBlock(original, begin, end, []);
  if (stripped === null || stripped === original) return;

  if (stripped === '' && !isTrackedByGit(projectRoot, gitignorePath)) {
    removePath(gitignorePath);
    return;
  }
  const tmp = gitignorePath + '.tmp';
  fs.writeFileSync(tmp, stripped);
  fs.renameSync(tmp, gitignorePath);
}

const DETRACK_BEGIN = '# BEGIN agents-cli detracked (managed)';
const DETRACK_END = '# END agents-cli detracked (managed)';

/** Stop tracking `relPath` in the DotAgents clone and ignore it via `.git/info/exclude`, not
 * `.gitignore` (PHNX-3718). The `git rm --cached` is COMMITTED (a bare one leaves a dirty staged
 * deletion) so peers converge. Idempotent; fails open outside git. */
export function detrackViaGitExclude(repoDir: string, relPath: string): boolean {
  // The automatic commit must contain only relPath, keep its working file, and
  // roll back a staged deletion if any Git step fails.
  const target = resolveGitExcludeTarget(repoDir);
  if (!target) return false;

  let untrackedNow = false;
  const abs = path.join(repoDir, relPath);
  if (isTrackedByGit(repoDir, abs)) {
    try {
      // Unstage anything else first so the removal commit records ONLY this path's deletion (mixed
      // reset: index only). The index is normally clean at migration time; this guarantees the
      // scope.
      execFileSync('git', ['-C', repoDir, 'reset', '-q'], { stdio: ['ignore', 'ignore', 'ignore'] });
      // --cached keeps the working file; the commit records the removal so the de-track converges
      // across the fleet. A pathspec commit would re-read the still-present worktree file and undo
      // it, so the commit takes the staged index.
      execFileSync('git', ['-C', repoDir, 'rm', '--cached', '--quiet', '--', relPath], {
        stdio: ['ignore', 'ignore', 'ignore'],
      });
      execFileSync(
        'git',
        ['-C', repoDir, '-c', 'commit.gpgsign=false', 'commit', '--no-verify',
          '-m', `chore(config): stop tracking ${relPath}`],
        { stdio: ['ignore', 'ignore', 'ignore'] },
      );
      untrackedNow = true;
    } catch {
      // rm/commit can fail (mid-rebase, index.lock); the ignore entry below still lands and the
      // next run retries. Fail open, but roll back a staged-uncommitted removal so no dirty staged
      // deletion is left behind.
      try {
        execFileSync('git', ['-C', repoDir, 'reset', '-q', '--', relPath], {
          stdio: ['ignore', 'ignore', 'ignore'],
        });
      } catch {  }
      untrackedNow = false;
    }
  }

  // Root anchoring keeps this clone-local exclusion from matching unrelated files.
  const entry = '/' + relPath.split(path.sep).join('/');
  let original = '';
  try { original = fs.readFileSync(target.excludePath, 'utf-8'); } catch { original = ''; }
  const existing = extractManagedEntries(original, DETRACK_BEGIN, DETRACK_END);
  const entries = existing.includes(entry) ? existing : [...existing, entry].sort();
  const next = applyManagedBlock(original, DETRACK_BEGIN, DETRACK_END, entries);
  if (next !== null && next !== original) {
    fs.mkdirSync(path.dirname(target.excludePath), { recursive: true });
    const tmp = target.excludePath + '.tmp';
    fs.writeFileSync(tmp, next);
    fs.renameSync(tmp, target.excludePath);
  }
  return untrackedNow;
}

function extractManagedEntries(content: string, begin: string, end: string): string[] {
  const lines = content.split('\n');
  const bi = lines.indexOf(begin);
  if (bi === -1) return [];
  const ei = lines.indexOf(end, bi + 1);
  if (ei === -1) return [];
  return lines.slice(bi + 1, ei).map((l) => l.trim()).filter(Boolean);
}

function removeManagedPath(agentRoot: string, rel: string): void {
  if (path.isAbsolute(rel) || rel.includes('..')) return;
  const target = path.resolve(agentRoot, rel);
  const root = path.resolve(agentRoot);
  if (target !== root && !target.startsWith(root + path.sep)) return;
  removePath(target);
}

function removePath(p: string): void {
  try {
    const st = fs.lstatSync(p);
    if (st.isSymbolicLink() || st.isFile()) fs.unlinkSync(p);
    else if (st.isDirectory()) fs.rmSync(p, { recursive: true, force: true });
  } catch {
  }
}

function pathExists(p: string): boolean {
  try {
    fs.lstatSync(p);
    return true;
  } catch {
    return false;
  }
}

function copyDir(src: string, dest: string): void {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    if (entry.isSymbolicLink() || COPY_IGNORE.has(entry.name)) continue;
    const s = safeJoin(src, entry.name);
    const d = safeJoin(dest, entry.name);
    if (entry.isDirectory()) copyDir(s, d);
    else if (entry.isFile()) fs.copyFileSync(s, d);
  }
}

function projectEntries(projectAgentsDir: string, kind: ProjectKind): fs.Dirent[] {
  const dir = path.join(projectAgentsDir, kind);
  try {
    return fs.readdirSync(dir, { withFileTypes: true }).filter((entry) => !entry.name.startsWith('.'));
  } catch {
    return [];
  }
}

/** Manifest paths persist in `.agents-managed.json` in the version-controlled project dir, so store
 * them POSIX-style: `path.join` yields `skills\myskill` on Windows, which wouldn't match on
 * macOS/Linux. Normalizing on write and read repairs old manifests. */
function toPosixRel(rel: string): string {
  // Manifests stay POSIX so state written on Windows is removable on POSIX peers.
  return rel.replace(/\\/g, '/');
}

function record(
  kind: ProjectKind,
  name: string,
  relPaths: string[],
  result: ProjectResourceSyncResult,
  manifestPaths: Set<string>,
): void {
  result.synced.push(`${kind}/${name}`);
  for (const rel of relPaths) manifestPaths.add(toPosixRel(rel));
}

function skip(dest: string, projectRoot: string, result: ProjectResourceSyncResult): void {
  result.skipped.push(path.relative(projectRoot, dest));
}

/** One human line for files a sync left alone because you wrote them. This is the normal steady
 * state, so it is a single grouped line, not a warning per file, saying "yours" rather than
 * "user-owned". Null when nothing was skipped. */
export function formatKeptProjectResources(skipped: string[]): string | null {
  if (skipped.length === 0) return null;
  const rels = [...skipped].sort((a, b) => a.localeCompare(b)).map(toPosixRel);
  if (rels.length === 1) return `Kept your existing ${rels[0]}`;

  const byDir = new Map<string, string[]>();
  for (const rel of rels) {
    const dir = rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '.';
    const names = byDir.get(dir) ?? [];
    names.push(rel.slice(rel.lastIndexOf('/') + 1));
    byDir.set(dir, names);
  }

  if (byDir.size === 1) {
    const [dir, names] = [...byDir.entries()][0];
    const PREVIEW = 3;
    const preview = names.slice(0, PREVIEW).join(', ');
    const more = names.length > PREVIEW ? `, +${names.length - PREVIEW} more` : '';
    return `Kept ${rels.length} of your own files in ${dir}: ${preview}${more}`;
  }
  const dirs = [...byDir.entries()].map(([dir, names]) => `${dir} (${names.length})`).join(', ');
  return `Kept ${rels.length} of your own files in ${dirs}`;
}

function syncProjectCommands(
  agent: AgentId,
  version: string,
  projectAgentsDir: string,
  agentRoot: string,
  result: ProjectResourceSyncResult,
  manifestPaths: Set<string>,
): void {
  const cfg = AGENTS[agent];
  const commandsAsSkills = shouldInstallCommandAsSkill(agent, version);
  const commandsAlsoAsSkills = shouldAlsoInstallCommandAsSkill(agent, version);
  const supportsCommands = supports(agent, 'commands', version).ok;
  if (!commandsAsSkills && !supportsCommands) return;

  const projectRoot = path.dirname(projectAgentsDir);
  for (const entry of projectEntries(projectAgentsDir, 'commands')) {
    if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
    const name = entry.name.slice(0, -'.md'.length);
    const srcFile = path.join(projectAgentsDir, 'commands', entry.name);
    const metadata = parseCommandMetadata(srcFile);
    if (!commandAppliesTo(agent, version, metadata).ok) continue;

    const written: string[] = [];
    if (commandsAsSkills || commandsAlsoAsSkills) {
      const sourceMarker = readSkillSourceCommandMarker(name, [path.join(projectAgentsDir, 'skills')]);
      if (pathExists(path.join(projectAgentsDir, 'skills', name)) && sourceMarker !== name) {
        if (commandsAsSkills) continue;
      } else {
        const skillName = commandSkillName(name);
        const rel = path.join('skills', skillName);
        const destDir = path.join(agentRoot, rel);
        if (pathExists(destDir)) {
          skip(destDir, projectRoot, result);
        } else {
          fs.mkdirSync(destDir, { recursive: true });
          fs.writeFileSync(path.join(destDir, 'SKILL.md'), buildCommandSkillContent(name, srcFile), 'utf-8');
          written.push(rel);
        }
      }
      if (commandsAsSkills) {
        if (written.length > 0) record('commands', name, written, result, manifestPaths);
        continue;
      }
    }

    const ext = cfg.format === 'toml' ? '.toml' : '.md';
    const rel = path.join(cfg.commandsSubdir, `${name}${ext}`);
    const destFile = path.join(agentRoot, rel);
    if (pathExists(destFile)) {
      skip(destFile, projectRoot, result);
    } else {
      fs.mkdirSync(path.dirname(destFile), { recursive: true });
      if (cfg.format === 'toml') {
        fs.writeFileSync(destFile, markdownToToml(name, fs.readFileSync(srcFile, 'utf-8')), 'utf-8');
      } else {
        fs.copyFileSync(srcFile, destFile);
      }
      written.push(rel);
    }
    if (written.length > 0) record('commands', name, written, result, manifestPaths);
  }
}

function syncProjectSkills(
  agent: AgentId,
  version: string,
  projectAgentsDir: string,
  agentRoot: string,
  result: ProjectResourceSyncResult,
  manifestPaths: Set<string>,
): void {
  if (!supports(agent, 'skills', version).ok) return;
  const projectRoot = path.dirname(projectAgentsDir);
  for (const entry of projectEntries(projectAgentsDir, 'skills')) {
    if (!entry.isDirectory()) continue;
    const srcDir = path.join(projectAgentsDir, 'skills', entry.name);
    if (!fs.existsSync(path.join(srcDir, 'SKILL.md'))) continue;
    const rel = path.join('skills', entry.name);
    const destDir = path.join(agentRoot, rel);
    if (pathExists(destDir)) {
      skip(destDir, projectRoot, result);
      continue;
    }
    copyDir(srcDir, destDir);
    record('skills', entry.name, [rel], result, manifestPaths);
  }
}

function readProjectSubagents(projectAgentsDir: string): Map<string, InstalledSubagent> {
  const map = new Map<string, InstalledSubagent>();
  for (const entry of projectEntries(projectAgentsDir, 'subagents')) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(projectAgentsDir, 'subagents', entry.name);
    const agentMd = path.join(dir, 'AGENT.md');
    if (!fs.existsSync(agentMd)) continue;
    const frontmatter = parseSubagentFrontmatter(agentMd);
    if (!frontmatter) continue;
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.md')).sort();
    map.set(entry.name, { name: entry.name, path: dir, files, frontmatter });
  }
  return map;
}

function syncProjectSubagents(
  agent: AgentId,
  version: string,
  projectAgentsDir: string,
  projectRoot: string,
  agentRoot: string,
  result: ProjectResourceSyncResult,
  manifestPaths: Set<string>,
): void {
  if (!supports(agent, 'subagents', version).ok) return;
  const target = subagentTarget(agent);
  if (!target) return;
  const all = readProjectSubagents(projectAgentsDir);
  const dir = target.dir(projectRoot);

  for (const sub of all.values()) {
    const occupied = target.occupied(dir, sub.name);
    const existing = occupied.find((entry) => pathExists(entry.path));
    if (existing) {
      skip(existing.path, projectRoot, result);
      continue;
    }
    try {
      target.write(dir, sub);
      record('subagents', sub.name, occupied.map((entry) => path.relative(agentRoot, entry.path)), result, manifestPaths);
    } catch {
    }
  }
}

function workflowManagedRelPaths(agent: AgentId, projectRoot: string, name: string, workflowDir: string): string[] {
  if (agent === 'kimi') return [path.join('.kimi-code', 'skills', name)];
  if (agent === 'goose') {
    const rels = [path.join('.config', 'goose', 'recipes', `${name}.yaml`)];
    const subagentsDir = path.join(workflowDir, 'subagents');
    let hasSubagents = false;
    try {
      hasSubagents = fs.readdirSync(subagentsDir).some((f) => f.endsWith('.md'));
    } catch {
      hasSubagents = false;
    }
    if (hasSubagents) rels.push(path.join('.config', 'goose', 'recipes', `${name}.subrecipes`));
    return rels;
  }
  if (agent === 'openclaw') return [path.join('.openclaw', 'workflows', `${name}.lobster`)];
  return [path.join(agentConfigDirName(agent), 'workflows', name)];
}

function syncProjectWorkflows(
  agent: AgentId,
  version: string,
  projectAgentsDir: string,
  projectRoot: string,
  agentRoot: string,
  result: ProjectResourceSyncResult,
  manifestPaths: Set<string>,
): void {
  if (!supports(agent, 'workflows', version).ok) return;
  if (agent === 'antigravity') return;

  for (const entry of projectEntries(projectAgentsDir, 'workflows')) {
    if (!entry.isDirectory()) continue;
    const workflowDir = path.join(projectAgentsDir, 'workflows', entry.name);
    if (!fs.existsSync(path.join(workflowDir, 'WORKFLOW.md'))) continue;
    const rels = workflowManagedRelPaths(agent, projectRoot, entry.name, workflowDir);
    const existing = rels.map((rel) => path.join(projectRoot, rel)).find((dest) => pathExists(dest));
    if (existing) {
      skip(existing, projectRoot, result);
      continue;
    }
    let success = false;
    if (agent === 'kimi' || agent === 'goose' || agent === 'openclaw') {
      success = syncWorkflowToVersion(workflowDir, entry.name, agent, projectRoot).success;
    } else {
      copyDir(workflowDir, path.join(agentRoot, 'workflows', entry.name));
      success = true;
    }
    if (success) {
      record('workflows', entry.name, rels.map((rel) => path.relative(agentRoot, path.join(projectRoot, rel))), result, manifestPaths);
    }
  }
}
