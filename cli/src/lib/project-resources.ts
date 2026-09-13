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

  if (next.size > 0 || manifest) {
    writeProjectManifest(agentRoot, Array.from(next).sort());
    // The sync is a code generator: the per-harness dir it writes into the
    // project tree (.factory/, .opencode/, …) is a regenerable copy of
    // .agents/{commands,skills,…}, refreshed on every launch. Left untracked it
    // dirties `git status` and can block `git merge`/`checkout` when a stray
    // commit of the same path collides. So the generator owns its ignore rule:
    // reconcile a per-agent marker block listing exactly the paths it manages.
    // That block lives in `.git/info/exclude` — git's per-clone, uncommitted
    // ignore file — NOT the tracked `.gitignore`: these entries are never
    // committed upstream, so writing them into `.gitignore` left every launch
    // with a permanent `M .gitignore` that blocked `git pull` (PHNX-3718).
    // Passing the manifest set (empty when a sync clears a harness) also prunes
    // the block. See PHNX-3717 for the self-managed-ignore feature.
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

/**
 * Turn the manifest's managed paths (relative to agentRoot) into anchored,
 * POSIX, `referenceRoot`-relative ignore entries. `referenceRoot` is the
 * directory the anchored `/…` patterns resolve against — the git worktree root
 * for a `.git/info/exclude` block, since git anchors info/exclude patterns at
 * the top of the working tree (not at the harness dir). Two guards keep it
 * honest:
 *   - drop any path that escapes the harness config dir (e.g. grok writes
 *     commands back into the tracked `.agents/` tree via a `../` subdir —
 *     ignoring that would hide tracked source; separate bug, PHNX-3718);
 *   - the manifest only ever holds paths the sync itself generated (pre-existing
 *     user/committed files are skipped and never recorded), so ignoring exactly
 *     these never masks a hand-authored or committed file (e.g. a repo that
 *     commits its own `.claude/CLAUDE.md` keeps it — it is not in the manifest).
 */
export function managedGitignoreEntries(agentRoot: string, referenceRoot: string, managed: string[]): string[] {
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
  /** Absolute path to the ignore file managed entries are written into —
   *  `<git-common-dir>/info/exclude`. */
  excludePath: string;
  /** Absolute path to the top of the working tree; anchored `/…` entries
   *  resolve against this, since git anchors info/exclude patterns there. */
  worktreeRoot: string;
}

/**
 * Ask git where the local, per-clone ignore file lives and where the worktree
 * top is, resolved robustly for every layout by delegating to git itself:
 *   - normal repo → `<root>/.git/info/exclude`;
 *   - monorepo subdir → the same file even when `.git` is several levels up
 *     (`projectRoot`, the parent of `.agents/`, is not the git root);
 *   - linked worktree / submodule → `.git` is a FILE (`gitdir: …`), and
 *     `--git-path info/exclude` resolves to the shared COMMON dir so the block
 *     applies across every worktree.
 * `--path-format=absolute` forces absolute paths regardless of the `-C` cwd.
 * One `git rev-parse` yields both paths (exclude path first, worktree root
 * second), so the launch path spawns git ONCE, not twice.
 * Returns null when `dir` is not inside a git repo (git exits non-zero), which
 * fails the feature open (no-op) exactly like the old in-tree check did.
 */
function resolveGitExcludeTarget(dir: string): GitExcludeTarget | null {
  try {
    const out = execFileSync(
      'git',
      ['-C', dir, 'rev-parse', '--path-format=absolute', '--git-path', 'info/exclude', '--show-toplevel'],
      { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] },
    );
    const [excludePath, worktreeRoot] = out.split('\n').map((l) => l.trim());
    if (!excludePath || !worktreeRoot) return null;
    // Fail open on anything that isn't a clean pair of ABSOLUTE paths. A git
    // older than 2.31 (predates `--path-format`) echoes the unrecognized flag
    // back on stdout instead of erroring, which would otherwise shift the parse
    // and have mkdirSync create a stray `--path-format=absolute` dir. The
    // absolute-path check turns that into a clean no-op.
    if (!path.isAbsolute(excludePath) || !path.isAbsolute(worktreeRoot)) return null;
    return { excludePath, worktreeRoot };
  } catch {
    return null;
  }
}

/** True when git tracks `absPath` in the repo `dir` sits in. */
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

