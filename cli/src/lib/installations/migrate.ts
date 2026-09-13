/** One-shot idempotent migrations. Each is guarded by an existence check so re-running is safe. */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as yaml from 'yaml';
import { stringifyDoc } from '../yaml-io.js';
import { execSync } from 'child_process';
import { atomicWriteFileSync } from '../fs-atomic.js';
import type { AgentId } from '../types.js';
import { machineId } from '../machine-id.js';
import { AGENTS, agentConfigDirName, findInPath } from '../agents.js';
import { createLink } from '../platform/index.js';
import { foldLegacySystemRepo, copyDirSkipExisting } from '../migrate-fold.js';
export { foldLegacySystemRepo } from '../migrate-fold.js';
import { migrateLegacyRoutineActivation, listJobs, validateJob } from '../scheduling/routines.js';
import { setConfigValue } from '../device-config.js';
import { enabledRoutineNames, replaceEnabledRoutines } from '../routine-activation.js';
import { evaluateActivationReadiness } from '../routine-readiness.js';
import { migrateDeviceConfigStores } from '../devices/config-migration.js';
import { detrackViaGitExclude } from '../project-resources.js';
// Two constants only, never the read/write API — migrations still operate on raw
// YAML so they never take the meta lock or prime the meta cache mid-migration.
import { LEGACY_DEFAULT_BROWSER_PROFILE_NAME } from '../browser/profiles.js';
import { META_HEADER as DEVICE_META_HEADER } from '../state.js';
import { COMPILED_HEADER_PROJECT } from '../rules/compile.js';

const HOME = process.env.HOME ?? os.homedir();
const USER_DIR = path.join(HOME, '.agents');
/** Canonical system-repo location (post-fold). */
const SYSTEM_DIR = path.join(USER_DIR, '.system');
const HISTORY_DIR = path.join(USER_DIR, '.history');
const CACHE_DIR = path.join(USER_DIR, '.cache');

function isTrackedInGitRepo(repoDir: string, relPath: string): boolean {
  try {
    execSync(`git ls-files --error-unmatch -- ${relPath}`, { cwd: repoDir, stdio: 'ignore' });
    return true;
  } catch {
    // Not a git repo, or the file is untracked — either way, not tracked.
    return false;
  }
}

/** Migrate a legacy single-repo agents.yaml into ~/.agents/agents.yaml. Leaves the tracked system-mirror copy alone to avoid dirtying the npm-shipped defaults. */
export function migrateAgentsYaml(systemDir: string = SYSTEM_DIR, userDir: string = USER_DIR): void {
  const src = path.join(systemDir, 'agents.yaml');
  const dest = path.join(userDir, 'agents.yaml');
  if (!fs.existsSync(src)) return;

  // Never move the tracked system-mirror copy; doing so would dirty the npm-shipped defaults.
  if (isTrackedInGitRepo(systemDir, 'agents.yaml')) return;

  if (fs.existsSync(dest)) {
    // User copy is authoritative — drop the untracked stale system leftover.
    try { fs.unlinkSync(src); } catch { /* best-effort */ }
    return;
  }
  try {
    fs.mkdirSync(userDir, { recursive: true, mode: 0o700 });
    fs.renameSync(src, dest);
    console.error('Migrated agents.yaml to ~/.agents/');
  } catch { /* best-effort */ }
}

function deleteSystemPromptsJson(): void {
  const f = path.join(SYSTEM_DIR, 'prompts.json');
  if (!fs.existsSync(f)) return;
  try {
    fs.unlinkSync(f);
  } catch { /* best-effort */ }
}

/**
 * Stop tracking the user repo's CHANGELOG.md. It duplicates the npm-shipped
 * `.system/CHANGELOG.md` (read the canonical copy from there), and as a tracked
 * file that upstream never carries it can only ever show as `M`/`??`
 * — dirtying the tree and, when a peer's publish commit arrives, tripping the
 * dirty-tree pull guard. De-track it into `.git/info/exclude` (per-clone,
 * uncommitted; never `.gitignore`, which would re-introduce the same failure).
 * Idempotent: a no-op once the path is untracked and excluded.
 */
export function detrackUserChangelog(userDir: string = USER_DIR): void {
  if (!fs.existsSync(path.join(userDir, '.git'))) return; // plain dir, not a clone
  const untracked = detrackViaGitExclude(userDir, 'CHANGELOG.md');
  if (untracked) console.error('Stopped tracking ~/.agents/CHANGELOG.md (duplicates .system/CHANGELOG.md)');
}

/** Delete the legacy ~/.agents-system/config.json (dead teams agent registry). */
function migrateSystemConfigJson(): void {
  const src = path.join(SYSTEM_DIR, 'config.json');
  if (!fs.existsSync(src)) return;
  try {
    fs.unlinkSync(src);
  } catch { /* best-effort */ }
}

/** Move promptcuts.yaml from each repo root into hooks/. */
function migratePromptcutsIntoHooks(): void {
  for (const root of [SYSTEM_DIR, USER_DIR]) {
    const src = path.join(root, 'promptcuts.yaml');
    const dest = path.join(root, 'hooks', 'promptcuts.yaml');
    if (fs.existsSync(dest) || !fs.existsSync(src)) continue;
    try {
      fs.mkdirSync(path.dirname(dest), { recursive: true, mode: 0o700 });
      fs.renameSync(src, dest);
    } catch { /* best-effort */ }
  }
}