/**
 * Apply this agent's managed block to ignore-file content, IN PLACE — used both
 * to write the block into `.git/info/exclude` and to strip a leftover block from
 * a legacy tracked `.gitignore` (entries `[]` prunes).
 *
 * In-place replacement (not strip-then-append) is load-bearing: appending would
 * move this agent's block behind every other agent's block on each resync, so in
 * a repo synced by 2+ harnesses whichever one launched last would get bumped to
 * the end — rewriting `.gitignore` on every launch forever. Replacing the block
 * where it already sits keeps the file byte-stable once written.
 *
 * Returns the new content, `content` unchanged when there is nothing to do, or
 * `null` when the block is unparseable (a begin marker with no matching end —
 * hand-truncated or a botched merge). In that case we refuse to edit rather than
 * treat everything to EOF as the block and silently delete the user's rules
 * below the orphaned marker.
 */
function applyManagedBlock(content: string, begin: string, end: string, entries: string[]): string | null {
  const lines = content.split('\n');
  const bi = lines.indexOf(begin);
  if (bi !== -1) {
    const ei = lines.indexOf(end, bi + 1);
    if (ei === -1) return null; // orphaned begin marker — never truncate to EOF
    if (entries.length > 0) {
      return [...lines.slice(0, bi), begin, ...entries, end, ...lines.slice(ei + 1)].join('\n');
    }
    // Prune the block, tidying the blank lines that hugged it. Unreached on the
    // reconcileManagedIgnore write path (its entries always include the manifest,
    // so entries.length is never 0 there), but the load-bearing case for
    // stripLegacyManagedGitignoreBlock, which calls with entries=[] to migrate a
    // leftover block out of the tracked .gitignore.
    const before = lines.slice(0, bi);
    const after = lines.slice(ei + 1);
    while (before.length && before[before.length - 1].trim() === '') before.pop();
    while (after.length && after[0].trim() === '') after.shift();
    const rest = [...before, ...after].join('\n').replace(/\n+$/, '');
    return rest.length > 0 ? `${rest}\n` : '';
  }
  if (entries.length === 0) return content; // no block, nothing to add
  const body = content.replace(/\n+$/, '');
  const block = [begin, ...entries, end].join('\n');
  return body.length > 0 ? `${body}\n\n${block}\n` : `${block}\n`;
}

/**
 * Reconcile a per-agent managed block in `.git/info/exclude` so the generated
 * per-harness resource dir never shows as untracked dirt — WITHOUT dirtying the
 * tracked `.gitignore`. Idempotent and convergent: replaces the block in place
 * and writes only when the content actually changes, so the launch hot path does
 * not churn the file (or its watchers) every run — even in a project synced by
 * several harnesses. When a sync clears a harness's resources the block does not
 * vanish: it shrinks to the lone `.agents-managed.json` entry (that file still
 * sits in the harness dir and must stay ignored), so the block is only ever
 * fully pruned by hand, never via this call path. Fails open (no-op) outside a
 * git working tree.
 *
 * Also self-heals repos dirtied by the previous behavior: PHNX-3717 wrote these
 * blocks into `<projectRoot>/.gitignore`, which is never committed upstream, so
 * every launch left a permanent `M .gitignore` that blocked `git pull`
 * (PHNX-3718). `stripLegacyManagedGitignoreBlock` removes this agent's leftover
 * block from that tracked file on the next launch, cleaning the diff instead of
 * stranding it.
 */
function reconcileManagedIgnore(
  projectRoot: string,
  agent: AgentId,
  agentRoot: string,
  managed: string[],
): void {
  // Migrate away from the old tracked-.gitignore location first, so an already
  // dirtied repo cleans itself even if git resolution below fails.
  stripLegacyManagedGitignoreBlock(projectRoot, agent);

  const target = resolveGitExcludeTarget(projectRoot);
  if (!target) return; // not a git repo — fail open

  const { begin, end } = gitignoreMarkers(agent);
  // Ignore the manifest marker file too, not just the synced resources: the
  // sync always writes `<agentRoot>/.agents-managed.json`, so without this the
  // harness dir still shows as untracked in `git status` on the strength of that
  // one file (defeating the whole point). It lives at agentRoot, so it resolves
  // through the same anchoring + escape guard as any managed path. Anchored to
  // the worktree root, since info/exclude patterns resolve against the tree top.
  const entries = managedGitignoreEntries(agentRoot, target.worktreeRoot, [MANIFEST_FILE, ...managed]);

  let original = '';
  try {
    original = fs.readFileSync(target.excludePath, 'utf-8');
  } catch {
    original = '';
  }

  const next = applyManagedBlock(original, begin, end, entries);
  if (next === null || next === original) return;
  fs.mkdirSync(path.dirname(target.excludePath), { recursive: true }); // create info/ if missing
  const tmp = target.excludePath + '.tmp';
  fs.writeFileSync(tmp, next);
  fs.renameSync(tmp, target.excludePath);
}