/** Move installed versions from the legacy ~/.agents-system/versions/ tree into ~/.agents/versions/. Leaves collisions in place for manual reconciliation. */
function migrateSystemVersionsToUser(): void {
  const sysVersions = path.join(SYSTEM_DIR, 'versions');
  const userVersions = path.join(USER_DIR, 'versions');
  if (!fs.existsSync(sysVersions)) return;

  let movedCount = 0;
  let skippedCount = 0;

  let agentEntries: fs.Dirent[];
  try {
    agentEntries = fs.readdirSync(sysVersions, { withFileTypes: true });
  } catch {
    return;
  }

  for (const agent of agentEntries) {
    if (!agent.isDirectory()) continue;
    const srcAgentDir = path.join(sysVersions, agent.name);
    const dstAgentDir = path.join(userVersions, agent.name);
    try {
      fs.mkdirSync(dstAgentDir, { recursive: true, mode: 0o700 });
    } catch { /* best-effort */ }

    let verEntries: fs.Dirent[];
    try {
      verEntries = fs.readdirSync(srcAgentDir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const ver of verEntries) {
      if (!ver.isDirectory()) continue;
      const src = path.join(srcAgentDir, ver.name);
      const dst = path.join(dstAgentDir, ver.name);
      if (fs.existsSync(dst)) {
        skippedCount++;
        continue;
      }
      try {
        fs.renameSync(src, dst);
        movedCount++;
      } catch { /* best-effort, leave legacy in place */ }
    }
    try {
      if (fs.readdirSync(srcAgentDir).length === 0) fs.rmdirSync(srcAgentDir);
    } catch { /* best-effort */ }
  }

  try {
    if (fs.readdirSync(sysVersions).length === 0) fs.rmdirSync(sysVersions);
  } catch { /* best-effort */ }

  if (movedCount > 0) {
    console.error(`Migrated ${movedCount} version dir${movedCount === 1 ? '' : 's'} from ~/.agents-system/versions/ to ~/.agents/versions/`);
  }
  if (skippedCount > 0) {
    console.error(`Skipped ${skippedCount} version dir${skippedCount === 1 ? '' : 's'} already present in ~/.agents/versions/ (kept legacy copy at ~/.agents-system/versions/)`);
  }
}

/** Move ~/.agents/runs/ into ~/.agents/routines/runs/. */
function migrateRunsIntoRoutines(): void {
  const src = path.join(USER_DIR, 'runs');
  const dest = path.join(USER_DIR, 'routines', 'runs');
  if (!fs.existsSync(src) || fs.existsSync(dest)) return;
  try {
    fs.mkdirSync(path.dirname(dest), { recursive: true, mode: 0o700 });
    fs.renameSync(src, dest);
  } catch { /* best-effort */ }
}

/** Move ~/.agents/trash/ to ~/.agents/.trash/. */
function migrateTrashToHidden(): void {
  const src = path.join(USER_DIR, 'trash');
  const dest = path.join(USER_DIR, '.trash');
  if (!fs.existsSync(src) || fs.existsSync(dest)) return;
  try {
    fs.renameSync(src, dest);
  } catch { /* best-effort */ }
}

/** Move ~/.agents/backups/ to ~/.agents/.backups/. */
function migrateBackupsToHidden(): void {
  const src = path.join(USER_DIR, 'backups');
  const dest = path.join(USER_DIR, '.backups');
  if (!fs.existsSync(src) || fs.existsSync(dest)) return;
  try {
    fs.renameSync(src, dest);
  } catch { /* best-effort */ }
}

/** Fold ~/.agents/hooks.yaml into ~/.agents/agents.yaml under `hooks:`, dropping the standalone file. agents.yaml wins on collision. */
function foldUserHooksYamlIntoAgentsYaml(): void {
  const hooksFile = path.join(USER_DIR, 'hooks.yaml');
  if (!fs.existsSync(hooksFile)) return;

  let hooks: Record<string, unknown>;
  try {
    const raw = fs.readFileSync(hooksFile, 'utf-8');
    const parsed = yaml.parse(raw) as Record<string, unknown> | null;
    hooks = parsed && typeof parsed === 'object' ? parsed : {};
  } catch { return; }

  const metaFile = path.join(USER_DIR, 'agents.yaml');
  let meta: Record<string, unknown> = {};
  if (fs.existsSync(metaFile)) {
    try {
      const raw = fs.readFileSync(metaFile, 'utf-8');
      const parsed = yaml.parse(raw) as Record<string, unknown> | null;
      if (parsed && typeof parsed === 'object') meta = parsed;
    } catch { return; }
  }

  const existingHooks = (meta.hooks as Record<string, unknown> | undefined) ?? {};
  const merged: Record<string, unknown> = { ...hooks, ...existingHooks };
  meta.hooks = merged;

  const header = `# agents-cli metadata
# Auto-generated - do not edit manually
# https://github.com/phnx-labs/agi-cli

`;
  try {
    fs.mkdirSync(USER_DIR, { recursive: true, mode: 0o700 });
    fs.writeFileSync(metaFile, header + yaml.stringify(meta), 'utf-8');
    fs.unlinkSync(hooksFile);
    console.error('Folded ~/.agents/hooks.yaml into ~/.agents/agents.yaml (hooks: section)');
  } catch { /* best-effort */ }
}

/** Fold the legacy global browser/sessions/<task>/ tree into the per-profile browser/<profile>/sessions/<task>/ layout. Unclaimed tasks move under `_legacy`. */
export function foldBrowserSessionsIntoProfiles(browserDir: string = path.join(CACHE_DIR, 'browser')): void {
  const legacySessionsDir = path.join(browserDir, 'sessions');

  let taskDirs: fs.Dirent[];
  try {
    taskDirs = fs.readdirSync(legacySessionsDir, { withFileTypes: true });
  } catch {
    return; // no legacy global sessions/ root — already folded or never existed
  }

  const taskOwner = new Map<string, string>();
  let profileDirs: fs.Dirent[] = [];
  try {
    profileDirs = fs.readdirSync(browserDir, { withFileTypes: true });
  } catch { /* browserDir vanished mid-run */ }
  for (const p of profileDirs) {
    if (!p.isDirectory() || p.name === 'sessions' || p.name === '_legacy') continue;
    try {
      const state = JSON.parse(fs.readFileSync(path.join(browserDir, p.name, 'tasks.json'), 'utf-8'));
      for (const taskName of Object.keys(state)) {
        if (!taskOwner.has(taskName)) taskOwner.set(taskName, p.name);
      }
    } catch { /* missing or invalid tasks.json */ }
  }

  for (const taskEntry of taskDirs) {
    if (!taskEntry.isDirectory()) continue;
    const owner = taskOwner.get(taskEntry.name) ?? '_legacy';
    // A capture dir can hold a nested recordings/ subdir and may collide with a
    // dest that already has newer captures — moveDirOnce merges (skip-existing),
    // moveFileOnce would EISDIR on unlink and silently strand the captures.
    moveDirOnce(
      path.join(legacySessionsDir, taskEntry.name),
      path.join(browserDir, owner, 'sessions', taskEntry.name)
    );
  }

  rmEmptyDirTree(legacySessionsDir);
}

/** Fold ~/.agents/browser/profiles/*.yaml into ~/.agents/agents.yaml under `browser:`. agents.yaml wins on collision. */
function foldBrowserProfilesIntoAgentsYaml(): void {
  const profilesDir = path.join(USER_DIR, 'browser', 'profiles');
  if (!fs.existsSync(profilesDir)) return;

  let files: string[];
  try {
    files = fs.readdirSync(profilesDir).filter((f) => f.endsWith('.yaml'));
  } catch { return; }
  if (files.length === 0) return;

  const profiles: Record<string, unknown> = {};
  for (const file of files) {
    try {
      const raw = fs.readFileSync(path.join(profilesDir, file), 'utf-8');
      const parsed = yaml.parse(raw) as Record<string, unknown> | null;
      if (!parsed || typeof parsed !== 'object') continue;
      const name = (parsed.name as string) || file.replace(/\.yaml$/, '');
      const { name: _, ...config } = parsed;
      profiles[name] = config;
    } catch { /* skip unreadable file */ }
  }

  if (Object.keys(profiles).length === 0) return;

  const metaFile = path.join(USER_DIR, 'agents.yaml');
  let meta: Record<string, unknown> = {};
  if (fs.existsSync(metaFile)) {
    try {
      const raw = fs.readFileSync(metaFile, 'utf-8');
      const parsed = yaml.parse(raw) as Record<string, unknown> | null;
      if (parsed && typeof parsed === 'object') meta = parsed;
    } catch { return; }
  }

  const existingBrowser = (meta.browser as Record<string, unknown> | undefined) ?? {};
  const merged: Record<string, unknown> = { ...profiles, ...existingBrowser };
  meta.browser = merged;

  const header = `# agents-cli metadata
# Auto-generated - do not edit manually
# https://github.com/phnx-labs/agi-cli

`;
  try {
    fs.mkdirSync(USER_DIR, { recursive: true, mode: 0o700 });
    fs.writeFileSync(metaFile, header + yaml.stringify(meta), 'utf-8');
    for (const file of files) {
      try { fs.unlinkSync(path.join(profilesDir, file)); } catch { /* best-effort */ }
    }
    try { fs.rmdirSync(profilesDir); } catch { /* may not be empty */ }
    try {
      const browserDir = path.join(USER_DIR, 'browser');
      if (fs.existsSync(browserDir) && fs.readdirSync(browserDir).length === 0) {
        fs.rmdirSync(browserDir);
      }
    } catch { /* best-effort */ }
    console.error('Folded ~/.agents/browser/profiles/ into ~/.agents/agents.yaml (browser: section)');
  } catch { /* best-effort */ }
}

/** Delete the legacy ~/.agents/linear.json plaintext credential store. */
function deleteUserLinearJson(): void {
  const f = path.join(USER_DIR, 'linear.json');
  if (!fs.existsSync(f)) return;
  try {
    fs.unlinkSync(f);
  } catch { /* best-effort */ }
}

/** Delete the dead ~/.agents/prompts.json file. */
function deleteUserPromptsJson(): void {
  const f = path.join(USER_DIR, 'prompts.json');
  if (!fs.existsSync(f)) return;
  try {
    fs.unlinkSync(f);
  } catch { /* best-effort */ }
}

/** Delete the dead ~/.agents/teams/config.json file. */
function deleteTeamsConfigJson(): void {
  const f = path.join(USER_DIR, 'teams', 'config.json');
  if (!fs.existsSync(f)) return;
  try {
    fs.unlinkSync(f);
  } catch { /* best-effort */ }
}

/** Move ~/.agents/teams/registry.json (per-machine runtime state) into ~/.agents/.history/teams/. */
function moveTeamsRegistryToHistory(): void {
  const src = path.join(USER_DIR, 'teams', 'registry.json');
  const dest = path.join(HISTORY_DIR, 'teams', 'registry.json');
  moveFileOnce(src, dest);
}

/** Delete the legacy ~/.agents/config.json teams config file. */
function cleanupUserConfigJson(): void {
  const legacy = path.join(USER_DIR, 'config.json');
  if (!fs.existsSync(legacy)) return;
  try {
    fs.unlinkSync(legacy);
  } catch { /* best-effort */ }
}

/** Remove an empty ~/.agents/runs/ directory left over after migrateRunsIntoRoutines(). */
function cleanupEmptyTopLevelRuns(): void {
  const dir = path.join(USER_DIR, 'runs');
  if (!fs.existsSync(dir)) return;
  try {
    if (fs.readdirSync(dir).length === 0) fs.rmdirSync(dir);
  } catch { /* best-effort */ }
}

/** Move ~/.agents-system/aliases.json into ~/.agents/aliases.json. */
function migrateAliasesToUser(): void {
  const src = path.join(SYSTEM_DIR, 'aliases.json');
  const dest = path.join(USER_DIR, 'aliases.json');
  if (fs.existsSync(dest) || !fs.existsSync(src)) return;
  try {
    fs.mkdirSync(USER_DIR, { recursive: true, mode: 0o700 });
    fs.renameSync(src, dest);
  } catch { /* best-effort */ }
}

/**
 * For overlapping versions that exist in BOTH ~/.agents-system/versions/ and
 * ~/.agents/versions/, merge legacy operational state (history, sessions,
 * settings) into the user copy without overwriting any files synced by
 * agents-cli (skills, commands, hooks, memory). Then drop the legacy copy.
 *
 * Why: when both paths exist, the inverted-prior migrator left them split.
 * Agent CLIs read from ~/.<agent> (a symlink that historically targeted
 * the system path), while sync writes to the user path. Same skill ends up
 * in both → duplicate entries in the skills picker, stale state, broken
 * resource resolution.
 *
 * Strategy: copy legacy → user with "skip if exists". Sync-managed dirs
 * (which live in user already, freshly written) stay untouched. Anything
 * the agent CLI created on its own (history.jsonl, sessions/, settings.json,
 * file-history/, paste-cache/, …) lands in user where it belongs. The
 * legacy version-home is then renamed into ~/.agents/.trash/versions/ so
 * it's recoverable.
 */
function mergeOverlappingVersionHomes(): void {
  const sysVersions = path.join(SYSTEM_DIR, 'versions');
  const userVersions = path.join(USER_DIR, 'versions');
  if (!fs.existsSync(sysVersions)) return;

  let mergedCount = 0;
  let agentEntries: fs.Dirent[];
  try {
    agentEntries = fs.readdirSync(sysVersions, { withFileTypes: true });
  } catch {
    return;
  }

  for (const agent of agentEntries) {
    if (!agent.isDirectory()) continue;
    const sysAgentDir = path.join(sysVersions, agent.name);
    const userAgentDir = path.join(userVersions, agent.name);
    let verEntries: fs.Dirent[];
    try {
      verEntries = fs.readdirSync(sysAgentDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const ver of verEntries) {
      if (!ver.isDirectory()) continue;
      const sysHome = path.join(sysAgentDir, ver.name, 'home');
      const userHome = path.join(userAgentDir, ver.name, 'home');
      if (!fs.existsSync(sysHome) || !fs.existsSync(userHome)) continue;

      try {
        copyDirSkipExisting(sysHome, userHome);

        const trashRoot = path.join(USER_DIR, '.trash', 'versions', agent.name, ver.name);
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        fs.mkdirSync(trashRoot, { recursive: true, mode: 0o700 });
        fs.renameSync(path.join(sysAgentDir, ver.name), path.join(trashRoot, `legacy-${stamp}`));
        mergedCount++;
      } catch { /* best-effort */ }
    }
    try {
      if (fs.readdirSync(sysAgentDir).length === 0) fs.rmdirSync(sysAgentDir);
    } catch { /* best-effort */ }
  }
  try {
    if (fs.readdirSync(sysVersions).length === 0) fs.rmdirSync(sysVersions);
  } catch { /* best-effort */ }

  if (mergedCount > 0) {
    console.error(`Merged ${mergedCount} overlapping version home${mergedCount === 1 ? '' : 's'} from legacy ~/.agents-system/versions/ into ~/.agents/versions/ (legacy moved to ~/.agents/.trash/versions/)`);
  }
}

/** Rename permissions/sets/ to permissions/presets/ in both user and system repos. */
function migratePermissionSetsToPresets(): void {
  for (const root of [USER_DIR, SYSTEM_DIR]) {
    const src = path.join(root, 'permissions', 'sets');
    const dest = path.join(root, 'permissions', 'presets');
    if (!fs.existsSync(src) || fs.existsSync(dest)) continue;
    try {
      fs.renameSync(src, dest);
      const label = root === USER_DIR ? '~/.agents' : '~/.agents-system';
      console.error(`Migrated ${label}/permissions/sets/ to ${label}/permissions/presets/`);
    } catch { /* best-effort */ }
  }
}

/** Rewrite per-agent config symlinks to point at the user-side version home after migration. Leaves real directories alone (switching is owned by `agents use`). */
function repairAgentConfigSymlinks(): void {
  // Version pins live in the machine-local pins JSON (~/.agents/.history/
  // devices/pins-<machine>.json); the tracked device doc and central
  // agents.yaml may still carry them mid-transition. Read pins first
  // (authoritative), then the legacy locations, first-seen-agent wins.
  const defaults: Array<{ agent: string; version: string }> = [];
  const seen = new Set<string>();
  const collectJsonPins = (file: string): void => {
    let pins: { agents?: Record<string, string> };
    try { pins = JSON.parse(fs.readFileSync(file, 'utf-8')) as typeof pins; } catch { return; }
    for (const [agent, version] of Object.entries(pins?.agents ?? {})) {
      if (!seen.has(agent)) { seen.add(agent); defaults.push({ agent, version }); }
    }
  };
  const collectYamlPins = (file: string): void => {
    let text: string;
    try { text = fs.readFileSync(file, 'utf-8'); } catch { return; }
    const block = text.match(/^agents:\s*\n((?:  [^\n]*\n)+)/m);
    if (!block) return;
    for (const line of block[1].split('\n')) {
      const m = line.match(/^\s+([a-z][a-z0-9_-]*):\s*([^\s#]+)/);
      if (m && !seen.has(m[1])) { seen.add(m[1]); defaults.push({ agent: m[1], version: m[2] }); }
    }
  };
  collectJsonPins(path.join(USER_DIR, '.history', 'devices', `pins-${machineId()}.json`));
  collectYamlPins(path.join(USER_DIR, 'devices', machineId(), 'agents.yaml'));
  collectYamlPins(path.join(USER_DIR, 'agents.yaml'));
  if (defaults.length === 0) return;

  let repaired = 0;
  for (const { agent, version } of defaults) {
    const configDirName = agent in AGENTS ? agentConfigDirName(agent as AgentId) : `.${agent}`;
    const userTarget = fs.existsSync(path.join(HISTORY_DIR, 'versions', agent, version, 'home', configDirName))
      ? path.join(HISTORY_DIR, 'versions', agent, version, 'home', configDirName)
      : path.join(USER_DIR, 'versions', agent, version, 'home', configDirName);
    if (!fs.existsSync(userTarget)) continue;

    const symlinkPath = path.join(HOME, configDirName);
    let stat: fs.Stats | null = null;
    try { stat = fs.lstatSync(symlinkPath); } catch { /* missing */ }
    if (stat && stat.isSymbolicLink()) {
      let current: string;
      try { current = fs.readlinkSync(symlinkPath); } catch { continue; }
      const resolved = path.resolve(path.dirname(symlinkPath), current);
      if (resolved === path.resolve(userTarget)) continue; // already correct
      try {
        fs.unlinkSync(symlinkPath);
        createLink(userTarget, symlinkPath);
        repaired++;
      } catch { /* best-effort */ }
    } else if (!stat) {
      try {
        createLink(userTarget, symlinkPath);
        repaired++;
      } catch { /* best-effort */ }
    }
  }

  if (repaired > 0) {
    console.error(`Repaired ${repaired} agent config symlink${repaired === 1 ? '' : 's'} to point at ~/.agents/versions/`);
  }
}

/** Repair node_modules/.bin/<cli> symlinks that resolve back into our own shims dir (infinite exec-loop fix). */
export function repairSelfReferentialBinShims(
  versionsRoot: string = path.join(HISTORY_DIR, 'versions'),
  shimsDir: string = path.resolve(CACHE_DIR, 'shims'),
  historyDir: string = path.dirname(versionsRoot),
): void {
  // realpath the shims dir so the prefix check survives symlinked paths (e.g. macOS /tmp -> /private/tmp).
  shimsDir = path.resolve(shimsDir);
  try {
    shimsDir = fs.realpathSync(shimsDir);
  } catch {
    /* shims dir absent — leave the resolved path; nothing will match it */
  }
  let agents: string[];
  try {
    agents = fs.readdirSync(versionsRoot);
  } catch {
    return; // no versions installed yet
  }

  let repaired = 0;
  for (const agent of agents) {
    const cli = agent in AGENTS ? AGENTS[agent as AgentId].cliCommand : agent;
    let versions: string[];
    try {
      versions = fs.readdirSync(path.join(versionsRoot, agent));
    } catch {
      continue;
    }
    for (const version of versions) {
      const binLink = path.join(versionsRoot, agent, version, 'node_modules', '.bin', cli);
      let stat: fs.Stats;
      try {
        stat = fs.lstatSync(binLink);
      } catch {
        continue; // no .bin entry for this version
      }
      if (!stat.isSymbolicLink()) continue;

      let real: string;
      try {
        real = fs.realpathSync(binLink);
      } catch {
        // Dangling symlink — if it was aimed at the shims dir it's the loop
        // residue; drop it either way so getBinaryPath reports honestly.
        try {
          fs.unlinkSync(binLink);
          repaired++;
        } catch { /* best-effort */ }
        continue;
      }

      if (!path.resolve(real).startsWith(shimsDir + path.sep)) continue; // points at a real binary — fine

      // Self-referential: the link resolves back into our own shims dir.
      // findInPath does a pure-Node PATH scan (no subprocess) and already
      // skips our shims dir, so it returns the genuine install if one exists.
      const realBinary = findInPath(cli, { shimsDir, historyDir });
      try {
        fs.unlinkSync(binLink);
        // createLink: a real symlink where the OS allows it (POSIX, and Windows
        // with the symlink privilege), copy-fallback otherwise — so the repair
        // lands a working binary on Windows runners without the symlink right.
        if (realBinary) createLink(realBinary, binLink);
        repaired++;
      } catch { /* best-effort */ }
    }
  }

  if (repaired > 0) {
    console.error(`Repaired ${repaired} self-referential agent binary symlink${repaired === 1 ? '' : 's'} (infinite exec-loop fix).`);
  }
}

/** Move `src` to `dest`; when `dest` exists, merge missing entries then remove `src`. Idempotent. */
function moveDirOnce(src: string, dest: string): void {
  if (!fs.existsSync(src)) return;

  if (!fs.existsSync(dest)) {
    try {
      fs.mkdirSync(path.dirname(dest), { recursive: true, mode: 0o700 });
      fs.renameSync(src, dest);
      return;
    } catch {
      /* fall through to copy + remove */
    }
  }

  try {
    copyDirSkipExisting(src, dest);
    fs.rmSync(src, { recursive: true, force: true });
  } catch { /* best-effort */ }
}

/** Move `src` to `dest`; when `dest` exists, delete `src` (dest is canonical). Idempotent. */
function moveFileOnce(src: string, dest: string): void {
  if (!fs.existsSync(src)) return;
  if (fs.existsSync(dest)) {
    try { fs.unlinkSync(src); } catch { /* best-effort */ }
    return;
  }
  try {
    fs.mkdirSync(path.dirname(dest), { recursive: true, mode: 0o700 });
    fs.renameSync(src, dest);
  } catch {
    try {
      fs.copyFileSync(src, dest);
      fs.unlinkSync(src);
    } catch { /* best-effort */ }
  }
}

function rmEmptyDirTree(dir: string): void {
  if (!fs.existsSync(dir)) return;
  try {
    const entries = fs.readdirSync(dir);
    for (const entry of entries) {
      const child = path.join(dir, entry);
      try {
        const stat = fs.statSync(child);
        if (stat.isDirectory()) rmEmptyDirTree(child);
      } catch { /* skip */ }
    }
    if (fs.readdirSync(dir).length === 0) fs.rmdirSync(dir);
  } catch { /* best-effort */ }
}

/**
 * Move durable runtime data into ~/.agents/.history/.
 *
 * Sources cleared:
 *   ~/.agents/sessions/   -> ~/.agents/.history/sessions/
 *   ~/.agents/versions/   -> ~/.agents/.history/versions/
 *   ~/.agents/.trash/     -> ~/.agents/.history/trash/
 *   ~/.agents/.backups/   -> ~/.agents/.history/backups/
 *   ~/.agents/routines/runs/ -> ~/.agents/.history/runs/
 *   ~/.agents/teams/agents/  -> ~/.agents/.history/teams/agents/
 *
 * Idempotent — skips entries whose destination already exists.
 */
function migrateRuntimeToHistory(): void {
  moveDirOnce(path.join(USER_DIR, 'sessions'), path.join(HISTORY_DIR, 'sessions'));
  moveDirOnce(path.join(USER_DIR, 'versions'), path.join(HISTORY_DIR, 'versions'));
  // Some installs left both `.trash/` (current) and `trash/` (legacy lowercase).
  // Move whichever exist into the history bucket.
  moveDirOnce(path.join(USER_DIR, '.trash'), path.join(HISTORY_DIR, 'trash'));
  moveDirOnce(path.join(USER_DIR, 'trash'), path.join(HISTORY_DIR, 'trash'));
  moveDirOnce(path.join(USER_DIR, '.backups'), path.join(HISTORY_DIR, 'backups'));
  moveDirOnce(path.join(USER_DIR, 'routines', 'runs'), path.join(HISTORY_DIR, 'runs'));
  moveDirOnce(path.join(USER_DIR, 'teams', 'agents'), path.join(HISTORY_DIR, 'teams', 'agents'));

  // Drop any empty leftover skeletons created mid-rename (e.g. `versions/<agent>/<v>/home/`
  // recreated by a concurrent process). The real data is already under .history/.
  rmEmptyDirTree(path.join(USER_DIR, 'versions'));
  rmEmptyDirTree(path.join(USER_DIR, 'sessions'));
  // Old empty zero-byte sessions.db at user root is obsolete once the new db lives at
  // .history/sessions/sessions.db.
  const oldSessionsDb = path.join(USER_DIR, 'sessions.db');
  if (fs.existsSync(oldSessionsDb)) {
    try {
      if (fs.statSync(oldSessionsDb).size === 0) fs.unlinkSync(oldSessionsDb);
    } catch { /* best-effort */ }
  }
}

/** Rename the session marker store after the product vocabulary changed from
 * favorite to bookmark. The destination wins if a newer CLI already wrote it. */
function migrateLegacySessionMarkersToBookmarks(): void {
  moveFileOnce(
    path.join(HISTORY_DIR, 'favorites.json'),
    path.join(HISTORY_DIR, 'bookmarks.json'),
  );
}

/**
 * Restore plugins from the cache bucket back to the user-root.
 *
 * Earlier releases moved ~/.agents/plugins/ → ~/.agents/.cache/plugins/ as part
 * of `migrateRuntimeToCache`. That was wrong: plugins are user-authored
 * resources (alongside skills/, commands/, hooks/) and belong at the user-root
 * so they're git-tracked. See issue #20.
 *
 * For each ~/.agents/.cache/plugins/<name>/ that the user already has at
 * ~/.agents/plugins/<name>/, the cache copy is left alone — the user-root copy
 * wins. For plugins only present in the cache, the directory is moved back to
 * the user-root. Idempotent.
 */
function migratePluginsBackToUserRoot(): void {
  const cachePlugins = path.join(CACHE_DIR, 'plugins');
  const userPlugins = path.join(USER_DIR, 'plugins');
  if (!fs.existsSync(cachePlugins)) return;

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(cachePlugins, { withFileTypes: true });
  } catch { return; }

  try {
    fs.mkdirSync(userPlugins, { recursive: true, mode: 0o700 });
  } catch { return; }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const src = path.join(cachePlugins, entry.name);
    const dest = path.join(userPlugins, entry.name);
    if (fs.existsSync(dest)) continue;
    try {
      fs.renameSync(src, dest);
    } catch {
      try {
        copyDirSkipExisting(src, dest);
        fs.rmSync(src, { recursive: true, force: true });
      } catch { /* best-effort */ }
    }
  }

  // Drop the cache plugins dir if we emptied it.
  try {
    if (fs.readdirSync(cachePlugins).length === 0) fs.rmdirSync(cachePlugins);
  } catch { /* best-effort */ }
}

/**
 * Move regenerable runtime data into ~/.agents/.cache/.
 *
 * Sources cleared:
 *   ~/.agents/shims/         -> ~/.agents/.cache/shims/
 *   ~/.agents/bin/           -> ~/.agents/.cache/bin/
 *   ~/.agents/packages/      -> ~/.agents/.cache/packages/
 *   ~/.agents/cloud/         -> ~/.agents/.cache/cloud/
 *   ~/.agents/drive/         -> ~/.agents/.cache/drive/
 *   ~/.agents/terminals/     -> ~/.agents/.cache/terminals/
 *   ~/.agents/logs/          -> ~/.agents/.cache/logs/
 *   ~/.agents/companion/      -> ~/.agents/.cache/companion/
 *   ~/.agents/runtime/       -> ~/.agents/.cache/state/
 *   ~/.agents/cache/         -> ~/.agents/.cache/   (flatten — already a cache subdir)
 *   ~/.agents/helpers/{daemon,pty,...} -> ~/.agents/.cache/helpers/...
 *   ~/.agents-system/helpers/{daemon,pty,...} -> ~/.agents/.cache/helpers/...
 *   ~/.agents/browser/<profile>/  -> ~/.agents/.cache/browser/<profile>/  (profiles/ dir stays)
 *   ~/.agents-system/.fetch/ -> ~/.agents/.cache/.fetch/
 *
 * Loose dot-files at user root that are runtime caches:
 *   ~/.agents/.cli-version-cache.json -> ~/.agents/.cache/.cli-version-cache.json
 *   ~/.agents/.update-check           -> ~/.agents/.cache/.update-check
 *   ~/.agents/.migrated               -> ~/.agents/.cache/.migrated
 *   ~/.agents/watchdog.log            -> ~/.agents/.cache/logs/watchdog.log
 *
 * Idempotent.
 */
function migrateRuntimeToCache(): void {
  moveDirOnce(path.join(USER_DIR, 'shims'), path.join(CACHE_DIR, 'shims'));
  moveDirOnce(path.join(USER_DIR, 'bin'), path.join(CACHE_DIR, 'bin'));
  moveDirOnce(path.join(USER_DIR, 'packages'), path.join(CACHE_DIR, 'packages'));
  // ~/.agents/plugins/ is intentionally NOT migrated — it is user-authored
  // content (git-tracked), alongside skills/, commands/, hooks/. The reverse
  // migration `migratePluginsBackToUserRoot` reclaims any plugins/ that prior
  // releases moved into ~/.agents/.cache/plugins/. See issue #20.
  moveDirOnce(path.join(USER_DIR, 'cloud'), path.join(CACHE_DIR, 'cloud'));
  moveDirOnce(path.join(USER_DIR, 'drive'), path.join(CACHE_DIR, 'drive'));
  moveDirOnce(path.join(USER_DIR, 'terminals'), path.join(CACHE_DIR, 'terminals'));
  moveDirOnce(path.join(USER_DIR, 'logs'), path.join(CACHE_DIR, 'logs'));
  moveDirOnce(path.join(USER_DIR, 'companion'), path.join(CACHE_DIR, 'companion'));
  moveDirOnce(path.join(USER_DIR, 'runtime'), path.join(CACHE_DIR, 'state'));

  // Pre-existing user `cache/` dir (claude usage cache, cloud-runs, etc.) — flatten
  // so it's not confused with the new bucket. Its contents merge into .cache/.
  const oldCache = path.join(USER_DIR, 'cache');
  if (fs.existsSync(oldCache) && fs.statSync(oldCache).isDirectory()) {
    try {
      fs.mkdirSync(CACHE_DIR, { recursive: true, mode: 0o700 });
      copyDirSkipExisting(oldCache, CACHE_DIR);
      fs.rmSync(oldCache, { recursive: true, force: true });
    } catch { /* best-effort */ }
  }

  // helpers/ at user-root and system-root → .cache/helpers/
  for (const root of [USER_DIR, SYSTEM_DIR]) {
    const src = path.join(root, 'helpers');
    if (!fs.existsSync(src)) continue;
    const destBase = path.join(CACHE_DIR, 'helpers');
    try {
      fs.mkdirSync(destBase, { recursive: true, mode: 0o700 });
      copyDirSkipExisting(src, destBase);
      fs.rmSync(src, { recursive: true, force: true });
    } catch { /* best-effort */ }
  }

  // browser runtime — keep browser/profiles/ in place, move everything else under
  // browser/ into .cache/browser/.
  const browserSrc = path.join(USER_DIR, 'browser');
  if (fs.existsSync(browserSrc) && fs.statSync(browserSrc).isDirectory()) {
    let entries: string[] = [];
    try { entries = fs.readdirSync(browserSrc); } catch { /* skip */ }
    for (const entry of entries) {
      if (entry === 'profiles') continue;
      const src = path.join(browserSrc, entry);
      const dest = path.join(CACHE_DIR, 'browser', entry);
      moveDirOnce(src, dest);
    }
  }

  // System-root operational state that should not live in the npm-shipped repo.
  moveDirOnce(path.join(SYSTEM_DIR, '.fetch'), path.join(CACHE_DIR, '.fetch'));
  moveDirOnce(path.join(SYSTEM_DIR, 'browser'), path.join(CACHE_DIR, 'browser'));
  moveDirOnce(path.join(SYSTEM_DIR, 'state'), path.join(CACHE_DIR, 'state'));
  moveDirOnce(path.join(SYSTEM_DIR, 'companion'), path.join(CACHE_DIR, 'companion'));
  moveFileOnce(path.join(SYSTEM_DIR, '.cli-version-cache.json'), path.join(CACHE_DIR, '.cli-version-cache.json'));
  moveFileOnce(path.join(SYSTEM_DIR, '.update-check'), path.join(CACHE_DIR, '.update-check'));
  moveFileOnce(path.join(SYSTEM_DIR, '.migrated'), path.join(CACHE_DIR, '.migrated'));
  moveFileOnce(path.join(SYSTEM_DIR, '.models-cache.json'), path.join(CACHE_DIR, '.models-cache.json'));

  // Loose dot-files at user root that belong in the cache bucket.
  moveFileOnce(path.join(USER_DIR, '.cli-version-cache.json'), path.join(CACHE_DIR, '.cli-version-cache.json'));
  moveFileOnce(path.join(USER_DIR, '.update-check'), path.join(CACHE_DIR, '.update-check'));
  moveFileOnce(path.join(USER_DIR, '.migrated'), path.join(CACHE_DIR, '.migrated'));
  moveFileOnce(path.join(USER_DIR, '.models-cache.json'), path.join(CACHE_DIR, '.models-cache.json'));
  moveFileOnce(path.join(USER_DIR, 'watchdog.log'), path.join(CACHE_DIR, 'logs', 'watchdog.log'));
}

/**
 * Merge a SQLite database file at `src` into the one at `dest`, then delete the
 * source (including its WAL/SHM sidecars). User-side rows win on collision via
 * INSERT OR IGNORE.
 *
 * If `dest` is missing, the source is simply moved into place (no merge). If
 * the SQLite open fails (corrupt / zero-byte / locked), the source is dropped
 * so the system repo returns to npm-shipped state — the data is stale-anyway
 * runtime state, not user resources.
 */
async function mergeSqliteDb(src: string, dest: string): Promise<void> {
  if (!fs.existsSync(src)) return;
  try {
    if (fs.statSync(src).size === 0) {
      // Zero-byte legacy DB — drop sidecars too and leave dest alone.
      try { fs.unlinkSync(src); } catch { /* best-effort */ }
      for (const ext of ['-shm', '-wal']) {
        try { fs.unlinkSync(src + ext); } catch { /* best-effort */ }
      }
      return;
    }
  } catch { /* best-effort */ }

  if (!fs.existsSync(dest)) {
    try {
      fs.mkdirSync(path.dirname(dest), { recursive: true, mode: 0o700 });
      fs.renameSync(src, dest);
      for (const ext of ['-shm', '-wal']) {
        if (fs.existsSync(src + ext)) {
          try { fs.renameSync(src + ext, dest + ext); } catch { /* best-effort */ }
        }
      }
      return;
    } catch { /* fall through to merge */ }
  }

  // Both files exist — open the dest DB and ATTACH src, then INSERT OR IGNORE
  // every user table. Dynamic import keeps the sqlite shim off the hot path
  // for CLI starts that don't actually need a merge.
  try {
    const sqliteMod = (await import('../sqlite.js')) as { default: new (file: string) => SqliteLike };
    const Database = sqliteMod.default;
    const db = new Database(dest);
    try {
      db.exec(`ATTACH DATABASE '${src.replace(/'/g, "''")}' AS src`);
      const tables = db.prepare<{ name: string }>(
        `SELECT name FROM src.sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'`,
      ).all() as Array<{ name: string }>;
      // FTS5 virtual tables maintain shadow tables (<name>_data, _idx, _content,
      // _docsize, _config) with internal segids/pgnos that MUST stay consistent.
      // Row-merging shadow tables across two DBs corrupts the index. Skip them
      // here — the indexer reconstructs FTS content on the next scan.
      const ftsVirtuals = new Set<string>(
        (db.prepare<{ name: string }>(
          `SELECT name FROM src.sqlite_master WHERE type='table' AND sql LIKE '%fts5%'`,
        ).all() as Array<{ name: string }>).map((r) => r.name),
      );
      const ftsShadowSuffixes = ['_data', '_idx', '_content', '_docsize', '_config'];
      const isFtsShadow = (name: string): boolean => {
        for (const v of ftsVirtuals) {
          for (const suf of ftsShadowSuffixes) {
            if (name === `${v}${suf}`) return true;
          }
        }
        return false;
      };
      for (const { name } of tables) {
        if (ftsVirtuals.has(name) || isFtsShadow(name)) continue;
        try {
          const row = db.prepare<{ sql: string }>(
            `SELECT sql FROM src.sqlite_master WHERE type='table' AND name = ?`,
          ).get(name) as { sql?: string } | undefined;
          if (row?.sql) {
            const ddl = row.sql.replace(/^CREATE TABLE\s+/i, 'CREATE TABLE IF NOT EXISTS ');
            db.exec(ddl);
          }
        } catch { /* table likely exists already */ }
        const quoted = '"' + name.replace(/"/g, '""') + '"';
        try {
          db.exec(`INSERT OR IGNORE INTO main.${quoted} SELECT * FROM src.${quoted}`);
        } catch { /* schema drift — skip table */ }
      }
      try { db.exec('DETACH DATABASE src'); } catch { /* best-effort */ }
    } finally {
      try { db.close(); } catch { /* best-effort */ }
    }
    try { fs.unlinkSync(src); } catch { /* best-effort */ }
    for (const ext of ['-shm', '-wal']) {
      try { fs.unlinkSync(src + ext); } catch { /* best-effort */ }
    }
  } catch {
    // Merge failed — drop the source so the system repo returns to clean state.
    // The user-side DB is authoritative; system-side rows were duplicate state.
    try { fs.unlinkSync(src); } catch { /* best-effort */ }
    for (const ext of ['-shm', '-wal']) {
      try { fs.unlinkSync(src + ext); } catch { /* best-effort */ }
    }
  }
}

interface SqliteLike {
  exec(sql: string): void;
  prepare<T = unknown>(sql: string): { get(...a: unknown[]): unknown; all(...a: unknown[]): unknown[] };
  close(): void;
}

/**
 * Move ~/.agents-system/sessions/ into ~/.agents/.history/sessions/.
 *
 * Filesystem entries (claude/, index.jsonl, content_index.jsonl, etc.) merge
 * directory-by-directory with user-side winning on collision. The bundled
 * sessions.db (plus WAL/SHM) goes through mergeSqliteDb so historical rows
 * land in the user DB.
 */
async function migrateSystemSessionsToHistory(): Promise<void> {
  const src = path.join(SYSTEM_DIR, 'sessions');
  if (!fs.existsSync(src)) return;
  const dest = path.join(HISTORY_DIR, 'sessions');
  try { fs.mkdirSync(dest, { recursive: true, mode: 0o700 }); } catch { /* best-effort */ }

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(src, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    const s = path.join(src, entry.name);
    if (entry.name === 'sessions.db' || entry.name === 'sessions.db-shm' || entry.name === 'sessions.db-wal') {
      // Handled by mergeSqliteDb on the canonical .db name below.
      continue;
    }
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      moveDirOnce(s, d);
    } else {
      moveFileOnce(s, d);
    }
  }

  await mergeSqliteDb(path.join(src, 'sessions.db'), path.join(dest, 'sessions.db'));

  try {
    if (fs.readdirSync(src).length === 0) fs.rmdirSync(src);
  } catch { /* best-effort */ }
}

/**
 * Move ~/.agents-system/teams/ contents to ~/.agents/teams/ (registry/config)
 * and ~/.agents/.history/teams/ (per-run dirs).
 *
 * Strategy:
 *   config.json, registry.json   -> ~/.agents/teams/        (live state)
 *   agents/                       -> ~/.agents/.history/teams/agents/
 *   <anything else>               -> ~/.agents/.history/teams/<name>/  (per-run dirs)
 */
function migrateSystemTeamsToUser(): void {
  const src = path.join(SYSTEM_DIR, 'teams');
  if (!fs.existsSync(src)) return;
  const liveDest = path.join(USER_DIR, 'teams');
  const historyDest = path.join(HISTORY_DIR, 'teams');

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(src, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    const s = path.join(src, entry.name);
    if (entry.name === 'config.json' || entry.name === 'registry.json') {
      moveFileOnce(s, path.join(liveDest, entry.name));
      continue;
    }
    if (entry.name === 'agents' && entry.isDirectory()) {
      moveDirOnce(s, path.join(historyDest, 'agents'));
      continue;
    }
    if (entry.isDirectory()) {
      moveDirOnce(s, path.join(historyDest, entry.name));
    } else {
      moveFileOnce(s, path.join(historyDest, entry.name));
    }
  }

  try {
    if (fs.readdirSync(src).length === 0) fs.rmdirSync(src);
  } catch { /* best-effort */ }
}

/**
 * Move ~/.agents-system/trash/ -> ~/.agents/.history/trash/.
 *
 * The system trash was where the legacy `mergeOverlappingVersionHomes()` parked
 * orphan version homes. Folding it into the history bucket keeps "everything
 * recoverable" in one place.
 */
function migrateSystemTrashToHistory(): void {
  const src = path.join(SYSTEM_DIR, 'trash');
  if (!fs.existsSync(src)) return;
  moveDirOnce(src, path.join(HISTORY_DIR, 'trash'));
}

/**
 * Move ~/.agents-system/cache/ contents into ~/.agents/.cache/.
 *
 * Special cases:
 *   sessions.db        -> mergeSqliteDb into HISTORY_DIR/sessions/sessions.db
 *   cloud-runs/        -> .cache/cloud-runs/
 *   claude-usage.json  -> drop (regenerable per-version cache)
 *   <anything else>    -> .cache/<name> (merge-on-collision)
 */
async function migrateSystemCacheToUserCache(): Promise<void> {
  const src = path.join(SYSTEM_DIR, 'cache');
  if (!fs.existsSync(src)) return;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(src, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    const s = path.join(src, entry.name);
    if (entry.name === 'sessions.db' || entry.name === 'sessions.db-shm' || entry.name === 'sessions.db-wal') {
      // Sessions DB belongs in HISTORY, not CACHE — merge into the durable one.
      if (entry.name === 'sessions.db') {
        await mergeSqliteDb(s, path.join(HISTORY_DIR, 'sessions', 'sessions.db'));
      }
      // Sidecars get dropped if they outlived the merge or were orphaned.
      try { if (fs.existsSync(s)) fs.unlinkSync(s); } catch { /* best-effort */ }
      continue;
    }
    if (entry.name === 'claude-usage.json') {
      try { fs.unlinkSync(s); } catch { /* best-effort */ }
      continue;
    }
    const d = path.join(CACHE_DIR, entry.name);
    if (entry.isDirectory()) {
      moveDirOnce(s, d);
    } else {
      moveFileOnce(s, d);
    }
  }

  try {
    if (fs.readdirSync(src).length === 0) fs.rmdirSync(src);
  } catch { /* best-effort */ }
}

/**
 * Merge ~/.agents-system/cloud/tasks.db into ~/.agents/.cache/cloud/tasks.db.
 */
async function migrateSystemCloudToCache(): Promise<void> {
  const srcDir = path.join(SYSTEM_DIR, 'cloud');
  if (!fs.existsSync(srcDir)) return;
  await mergeSqliteDb(path.join(srcDir, 'tasks.db'), path.join(CACHE_DIR, 'cloud', 'tasks.db'));

  // Any other files in cloud/ get moved into the user cache bucket.
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(srcDir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const s = path.join(srcDir, entry.name);
    const d = path.join(CACHE_DIR, 'cloud', entry.name);
    if (entry.isDirectory()) {
      moveDirOnce(s, d);
    } else {
      moveFileOnce(s, d);
    }
  }
  try {
    if (fs.readdirSync(srcDir).length === 0) fs.rmdirSync(srcDir);
  } catch { /* best-effort */ }
}

/**
 * Legacy ~/.agents-system/swarm/ predates the rename to teams/. Fold any
 * per-agent dirs into ~/.agents/.history/teams/agents/ and drop the bookkeeping
 * JSONs (cache.json, config.json, teams.json) — those are regenerable.
 */
function migrateLegacySwarmToTeams(): void {
  const src = path.join(SYSTEM_DIR, 'swarm');
  if (!fs.existsSync(src)) return;
  const agentsSrc = path.join(src, 'agents');
  if (fs.existsSync(agentsSrc)) {
    moveDirOnce(agentsSrc, path.join(HISTORY_DIR, 'teams', 'agents'));
  }
  for (const dead of ['cache.json', 'config.json', 'teams.json']) {
    const f = path.join(src, dead);
    if (fs.existsSync(f)) {
      try { fs.unlinkSync(f); } catch { /* best-effort */ }
    }
  }
  try {
    if (fs.readdirSync(src).length === 0) fs.rmdirSync(src);
  } catch { /* best-effort */ }
}

/**
 * Move ~/.agents-system/repos/<alias>/ to ~/.agents-<alias>/ peer dirs.
 *
 * Extra DotAgents repos are user-defined config and belong as peer dirs to
 * ~/.agents/, not nested under the npm-shipped system repo. The dir name in
 * `repos/` becomes the alias.
 */
function migrateSystemReposToPeerDirs(): void {
  const src = path.join(SYSTEM_DIR, 'repos');
  if (!fs.existsSync(src)) return;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(src, { withFileTypes: true });
  } catch {
    return;
  }
  let moved = 0;
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const alias = entry.name;
    const s = path.join(src, alias);
    const d = path.join(HOME, `.agents-${alias}`);
    if (fs.existsSync(d)) {
      // Peer dir already exists — drop the system-side copy to avoid drift.
      try { fs.rmSync(s, { recursive: true, force: true }); } catch { /* best-effort */ }
      continue;
    }
    try {
      fs.renameSync(s, d);
      moved++;
    } catch { /* best-effort, leave in place */ }
  }
  try {
    if (fs.readdirSync(src).length === 0) fs.rmdirSync(src);
  } catch { /* best-effort */ }
  if (moved > 0) {
    console.error(`Moved ${moved} extra repo${moved === 1 ? '' : 's'} from ~/.agents-system/repos/ to ~/.agents-<alias>/ peer dirs`);
  }
}

/**
 * Drop known-dead artifacts from ~/.agents-system/ that are pure regenerable
 * runtime state and don't belong anywhere:
 *   bin/agents-keychain-*  — per-version keychain helper, rebuilt on demand
 *   shims/                  — moved long ago, only empty leftover remains
 */
function dropDeadSystemArtifacts(): void {
  const binDir = path.join(SYSTEM_DIR, 'bin');
  if (fs.existsSync(binDir)) {
    try {
      for (const name of fs.readdirSync(binDir)) {
        if (name.startsWith('agents-keychain-')) {
          try { fs.unlinkSync(path.join(binDir, name)); } catch { /* best-effort */ }
        }
      }
      if (fs.readdirSync(binDir).length === 0) fs.rmdirSync(binDir);
    } catch { /* best-effort */ }
  }

  const shimsDir = path.join(SYSTEM_DIR, 'shims');
  if (fs.existsSync(shimsDir)) {
    try {
      if (fs.readdirSync(shimsDir).length === 0) fs.rmdirSync(shimsDir);
    } catch { /* best-effort */ }
  }

  // After migrateSystemVersionsToUser() moves real version dirs out, the system
  // may still hold an empty `versions/<agent>/` skeleton with a stray .DS_Store.
  // Sweep it: if every leaf file is .DS_Store, drop the tree entirely.
  const versionsDir = path.join(SYSTEM_DIR, 'versions');
  if (fs.existsSync(versionsDir)) {
    try {
      if (containsOnlyDsStore(versionsDir)) {
        fs.rmSync(versionsDir, { recursive: true, force: true });
      }
    } catch { /* best-effort */ }
  }
}

function containsOnlyDsStore(dir: string): boolean {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return false;
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (!containsOnlyDsStore(path.join(dir, entry.name))) return false;
    } else if (entry.name !== '.DS_Store') {
      return false;
    }
  }
  return true;
}

/**
 * After the sweep runs, warn (once per invocation) about any unrecognized
 * subdirectory left in ~/.agents-system/. The system repo is the npm-shipped
 * defaults — anything outside the allowlist is drift that future maintainers
 * need to handle explicitly.
 */
function warnSystemOrphans(): void {
  const SHIPPED_ALLOWLIST = new Set<string>([
    // resource directories shipped by the npm package
    'commands', 'hooks', 'skills', 'rules', 'mcp', 'clis', 'permissions', 'subagents', 'profiles', 'agents', 'routines', 'webhooks',
    // top-level metadata files
    'agents.yaml', 'hooks.yaml', 'README.md', 'CHANGELOG.md',
    // git + repo metadata
    '.git', '.githooks', '.gitignore', '.assets', '.environment', '.plans',
    // benign noise that's safe to ignore
    '.DS_Store', '.claude',
  ]);

  let entries: string[];
  try {
    entries = fs.readdirSync(SYSTEM_DIR);
  } catch {
    return;
  }
  // Transient runtime sockets (.sock) are bound by long-running helpers like the
  // VS Code extension; they're live state, not stale data, and a future fix in
  // those helpers will move them into ~/.agents/.cache/ — until then, suppress.
  const orphans = entries.filter((name) => !SHIPPED_ALLOWLIST.has(name) && !name.endsWith('.sock'));
  if (orphans.length === 0) return;
  console.error(`~/.agents-system/ has unexpected entries (not part of the npm-shipped defaults): ${orphans.join(', ')}`);
}