/**
 * Remove this agent's leftover managed block from a tracked `<projectRoot>/
 * .gitignore` written by the pre-PHNX-3718 behavior. Strips ONLY the fenced
 * block (leaving every hand-written rule untouched), never creates the file,
 * and never touches a `.gitignore` that carries no block of ours. If stripping
 * empties a file we created (its only content was our block), the empty file is
 * removed when git does not track it — an empty untracked `.gitignore` would
 * still read as `?? .gitignore` dirt, the very thing this migration clears.
 */
function stripLegacyManagedGitignoreBlock(projectRoot: string, agent: AgentId): void {
  const gitignorePath = path.join(projectRoot, '.gitignore');
  let original: string;
  try {
    original = fs.readFileSync(gitignorePath, 'utf-8');
  } catch {
    return; // no .gitignore — nothing to migrate
  }

  const { begin, end } = gitignoreMarkers(agent);
  // Empty entries → applyManagedBlock prunes the block; returns `original`
  // unchanged when there is no block, or null on an orphaned begin marker
  // (which we refuse to touch rather than truncate the user's rules).
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

/**
 * Stop git tracking `relPath` in the DotAgents clone at `repoDir` and keep it
 * locally ignored — the PHNX-3718 pattern, applied to a shared config file the
 * user repo should no longer carry (e.g. the duplicated CHANGELOG.md; the
 * canonical copy ships in `.system/`).
 *
 * The ignore entry goes in `.git/info/exclude`, NOT `.gitignore`: a tracked
 * `.gitignore` block would itself show as `M .gitignore` on every clone and
 * reintroduce the exact dirty-tree-blocks-pull failure this whole effort exists
 * to kill. info/exclude is per-clone and never committed, so the working tree
 * stays clean at rest.
 *
 * Idempotent and convergent: when the path is still tracked it is removed from
 * the index (the working file is kept) AND that removal is committed — a bare
 * `git rm --cached` would leave a staged deletion, which is itself a dirty tree
 * that re-arms the very pull trip this exists to prevent. The single removal
 * commit also propagates the de-track fleet-wide: peers pull it and converge,
 * their next run finding nothing to untrack. The exclude block is rewritten in
 * place, unioning `relPath` with any entries already there, so a second run is a
 * no-op. Fails open outside a git repo. Returns whether the path was untracked
 * by this call (a signal for the caller's one-time log).
 */
export function detrackViaGitExclude(repoDir: string, relPath: string): boolean {
  const target = resolveGitExcludeTarget(repoDir);
  if (!target) return false; // not a git repo — nothing to de-track or ignore.

  let untrackedNow = false;
  const abs = path.join(repoDir, relPath);
  if (isTrackedByGit(repoDir, abs)) {
    try {
      // Unstage anything else first so the removal commit records ONLY this
      // path's deletion — a mixed reset (index only, worktree untouched). At
      // migration time the index is already clean; this just makes the scope
      // guaranteed rather than assumed.
      execFileSync('git', ['-C', repoDir, 'reset', '-q'], { stdio: ['ignore', 'ignore', 'ignore'] });
      // --cached keeps the working file; the commit records the removal so the
      // tree is clean at rest and the de-track converges across the fleet. A
      // pathspec commit would re-read the still-present worktree file and undo
      // the removal, so the commit takes the staged index (just this deletion).
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
      // rm/commit can fail (e.g. mid-rebase, index.lock); the ignore entry below
      // still lands and the next migration run retries the untrack. Fail open —
      // but roll back a staged-but-uncommitted removal so we never LEAVE a dirty
      // staged deletion behind (which would re-arm the pull trip).
      try {
        execFileSync('git', ['-C', repoDir, 'reset', '-q', '--', relPath], {
          stdio: ['ignore', 'ignore', 'ignore'],
        });
      } catch { /* nothing staged to reset */ }
      untrackedNow = false;
    }
  }

  // Anchor to the worktree root so the pattern matches only the top-level file,
  // exactly like git anchors a leading-slash info/exclude entry.
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

/** The entries currently inside a `begin`/`end` managed block, or `[]`. */
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
    // already absent
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

/**
 * Manifest paths are persisted to `.agents-managed.json`, which lives in the
 * version-controlled project dir and therefore travels between machines. Store
 * them POSIX-style: `path.join` yields `skills\myskill` on Windows, and a
 * manifest carrying that would silently fail to match — and so fail to clean up
 * its managed files — when the same project is synced on macOS or Linux.
 * Normalizing on both write and read also repairs manifests written by earlier
 * Windows builds.
 */
function toPosixRel(rel: string): string {
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

/**
 * One human line for the files a project sync left alone because you already
 * wrote them. This is the normal steady state — every sync of a project whose
 * `.claude/commands/` you hand-authored hits it — so it is a single grouped
 * line, not one wrapped warning per file, and it says "yours" rather than the
 * internal "user-owned". Returns null when nothing was skipped.
 */
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
      // Malformed source or unsupported transform; skip this item.
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