const VERSION_RESOURCE_FLAT_KEYS = ['commands', 'skills', 'hooks', 'memory', 'subagents', 'plugins', 'workflows', 'permissions', 'mcp'] as const;

/**
 * Convert agents.yaml versions: entries from the old flat name-list format to
 * the new pattern format. Flat entries are detected by checking whether all
 * items in the array lack a ':' separator (plain names have no source prefix).
 *
 * The rulesPreset field is preserved. Flat resource lists are dropped — the
 * next `agents sync` will write default patterns (system:* user:* project:*).
 *
 * Idempotent: entries already in pattern format are left untouched.
 */
function migrateVersionResourcesToPatterns(): void {
  const metaFile = path.join(USER_DIR, 'agents.yaml');
  if (!fs.existsSync(metaFile)) return;

  let meta: Record<string, unknown>;
  try {
    const raw = fs.readFileSync(metaFile, 'utf-8');
    meta = (yaml.parse(raw) as Record<string, unknown>) || {};
  } catch { return; }

  const versions = meta.versions as Record<string, Record<string, Record<string, unknown>>> | undefined;
  if (!versions || typeof versions !== 'object') return;

  let changed = false;
  for (const agentVersions of Object.values(versions)) {
    if (!agentVersions || typeof agentVersions !== 'object') continue;
    for (const vr of Object.values(agentVersions)) {
      if (!vr || typeof vr !== 'object') continue;
      for (const key of VERSION_RESOURCE_FLAT_KEYS) {
        const val = vr[key];
        if (!Array.isArray(val) || val.length === 0) continue;
        // Detect legacy: all items are plain names (no ':' separator)
        if ((val as string[]).every(item => typeof item === 'string' && !item.includes(':'))) {
          if (key === 'memory') {
            // memory was a single-element array holding the preset name — move to rulesPreset
            if ((val as string[]).length === 1 && !vr['rulesPreset']) {
              vr['rulesPreset'] = (val as string[])[0];
            }
          }
          delete vr[key];
          changed = true;
        }
      }
    }
  }

  if (changed) {
    const META_HEADER = '# agents-cli metadata\n# Auto-generated - do not edit manually\n# https://github.com/phnx-labs/agi-cli\n# yaml-language-server: $schema=https://raw.githubusercontent.com/phnx-labs/agi-cli/main/cli/schema/agents-yaml.schema.json\n\n';
    fs.writeFileSync(metaFile, META_HEADER + yaml.stringify(meta), 'utf-8');
    console.error('Migrated agents.yaml versions: entries to pattern format');
  }
}

/**
 * Split the machine-local fields out of the committed central agents.yaml so it
 * becomes portable and syncs cleanly (no more skip-worktree band-aid):
 *   agents:   -> ~/.agents/.history/devices/pins-<machineId>.json  (untracked, machine-local)
 *   versions: -> ~/.agents/.history/version-resources.json         (gitignored, machine-local)
 * Then clear any externally-set skip-worktree bit. Idempotent: no-op once central
 * carries neither field. Operates on raw YAML (never through state.ts).
 */
function migrateSplitDeviceLocalMeta(): void {
  const metaFile = path.join(USER_DIR, 'agents.yaml');
  if (!fs.existsSync(metaFile)) return;

  let meta: Record<string, unknown>;
  try {
    meta = (yaml.parse(fs.readFileSync(metaFile, 'utf-8')) as Record<string, unknown>) || {};
  } catch { return; }

  const agents = meta.agents as Record<string, string> | undefined;
  const versions = meta.versions as Record<string, unknown> | undefined;
  const hasLocal =
    (!!agents && Object.keys(agents).length > 0) || (!!versions && Object.keys(versions).length > 0);

  const HEADER = '# agents-cli metadata\n# Auto-generated - do not edit manually\n# https://github.com/phnx-labs/agi-cli\n\n';

  // Only rewrite central when it actually carries machine-local fields — a
  // machine whose agents.yaml is already portable-only is left untouched.
  if (hasLocal) {
    // agents: -> machine-local pins JSON (merge, existing pins win).
    if (agents && Object.keys(agents).length > 0) {
      const pinsPath = path.join(USER_DIR, '.history', 'devices', `pins-${machineId()}.json`);
      let existing: { agents?: Record<string, string> } = {};
      try {
        existing = (JSON.parse(fs.readFileSync(pinsPath, 'utf-8')) as { agents?: Record<string, string> }) || {};
      } catch { /* absent */ }
      fs.mkdirSync(path.dirname(pinsPath), { recursive: true });
      atomicWriteFileSync(
        pinsPath,
        JSON.stringify({ ...existing, agents: { ...agents, ...existing.agents } }, null, 2) + '\n',
      );
    }

    // versions: -> machine-local history JSON (merge, existing wins).
    if (versions && Object.keys(versions).length > 0) {
      const vrPath = path.join(USER_DIR, '.history', 'version-resources.json');
      let existing: Record<string, unknown> = {};
      try { existing = (JSON.parse(fs.readFileSync(vrPath, 'utf-8')) as Record<string, unknown>) || {}; } catch { /* absent */ }
      fs.mkdirSync(path.dirname(vrPath), { recursive: true });
      atomicWriteFileSync(vrPath, JSON.stringify({ ...versions, ...existing }, null, 2) + '\n');
    }

    // Strip machine-local fields from central and rewrite (portable only) — after
    // the pins/history writes above, so a crash never loses data.
    delete meta.agents;
    delete meta.versions;
    atomicWriteFileSync(metaFile, HEADER + yaml.stringify(meta));
  }

  // Always clear any skip-worktree bit (idempotent, best-effort) so agents.yaml
  // syncs cleanly on every machine — even one that had nothing to split. Runs
  // after any rewrite so the tracked content already matches the split shape.
  try {
    execSync('git update-index --no-skip-worktree agents.yaml', { cwd: USER_DIR, stdio: 'ignore' });
  } catch { /* not a git repo / bit not set */ }

  if (hasLocal) {
    console.error('Split agents.yaml: agents: -> .history/devices/pins-*.json, versions: -> .history/version-resources.json');
  }
}

/** Move the auto-detected `default` browser profile from committed agents.yaml into the per-device file. The device file is written first so a crash cannot lose the profile; central is edited via yaml.Document to preserve comments. */
export function migrateMachineLocalBrowserProfileOutOfCentral(
  userDir: string = USER_DIR,
  machine: string = machineId(),
): void {
  const metaFile = path.join(userDir, 'agents.yaml');
  if (!fs.existsSync(metaFile)) return;

  let doc: yaml.Document.Parsed;
  try {
    doc = yaml.parseDocument(fs.readFileSync(metaFile, 'utf-8'));
  } catch { return; }
  if (doc.errors.length > 0) return;

  const central = (doc.toJSON() as Record<string, unknown> | null) ?? {};
  const browser = central.browser;
  if (!browser || typeof browser !== 'object' || Array.isArray(browser)) return;
  const entry = (browser as Record<string, unknown>)[LEGACY_DEFAULT_BROWSER_PROFILE_NAME];
  if (entry === undefined) return;

  // Device file first — a crash before central is rewritten leaves a harmless
  // duplicate, while the reverse order would drop the profile entirely.
  const devicePath = path.join(userDir, 'devices', machine, 'agents.yaml');
  let deviceDoc: Record<string, unknown> = {};
  try {
    deviceDoc = (yaml.parse(fs.readFileSync(devicePath, 'utf-8')) as Record<string, unknown>) || {};
  } catch { /* absent — first write */ }
  const deviceBrowser = (deviceDoc.browser && typeof deviceDoc.browser === 'object' && !Array.isArray(deviceDoc.browser))
    ? deviceDoc.browser as Record<string, unknown>
    : {};
  if (deviceBrowser[LEGACY_DEFAULT_BROWSER_PROFILE_NAME] === undefined) {
    deviceBrowser[LEGACY_DEFAULT_BROWSER_PROFILE_NAME] = entry;
    deviceDoc.browser = deviceBrowser;
    fs.mkdirSync(path.dirname(devicePath), { recursive: true });
    atomicWriteFileSync(devicePath, DEVICE_META_HEADER + yaml.stringify(deviceDoc));
  }

  // Then strip it from the synced file, dropping `browser:` entirely when the
  // machine-local entry was its only member.
  doc.deleteIn(['browser', LEGACY_DEFAULT_BROWSER_PROFILE_NAME]);
  if (Object.keys(browser as Record<string, unknown>).length === 1) {
    // A comment block sitting directly above `browser:` with no blank line is
    // attached to that pair's KEY node, so deleting the key takes those lines
    // with it — including the file header. Re-home them onto whatever key is
    // now first, or this migration silently destroys the comments it exists to
    // preserve. (Not `doc.get('browser', true)`: that returns the VALUE node,
    // which never carries the comment.)
    type Keyed = { key?: { value?: unknown; commentBefore?: string | null } };
    const itemsOf = (): Keyed[] => ((doc.contents as { items?: Keyed[] } | null)?.items) ?? [];
    const idx = itemsOf().findIndex((pair) => pair.key?.value === 'browser');
    const orphaned = idx >= 0 ? itemsOf()[idx]?.key?.commentBefore ?? undefined : undefined;
    doc.delete('browser');
    if (orphaned) {
      // Deleting shifted the following pair down into `idx`.
      const next = itemsOf()[idx]?.key;
      if (next) next.commentBefore = next.commentBefore ? `${orphaned}\n${next.commentBefore}` : orphaned;
      else doc.commentBefore = orphaned;
    }
  }
  // Everything cleared -> header only, never a bare `{}`. stringifyDoc emits a
  // FLOW empty map for an empty root, and a later parseDocument inherits that
  // flow and renders the whole rewritten file inline. serializeCentral guards
  // the identical case (state.ts, `isEmpty ? META_HEADER : stringifyDoc(doc)`).
  const remaining = Object.keys((doc.toJSON() as Record<string, unknown> | null) ?? {}).length;
  atomicWriteFileSync(metaFile, remaining === 0 ? DEVICE_META_HEADER : stringifyDoc(doc));
  console.error(`Migrated agents.yaml: browser '${LEGACY_DEFAULT_BROWSER_PROFILE_NAME}' profile -> devices/${machine}/agents.yaml`);
}

/** Rename the legacy `extras-extras/` plugin marketplace dir to `agents-extras/` in every installed version home, and rewrite cross-references in `known_marketplaces.json` and `settings.json`. */
export function migrateExtrasExtrasToAgentsExtras(historyDir: string = HISTORY_DIR): void {
  const versionsRoot = path.join(historyDir, 'versions');
  if (!fs.existsSync(versionsRoot)) return;

  const OLD = 'extras-extras';
  const NEW = 'agents-extras';

  let agentEntries: fs.Dirent[];
  try {
    agentEntries = fs.readdirSync(versionsRoot, { withFileTypes: true });
  } catch { return; }

  let renamedDirs = 0;
  let rewroteKnown = 0;
  let rewroteSettings = 0;

  for (const agentEntry of agentEntries) {
    if (!agentEntry.isDirectory()) continue;
    const agentId = agentEntry.name;
    const agentVersionsDir = path.join(versionsRoot, agentId);

    let verEntries: fs.Dirent[];
    try {
      verEntries = fs.readdirSync(agentVersionsDir, { withFileTypes: true });
    } catch { continue; }

    for (const ver of verEntries) {
      if (!ver.isDirectory()) continue;
      const configDir = path.join(agentVersionsDir, ver.name, 'home', `.${agentId}`);
      const pluginsDir = path.join(configDir, 'plugins');
      if (!fs.existsSync(pluginsDir)) continue;

      const marketplacesDir = path.join(pluginsDir, 'marketplaces');
      const oldDir = path.join(marketplacesDir, OLD);
      const newDir = path.join(marketplacesDir, NEW);
      const oldExists = fs.existsSync(oldDir);
      const newExists = fs.existsSync(newDir);

      if (oldExists && !newExists) {
        try {
          fs.renameSync(oldDir, newDir);
          renamedDirs++;
        } catch { /* best-effort, leave orphan */ }
      } else if (oldExists && newExists) {
        // Previous incomplete migration — drop the stale old dir.
        try { fs.rmSync(oldDir, { recursive: true, force: true }); } catch { /* best-effort */ }
      }

      // Rewrite marketplace.json name field inside the (now) agents-extras dir.
      const marketplaceJson = path.join(newDir, '.claude-plugin', 'marketplace.json');
      if (fs.existsSync(marketplaceJson)) {
        try {
          const raw = fs.readFileSync(marketplaceJson, 'utf-8');
          const parsed = JSON.parse(raw) as Record<string, unknown>;
          if (parsed?.name === OLD) {
            parsed.name = NEW;
            fs.writeFileSync(marketplaceJson, JSON.stringify(parsed, null, 2) + '\n', 'utf-8');
          }
        } catch { /* best-effort */ }
      }

      // Rewrite known_marketplaces.json key + path fields.
      const knownFile = path.join(pluginsDir, 'known_marketplaces.json');
      if (fs.existsSync(knownFile)) {
        try {
          const raw = fs.readFileSync(knownFile, 'utf-8');
          const known = JSON.parse(raw) as Record<string, {
            source?: { source?: string; path?: string; repo?: string };
            installLocation?: string;
            lastUpdated?: string;
          }>;
          if (known && typeof known === 'object' && OLD in known) {
            const entry = known[OLD];
            if (!(NEW in known)) {
              if (entry?.source?.path) entry.source.path = entry.source.path.split(OLD).join(NEW);
              if (entry?.installLocation) entry.installLocation = entry.installLocation.split(OLD).join(NEW);
              known[NEW] = entry;
            }
            delete known[OLD];
            fs.writeFileSync(knownFile, JSON.stringify(known, null, 2) + '\n', 'utf-8');
            rewroteKnown++;
          }
        } catch { /* best-effort */ }
      }

      // Rewrite settings.json enabledPlugins keys.
      const settingsFile = path.join(configDir, 'settings.json');
      if (fs.existsSync(settingsFile)) {
        try {
          const raw = fs.readFileSync(settingsFile, 'utf-8');
          const settings = JSON.parse(raw) as Record<string, unknown>;
          const enabled = settings?.enabledPlugins as Record<string, boolean> | undefined;
          if (enabled && typeof enabled === 'object') {
            const suffix = `@${OLD}`;
            const newSuffix = `@${NEW}`;
            let changed = false;
            for (const key of Object.keys(enabled)) {
              if (!key.endsWith(suffix)) continue;
              const renamed = key.slice(0, -suffix.length) + newSuffix;
              if (renamed in enabled) {
                delete enabled[key];
              } else {
                enabled[renamed] = enabled[key];
                delete enabled[key];
              }
              changed = true;
            }
            if (changed) {
              fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 2) + '\n', 'utf-8');
              rewroteSettings++;
            }
          }
        } catch { /* best-effort */ }
      }
    }
  }

  if (renamedDirs > 0 || rewroteKnown > 0 || rewroteSettings > 0) {
    console.error(`Renamed extras-extras → agents-extras (dirs: ${renamedDirs}, known_marketplaces: ${rewroteKnown}, settings: ${rewroteSettings})`);
  }
}

/**
 * Rewrite every routine YAML that carries the legacy singular `device: <value>`
 * field to the new plural `devices: [<value>]` format. Preserves all other
 * fields. Idempotent: a routine that already has `devices:` (or neither field)
 * is left untouched.
 *
 * Params default to the real routines dir; injectable for tests.
 */
export function migrateRoutineDeviceToDevices(routinesDir?: string): void {
  const dir = routinesDir ?? path.join(USER_DIR, 'routines');
  if (!fs.existsSync(dir)) return;

  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'));

  let migrated = 0;
  for (const file of files) {
    const filePath = path.join(dir, file);
    const raw = fs.readFileSync(filePath, 'utf-8');

    let doc: Record<string, unknown>;
    try {
      doc = yaml.parse(raw) as Record<string, unknown>;
      if (!doc || typeof doc !== 'object') continue;
    } catch { continue; }

    if (!('device' in doc)) continue;
    if ('devices' in doc) {
      delete doc.device;
      atomicWriteFileSync(filePath, yaml.stringify(doc));
      continue;
    }

    const val = doc.device;
    if (typeof val !== 'string' || !val.trim()) {
      throw new Error(`${file}: legacy 'device' field is not a valid device name — repair the file and retry`);
    }
    delete doc.device;
    doc.devices = [val.trim()];

    atomicWriteFileSync(filePath, yaml.stringify(doc));
    migrated++;
  }

  if (migrated > 0) {
    console.error(`Migrated ${migrated} routine${migrated === 1 ? '' : 's'}: device → devices`);
  }
}

/**
 * Fold the legacy host-placement `remoteCwd` field into the canonical portable
 * `cwd` (RUSH-2290). Host dispatch used to read `remoteCwd` while a local run
 * inferred its cwd from `repo` — two path semantics for one concept. The runner
 * now resolves every placement from `cwd`, so this idempotently rewrites the
 * field:
 *
 * - `remoteCwd` present, no `cwd`  → rename to `cwd`.
 * - both present and equal          → drop the duplicate `remoteCwd`.
 * - both present and DIFFERENT       → conflict: leave BOTH fields untouched so
 *   the migration never silently chooses one; `validateJob`/`doctor` then flag the
 *   pair and the routine stays paused rather than running against a guessed path.
 *
 * Idempotent: a file with only `cwd` (already migrated) is skipped.
 */
export function migrateRoutineRemoteCwdToCwd(routinesDir?: string): void {
  const dir = routinesDir ?? path.join(USER_DIR, 'routines');
  if (!fs.existsSync(dir)) return;

  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'));

  let migrated = 0;
  let conflicts = 0;
  for (const file of files) {
    const filePath = path.join(dir, file);
    const raw = fs.readFileSync(filePath, 'utf-8');

    let doc: Record<string, unknown>;
    try {
      doc = yaml.parse(raw) as Record<string, unknown>;
      if (!doc || typeof doc !== 'object') continue;
    } catch { continue; }

    if (!('remoteCwd' in doc)) continue;
    const remote = doc.remoteCwd;
    if (typeof remote !== 'string' || !remote.trim()) {
      // A malformed legacy value is not something to fold — drop it and move on.
      delete doc.remoteCwd;
      atomicWriteFileSync(filePath, yaml.stringify(doc));
      continue;
    }

    if ('cwd' in doc) {
      if (doc.cwd === remote) {
        delete doc.remoteCwd; // duplicate — dedupe to the canonical field
        atomicWriteFileSync(filePath, yaml.stringify(doc));
        migrated++;
      } else {
        conflicts++; // leave both fields; validateJob/doctor pause the conflict
      }
      continue;
    }

    delete doc.remoteCwd;
    doc.cwd = remote;
    atomicWriteFileSync(filePath, yaml.stringify(doc));
    migrated++;
  }

  if (migrated > 0) {
    console.error(`Migrated ${migrated} routine${migrated === 1 ? '' : 's'}: remoteCwd → cwd`);
  }
  if (conflicts > 0) {
    console.error(`${conflicts} routine${conflicts === 1 ? '' : 's'} have conflicting remoteCwd/cwd — left paused for manual repair (migration_conflict)`);
  }
}

/**
 * Pause every currently-active routine whose execution context no longer
 * resolves ready (RUSH-2290). An agent/workflow routine with no project/cwd, a
 * missing directory, or a non-portable path used to fire and fail every tick —
 * the mass auth_failed / untrusted-home storm this ticket exists to stop. After
 * the fold, such a routine is deactivated on THIS device (only), preventing it
 * from being scheduled until `agents routines doctor --all --fix` (or a repair +
 * `resume`) makes it ready. Never materializes a device manifest that does not
 * yet exist, and never touches command routines (they run in the target home).
 */
function pauseUnreadyEnabledRoutines(): void {
  const enabled = enabledRoutineNames();
  if (enabled === null) return; // no manifest yet — nothing activated to pause
  const enabledSet = new Set(enabled);
  const paused: string[] = [];
  for (const job of listJobs()) {
    if (!enabledSet.has(job.name)) continue;
    let ready = true;
    try {
      ready = validateJob(job).length === 0 && evaluateActivationReadiness(job).ready;
    } catch {
      ready = true; // never pause a routine because readiness itself threw
    }
    if (!ready) paused.push(job.name);
  }
  if (paused.length === 0) return;
  const pausedSet = new Set(paused);
  replaceEnabledRoutines(enabled.filter((name) => !pausedSet.has(name)));
  console.error(
    `Paused ${paused.length} routine${paused.length === 1 ? '' : 's'} with an unresolved execution context ` +
    `(run 'agents routines doctor --all' to see why): ${paused.join(', ')}`,
  );
}

/**
 * Fold the legacy watchdog enable sentinel into the `watchdog.enabled` config.
 *
 * The always-on watchdog used to be gated by a presence sentinel at
 * `<runtime-state>/watchdog/enabled`; it is now a daemon-owned timer (RUSH-2495)
 * gated by the `watchdog.enabled` device-config flag — the same flag
 * `agents watchdog enable` writes. A user who had run `agents watchdog enable`
 * under the old build has that file on disk; without this, upgrading would
 * silently drop them back to OFF (the nudge just stops), the worst failure mode
 * for a "survives reboots" feature. If the sentinel exists, set
 * `watchdog.enabled: true`, then delete the sentinel so this runs exactly once.
 * If setting it fails, the sentinel is left in place so a later run retries
 * rather than silently losing the opt-in.
 *
 * The setter seam is injectable so the migration is unit-testable without
 * touching the real device config.
 */
export function migrateWatchdogSentinelToConfig(
  sentinelPath: string = path.join(CACHE_DIR, 'state', 'watchdog', 'enabled'),
  enable: (value: boolean) => void = (value) => setConfigValue('watchdog.enabled', value),
): void {
  if (!fs.existsSync(sentinelPath)) return;
  try {
    enable(true);
  } catch (err) {
    console.error(
      `watchdog sentinel migration: could not set watchdog.enabled (${(err as Error).message}); leaving the sentinel for a later retry`,
    );
    return;
  }
  try { fs.rmSync(sentinelPath); } catch { /* already gone */ }
  console.error('Migrated watchdog: legacy enable sentinel → watchdog.enabled config (kept enabled)');
}

/**
 * Rename cli/ → clis/ in each of the given `.agents/` directories.
 *
 * One-way, idempotent: no-op when src is absent. Throws when both
 * `<dir>/cli` and `<dir>/clis` exist — the user must resolve the conflict
 * manually before proceeding. Exported for unit-testing with temp dirs.
 */
export function migrateCliDirToClis(agentsDirs: string[]): void {
  for (const agentsDir of agentsDirs) {
    const src = path.join(agentsDir, 'cli');
    const dest = path.join(agentsDir, 'clis');
    if (!fs.existsSync(src)) continue;
    if (fs.existsSync(dest)) {
      throw new Error(
        `Migration conflict: both ${src} and ${dest} exist. ` +
        `Remove or merge the old cli/ directory into clis/ manually.`,
      );
    }
    fs.renameSync(src, dest);
  }
}

/**
 * Migrate owner identity into humans.yaml.
 *
 * Sources (both are optional; migration is a no-op when neither exists):
 *   1. ~/.agents/agents.yaml notify.owner.{channel,to} — short-form notify config.
 *   2. ~/.agents/owner.md  — YAML frontmatter with name/timezone/quiet_hours/channels/policy.
 *
 * Writes ~/.agents/humans.yaml (version: 1) when at least one source is
 * present, then removes the migrated keys. Idempotent: exits immediately when
 * humans.yaml already exists.
 */
function migrateHumans(): void {
  const humansFile = path.join(USER_DIR, 'humans.yaml');
  if (fs.existsSync(humansFile)) return;

  const agentsYamlPath = path.join(USER_DIR, 'agents.yaml');
  const ownerMdPath = path.join(USER_DIR, 'owner.md');

  let notifyOwner: { channel: string; to: string } | undefined;
  let ownerName: string | undefined;
  let ownerTimezone: string | undefined;
  let ownerQuietHours: string | undefined;
  let ownerDefaultSeverity: string | undefined;
  let ownerChannels: unknown[] | undefined;
  let ownerPolicy: unknown | undefined;

  // 1. Read notify.owner from agents.yaml.
  if (fs.existsSync(agentsYamlPath)) {
    try {
      const raw = fs.readFileSync(agentsYamlPath, 'utf-8');
      const doc = yaml.parse(raw) as Record<string, unknown> | null;
      const notify = doc?.['notify'] as Record<string, unknown> | undefined;
      const owner = notify?.['owner'] as Record<string, unknown> | undefined;
      const channel = typeof owner?.['channel'] === 'string' ? owner['channel'] : undefined;
      const to = typeof owner?.['to'] === 'string' ? owner['to'] : undefined;
      if (channel && to) {
        notifyOwner = { channel, to };
      }
    } catch { /* best-effort */ }
  }

  // 2. Read YAML frontmatter from owner.md.
  if (fs.existsSync(ownerMdPath)) {
    try {
      const raw = fs.readFileSync(ownerMdPath, 'utf-8');
      const fmMatch = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/);
      if (fmMatch) {
        const fm = yaml.parse(fmMatch[1]) as Record<string, unknown> | null;
        if (fm && typeof fm === 'object') {
          if (typeof fm['name'] === 'string') ownerName = fm['name'];
          if (typeof fm['timezone'] === 'string') ownerTimezone = fm['timezone'];
          if (typeof fm['quiet_hours'] === 'string') ownerQuietHours = fm['quiet_hours'];
          if (typeof fm['default_severity'] === 'string') ownerDefaultSeverity = fm['default_severity'];
          if (Array.isArray(fm['channels'])) ownerChannels = fm['channels'] as unknown[];
          if (fm['policy'] && typeof fm['policy'] === 'object') ownerPolicy = fm['policy'];
        }
      }
    } catch { /* best-effort */ }
  }

  // Only write if we have at least one piece of owner data.
  if (!notifyOwner && !ownerName && !ownerTimezone && !ownerQuietHours && !ownerDefaultSeverity && !ownerChannels && !ownerPolicy) return;

  const humansDoc: Record<string, unknown> = { version: 1 };
  const ownerDoc: Record<string, unknown> = {};
  if (ownerName) ownerDoc['name'] = ownerName;
  if (ownerTimezone) ownerDoc['timezone'] = ownerTimezone;
  if (ownerQuietHours) ownerDoc['quiet_hours'] = ownerQuietHours;
  if (ownerDefaultSeverity) ownerDoc['default_severity'] = ownerDefaultSeverity;
  if (notifyOwner) ownerDoc['notify'] = notifyOwner;
  if (ownerChannels) ownerDoc['channels'] = ownerChannels;
  if (ownerPolicy) ownerDoc['policy'] = ownerPolicy;
  humansDoc['owner'] = ownerDoc;

  try {
    const header = '# humans.yaml — owner identity and notification channels\n# Managed by agents-cli. See: agents humans --help\n';
    fs.writeFileSync(humansFile, header + yaml.stringify(humansDoc, { lineWidth: 120 }), { encoding: 'utf-8', mode: 0o600 });
    console.error('Migrated owner config to humans.yaml');
  } catch (err) {
    console.error(`humans.yaml migration: could not write (${(err as Error).message})`);
    return;
  }

  // Remove notify.owner from agents.yaml after successful migration.
  if (notifyOwner && fs.existsSync(agentsYamlPath)) {
    try {
      const raw = fs.readFileSync(agentsYamlPath, 'utf-8');
      const doc = yaml.parseDocument(raw);
      const notifyNode = doc.get('notify') as yaml.YAMLMap | null;
      if (notifyNode instanceof yaml.YAMLMap) {
        notifyNode.delete('owner');
        if (notifyNode.items.length === 0) doc.delete('notify');
      }
      // `flowCollectionPadding: false` keeps committed flow sequences unpadded
      // (`[a, b]`, not `[ a, b ]`) so re-emitting agents.yaml here does not dirty
      // the synced ~/.agents tree and block pulls (RUSH-2505).
      fs.writeFileSync(agentsYamlPath, stringifyDoc(doc), 'utf-8');
    } catch { /* best-effort — leave the old key if we can't rewrite */ }
  }
}

/**
 * An earlier agents-cli release put Cursor's file-backed OAuth token at
 * ~/.config/cursor/auth.json. Current Cursor actually writes the file store to
 * HOME-relative ~/.cursor/auth.json. Copy that legacy token into the active
 * account's version home. The active account
 * is the home the ~/.cursor symlink currently targets. Idempotent: skips when
 * the home already has its own token, and a no-op for unmanaged Cursor installs
 * (where ~/.cursor is a real dir, not a symlink into a version home).
 */
export function seedActiveCursorLoginPerVersion(): void {
  const realHome = process.env.AGENTS_REAL_HOME || os.homedir();
  const globalAuth = path.join(realHome, '.config', 'cursor', 'auth.json');
  let versionHome: string;
  try {
    if (!fs.existsSync(globalAuth)) return;
    // ~/.cursor -> .../versions/cursor/<version>/home/.cursor ; the version home
    // is that link's parent directory.
    const link = fs.readlinkSync(path.join(realHome, '.cursor'));
    const resolved = path.isAbsolute(link) ? link : path.resolve(realHome, link);
    versionHome = path.dirname(resolved);
  } catch {
    return; // not a symlink (unmanaged install) or unreadable — nothing to seed
  }
  if (!versionHome.includes(path.join('versions', 'cursor'))) return;
  const dest = path.join(versionHome, '.cursor', 'auth.json');
  try {
    if (fs.existsSync(dest)) return;
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(globalAuth, dest);
  } catch { /* best-effort — a failed seed just means one re-login */ }
}

/**
 * Fold the pre-markdown Kimi subagent layout out of every kimi version home.
 *
 * agents-cli used to write each Kimi subagent as a `<name>.yaml` +
 * `<name>.system.md` pair plus a managed `_agents-cli.yaml` index, against the
 * agentspec of `kimi-cli` — a different product from the `kimi-code` harness we
 * install, which never read any of it. Those files are inert, but not harmless:
 * `<name>.system.md` ends in `.md`, so the subagent enumerator would surface it
 * as a phantom subagent named `<name>.system`, and kimi-code logs
 * `Missing frontmatter` for it once per session.
 *
 * This is the ONE place that knows about the old layout — the registry target
 * describes only the current `<name>.md` shape. A pair is identified by its
 * signature (a `<name>.yaml` with a sibling `<name>.system.md`), so a subagent a
 * user legitimately named e.g. `foo.system` is never touched: it has no
 * `foo.yaml` beside it. Idempotent; a no-op once the dirs are clean.
 */
export function migrateKimiSubagentsToMarkdown(versionsDir?: string): void {
  const kimiVersions = path.join(versionsDir ?? path.join(HISTORY_DIR, 'versions'), 'kimi');
  let versions: string[];
  try {
    versions = fs.readdirSync(kimiVersions);
  } catch {
    return; // no kimi installed
  }

  let removed = 0;
  for (const version of versions) {
    const dir = path.join(kimiVersions, version, 'home', '.kimi-code', 'agents');
    let entries: string[];
    try {
      entries = fs.readdirSync(dir);
    } catch {
      continue;
    }
    const present = new Set(entries);
    const doomed: string[] = [];
    for (const entry of entries) {
      if (entry === '_agents-cli.yaml') {
        doomed.push(entry); // reserved managed index, only ever written by us
        continue;
      }
      if (!entry.endsWith('.yaml')) continue;
      const base = entry.slice(0, -'.yaml'.length);
      // Only a genuine legacy pair — a bare .yaml with no sibling prompt is not
      // ours to delete.
      if (!present.has(`${base}.system.md`)) continue;
      doomed.push(entry, `${base}.system.md`);
    }
    for (const entry of doomed) {
      try {
        fs.rmSync(path.join(dir, entry), { force: true });
        removed++;
      } catch {
        // leave it; the next run retries
      }
    }
  }

  if (removed > 0) {
    console.error(`Removed ${removed} pre-markdown Kimi subagent file(s); run 'agents sync kimi' to write the new format`);
  }
}

/**
 * Remove the compiled "project" ruleset the compiler used to write into $HOME
 * (RUSH-2725). `compileRulesForProject` treated any cwd with `.agents/rules`
 * as a project — and the user layer at ~/.agents satisfies that test — so it
 * wrote ~/AGENTS.md plus per-agent symlinks, and every session under $HOME
 * then loaded the entire ruleset twice (global memory + "project" memory).
 * The compiler now refuses reserved roots; this removes the artifact already
 * on disk. Only files we provably own are touched: an AGENTS.md carrying the
 * compiled-project header, symlinks pointing at it, and copy-fallback files
 * (symlink-less filesystems) carrying the same header.
 */
export function removeHomeCompiledProjectRules(homeDir: string = HOME): void {
  const agentsPath = path.join(homeDir, 'AGENTS.md');
  let agentsLstat: fs.Stats;
  try { agentsLstat = fs.lstatSync(agentsPath); } catch { return; }
  if (!agentsLstat.isFile()) return;
  let content = '';
  try { content = fs.readFileSync(agentsPath, 'utf8'); } catch { return; }
  if (!content.startsWith(COMPILED_HEADER_PROJECT)) return;

  const seen = new Set<string>(['AGENTS.md']);
  for (const agent of Object.values(AGENTS)) {
    const fname = agent.instructionsFile;
    if (seen.has(fname) || fname.includes('/') || fname.includes('\\')) continue;
    seen.add(fname);
    const linkPath = path.join(homeDir, fname);
    let lstat: fs.Stats;
    try { lstat = fs.lstatSync(linkPath); } catch { continue; }
    if (lstat.isSymbolicLink()) {
      let target = '';
      try { target = fs.readlinkSync(linkPath); } catch { continue; }
      if (target === 'AGENTS.md') {
        try { fs.unlinkSync(linkPath); } catch { /* next run retries */ }
      }
    } else if (lstat.isFile()) {
      // Symlink-less filesystems got a copy of AGENTS.md instead — same header.
      let copy = '';
      try { copy = fs.readFileSync(linkPath, 'utf8'); } catch { continue; }
      if (copy.startsWith(COMPILED_HEADER_PROJECT)) {
        try { fs.unlinkSync(linkPath); } catch { /* next run retries */ }
      }
    }
  }

  try { fs.unlinkSync(agentsPath); } catch { /* next run retries */ }
}

/** Run all idempotent migrations. Safe to call multiple times. */
export async function runMigration(): Promise<void> {
  // MUST run first: every other migrator reads SYSTEM_DIR (the new path).
  foldLegacySystemRepo();
  const cliMigrateDirs = [USER_DIR, SYSTEM_DIR];
  const projectDotAgents = path.join(process.cwd(), '.agents');
  if (fs.existsSync(projectDotAgents)) cliMigrateDirs.push(projectDotAgents);
  migrateCliDirToClis(cliMigrateDirs);
  migrateAgentsYaml();
  migrateHumans();
  deleteSystemPromptsJson();
  migrateSystemConfigJson();
  detrackUserChangelog();
  migratePromptcutsIntoHooks();
  migrateSystemVersionsToUser();
  mergeOverlappingVersionHomes();
  // Cursor runs now isolate the login per version home; preserve the current
  // login by seeding the active home's token from the legacy global copy.
  seedActiveCursorLoginPerVersion();
  // Drop the pre-markdown Kimi subagent files; the registry now writes <name>.md.
  migrateKimiSubagentsToMarkdown();
  migrateRunsIntoRoutines();
  migrateTrashToHidden();
  migrateBackupsToHidden();
  migrateAliasesToUser();
  migratePermissionSetsToPresets();
  deleteUserLinearJson();
  deleteUserPromptsJson();
  deleteTeamsConfigJson();
  moveTeamsRegistryToHistory();
  cleanupUserConfigJson();
  cleanupEmptyTopLevelRuns();
  foldUserHooksYamlIntoAgentsYaml();
  foldBrowserProfilesIntoAgentsYaml();
  migrateVersionResourcesToPatterns();
  // Split machine-local fields (agents:/versions:) out of the committed central
  // agents.yaml. After migrateVersionResourcesToPatterns so versions: is already
  // in pattern form when it moves to the history file.
  migrateSplitDeviceLocalMeta();
  // Same split, one level deeper: `browser` stays central (named profiles are
  // fleet config) but its auto-detected `default` entry is machine-local and was
  // left behind in the synced file, keeping every box dirty. After
  // migrateSplitDeviceLocalMeta so the device file is already in its canonical
  // location before this merges an entry into it.
  migrateMachineLocalBrowserProfileOutOfCentral();
  // Converge the device-config/pins stores: fold the central
  // fleet.devices.<name>.config block + legacy auto-launch.json into the
  // per-device docs' config:, and extract pins from tracked docs into the
  // untracked pins JSON. After migrateSplitDeviceLocalMeta so the pins file is
  // in its canonical location. Also invoked on daemon boot and on the first
  // device-config read/write in a process, so sentinel'd installs (which skip
  // this whole run) still converge.
  migrateDeviceConfigStores();
  // Bucket moves: collapse runtime state into ~/.agents/.history and ~/.agents/.cache.
  migrateRuntimeToHistory();
  migrateLegacySessionMarkersToBookmarks();
  migrateRuntimeToCache();
  // Restore plugins (user-authored) from cache back to user-root. Runs AFTER
  // migrateRuntimeToCache so any legacy plugins/ still at the user-root from
  // very-old layouts have already been handled.
  migratePluginsBackToUserRoot();
  // Browser captures: fold the legacy global browser/sessions/<task> root into the
  // per-profile browser/<profile>/sessions/<task> layout. After the cache moves so
  // the browser dir is at its canonical .cache location.
  foldBrowserSessionsIntoProfiles();

  // System-repo sweep: move every remaining operational dir into its canonical
  // user-bucket location, then drop known-dead artifacts and warn about
  // anything we don't recognize. Order: durable (sessions/teams/trash/repos/
  // legacy-swarm) -> caches (cache/, cloud/) -> drops -> orphan check.
  await migrateSystemSessionsToHistory();
  migrateSystemTeamsToUser();
  migrateSystemTrashToHistory();
  migrateLegacySwarmToTeams();
  migrateSystemReposToPeerDirs();
  await migrateSystemCacheToUserCache();
  await migrateSystemCloudToCache();
  dropDeadSystemArtifacts();
  warnSystemOrphans();

  // Rename the legacy extras-extras marketplace dir to agents-extras across every
  // installed version-home. Runs after migrateRuntimeToHistory so the version
  // homes are at their canonical HISTORY_DIR location.
  migrateExtrasExtrasToAgentsExtras();

  // Rewrite routine YAML files: singular `device:` -> plural `devices: []`.
  migrateRoutineDeviceToDevices();
  // Fold legacy host-placement `remoteCwd` into the canonical portable `cwd`.
  migrateRoutineRemoteCwdToCwd();
  migrateLegacyRoutineActivation();

  // Fold the legacy watchdog enable sentinel into `watchdog.enabled` config so a
  // user who opted in under the old build stays opted in after upgrading.
  migrateWatchdogSentinelToConfig();
  // Delete the compiled "project" ruleset older builds wrote into $HOME — the
  // duplicate-injection artifact of RUSH-2725. The compiler no longer writes
  // it; this cleans up what is already on every machine.
  removeHomeCompiledProjectRules();
  // Deactivate any routine whose execution context no longer resolves ready, so
  // an anchor-less agent/workflow routine cannot keep firing-and-failing after the
  // fold (RUSH-2290). Runs AFTER the tick/watchdog routines are added so those
  // (command/home) routines are evaluated in their final shape.
  pauseUnreadyEnabledRoutines();

  // Symlink repair runs LAST so it can find the post-move version homes.
  repairAgentConfigSymlinks();
  // Repair self-referential node_modules/.bin/<cli> symlinks (the droid
  // infinite-exec-loop). Also runs after the bucket moves so it scans the
  // canonical HISTORY_DIR/versions tree.
  repairSelfReferentialBinShims();

  // Version-skew one-shot (RUSH-2435): retrofit the current pane-died hook
  // onto any managed tmux session an older binary left with a stale one. Runs
  // at upgrade time in addition to the daemon-startup call (daemon.ts) so a
  // machine that upgrades without immediately restarting its daemon still
  // repairs on the next `agents` invocation. Idempotent/non-destructive.
  try {
    const { reconcileSessionHooks } = await import('../tmux/session.js');
    const { isTmuxInstalled } = await import('../tmux/binary.js');
    if (isTmuxInstalled()) await reconcileSessionHooks();
  } catch {
    // best-effort — a migration must never fail because tmux wasn't reachable
  }

  // PHNX-3940 T7: report leftover per-account installations. Dry-run only —
  // moving homes requires an explicit `agents accounts migrate --apply`.
  try {
    const { reportAccountSlotMigrationOnUpgrade } = await import('../accounts/migrate.js');
    await reportAccountSlotMigrationOnUpgrade();
  } catch {
    // best-effort — a corrupt install must not block the rest of upgrade
  }
}
