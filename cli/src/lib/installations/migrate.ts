
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
import { META_HEADER as DEVICE_META_HEADER, commitCentralConfig } from '../state.js';

const LEGACY_DEFAULT_BROWSER_PROFILE_NAME = 'default';
import { COMPILED_HEADER_PROJECT } from '../rules/compile.js';
import { putOwnerPreferences, resolveOwnerCredential, type OwnerChannel, type OwnerEvent, type OwnerPreferencesPatch } from '../owner-notify.js';
import { moveFileToTrash } from '../trash.js';

const HOME = process.env.HOME ?? os.homedir();
const USER_DIR = path.join(HOME, '.agents');
const SYSTEM_DIR = path.join(USER_DIR, '.system');
const HISTORY_DIR = path.join(USER_DIR, '.history');
const CACHE_DIR = path.join(USER_DIR, '.cache');

function isTrackedInGitRepo(repoDir: string, relPath: string): boolean {
  try {
    execSync(`git ls-files --error-unmatch -- ${relPath}`, { cwd: repoDir, stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

export function migrateAgentsYaml(systemDir: string = SYSTEM_DIR, userDir: string = USER_DIR): void {
  const src = path.join(systemDir, 'agents.yaml');
  const dest = path.join(userDir, 'agents.yaml');
  if (!fs.existsSync(src)) return;

  if (isTrackedInGitRepo(systemDir, 'agents.yaml')) return;

  if (fs.existsSync(dest)) {
    try { fs.unlinkSync(src); } catch {  }
    return;
  }
  try {
    fs.mkdirSync(userDir, { recursive: true, mode: 0o700 });
    fs.renameSync(src, dest);
    console.error('Migrated agents.yaml to ~/.agents/');
  } catch {  }
}

function deleteSystemPromptsJson(): void {
  const f = path.join(SYSTEM_DIR, 'prompts.json');
  if (!fs.existsSync(f)) return;
  try {
    fs.unlinkSync(f);
  } catch {  }
}

export function detrackUserChangelog(userDir: string = USER_DIR): void {
  if (!fs.existsSync(path.join(userDir, '.git'))) return;
  const untracked = detrackViaGitExclude(userDir, 'CHANGELOG.md');
  if (untracked) console.error('Stopped tracking ~/.agents/CHANGELOG.md (duplicates .system/CHANGELOG.md)');
}

function migrateSystemConfigJson(): void {
  const src = path.join(SYSTEM_DIR, 'config.json');
  if (!fs.existsSync(src)) return;
  try {
    fs.unlinkSync(src);
  } catch {  }
}

function migratePromptcutsIntoHooks(): void {
  for (const root of [SYSTEM_DIR, USER_DIR]) {
    const src = path.join(root, 'promptcuts.yaml');
    const dest = path.join(root, 'hooks', 'promptcuts.yaml');
    if (fs.existsSync(dest) || !fs.existsSync(src)) continue;
    try {
      fs.mkdirSync(path.dirname(dest), { recursive: true, mode: 0o700 });
      fs.renameSync(src, dest);
    } catch {  }
  }
}

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
    } catch {  }

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
      } catch {  }
    }
    try {
      if (fs.readdirSync(srcAgentDir).length === 0) fs.rmdirSync(srcAgentDir);
    } catch {  }
  }

  try {
    if (fs.readdirSync(sysVersions).length === 0) fs.rmdirSync(sysVersions);
  } catch {  }

  if (movedCount > 0) {
    console.error(`Migrated ${movedCount} version dir${movedCount === 1 ? '' : 's'} from ~/.agents-system/versions/ to ~/.agents/versions/`);
  }
  if (skippedCount > 0) {
    console.error(`Skipped ${skippedCount} version dir${skippedCount === 1 ? '' : 's'} already present in ~/.agents/versions/ (kept legacy copy at ~/.agents-system/versions/)`);
  }
}

function migrateRunsIntoRoutines(): void {
  const src = path.join(USER_DIR, 'runs');
  const dest = path.join(USER_DIR, 'routines', 'runs');
  if (!fs.existsSync(src) || fs.existsSync(dest)) return;
  try {
    fs.mkdirSync(path.dirname(dest), { recursive: true, mode: 0o700 });
    fs.renameSync(src, dest);
  } catch {  }
}

function migrateTrashToHidden(): void {
  const src = path.join(USER_DIR, 'trash');
  const dest = path.join(USER_DIR, '.trash');
  if (!fs.existsSync(src) || fs.existsSync(dest)) return;
  try {
    fs.renameSync(src, dest);
  } catch {  }
}

function migrateBackupsToHidden(): void {
  const src = path.join(USER_DIR, 'backups');
  const dest = path.join(USER_DIR, '.backups');
  if (!fs.existsSync(src) || fs.existsSync(dest)) return;
  try {
    fs.renameSync(src, dest);
  } catch {  }
}

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
  } catch {  }
}

export function foldBrowserSessionsIntoProfiles(browserDir: string = path.join(CACHE_DIR, 'browser')): void {
  const legacySessionsDir = path.join(browserDir, 'sessions');

  let taskDirs: fs.Dirent[];
  try {
    taskDirs = fs.readdirSync(legacySessionsDir, { withFileTypes: true });
  } catch {
    return;
  }

  const taskOwner = new Map<string, string>();
  let profileDirs: fs.Dirent[] = [];
  try {
    profileDirs = fs.readdirSync(browserDir, { withFileTypes: true });
  } catch {  }
  for (const p of profileDirs) {
    if (!p.isDirectory() || p.name === 'sessions' || p.name === '_legacy') continue;
    try {
      const state = JSON.parse(fs.readFileSync(path.join(browserDir, p.name, 'tasks.json'), 'utf-8'));
      for (const taskName of Object.keys(state)) {
        if (!taskOwner.has(taskName)) taskOwner.set(taskName, p.name);
      }
    } catch {  }
  }

  for (const taskEntry of taskDirs) {
    if (!taskEntry.isDirectory()) continue;
    const owner = taskOwner.get(taskEntry.name) ?? '_legacy';
    moveDirOnce(
      path.join(legacySessionsDir, taskEntry.name),
      path.join(browserDir, owner, 'sessions', taskEntry.name)
    );
  }

  rmEmptyDirTree(legacySessionsDir);
}

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
    } catch {  }
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
      try { fs.unlinkSync(path.join(profilesDir, file)); } catch {  }
    }
    try { fs.rmdirSync(profilesDir); } catch {  }
    try {
      const browserDir = path.join(USER_DIR, 'browser');
      if (fs.existsSync(browserDir) && fs.readdirSync(browserDir).length === 0) {
        fs.rmdirSync(browserDir);
      }
    } catch {  }
    console.error('Folded ~/.agents/browser/profiles/ into ~/.agents/agents.yaml (browser: section)');
  } catch {  }
}

function deleteUserLinearJson(): void {
  const f = path.join(USER_DIR, 'linear.json');
  if (!fs.existsSync(f)) return;
  try {
    fs.unlinkSync(f);
  } catch {  }
}

function deleteUserPromptsJson(): void {
  const f = path.join(USER_DIR, 'prompts.json');
  if (!fs.existsSync(f)) return;
  try {
    fs.unlinkSync(f);
  } catch {  }
}

function deleteTeamsConfigJson(): void {
  const f = path.join(USER_DIR, 'teams', 'config.json');
  if (!fs.existsSync(f)) return;
  try {
    fs.unlinkSync(f);
  } catch {  }
}

function moveTeamsRegistryToHistory(): void {
  const src = path.join(USER_DIR, 'teams', 'registry.json');
  const dest = path.join(HISTORY_DIR, 'teams', 'registry.json');
  moveFileOnce(src, dest);
}

function cleanupUserConfigJson(): void {
  const legacy = path.join(USER_DIR, 'config.json');
  if (!fs.existsSync(legacy)) return;
  try {
    fs.unlinkSync(legacy);
  } catch {  }
}

function cleanupEmptyTopLevelRuns(): void {
  const dir = path.join(USER_DIR, 'runs');
  if (!fs.existsSync(dir)) return;
  try {
    if (fs.readdirSync(dir).length === 0) fs.rmdirSync(dir);
  } catch {  }
}

function migrateAliasesToUser(): void {
  const src = path.join(SYSTEM_DIR, 'aliases.json');
  const dest = path.join(USER_DIR, 'aliases.json');
  if (fs.existsSync(dest) || !fs.existsSync(src)) return;
  try {
    fs.mkdirSync(USER_DIR, { recursive: true, mode: 0o700 });
    fs.renameSync(src, dest);
  } catch {  }
}

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
      } catch {  }
    }
    try {
      if (fs.readdirSync(sysAgentDir).length === 0) fs.rmdirSync(sysAgentDir);
    } catch {  }
  }
  try {
    if (fs.readdirSync(sysVersions).length === 0) fs.rmdirSync(sysVersions);
  } catch {  }

  if (mergedCount > 0) {
    console.error(`Merged ${mergedCount} overlapping version home${mergedCount === 1 ? '' : 's'} from legacy ~/.agents-system/versions/ into ~/.agents/versions/ (legacy moved to ~/.agents/.trash/versions/)`);
  }
}

function migratePermissionSetsToPresets(): void {
  for (const root of [USER_DIR, SYSTEM_DIR]) {
    const src = path.join(root, 'permissions', 'sets');
    const dest = path.join(root, 'permissions', 'presets');
    if (!fs.existsSync(src) || fs.existsSync(dest)) continue;
    try {
      fs.renameSync(src, dest);
      const label = root === USER_DIR ? '~/.agents' : '~/.agents-system';
      console.error(`Migrated ${label}/permissions/sets/ to ${label}/permissions/presets/`);
    } catch {  }
  }
}

function repairAgentConfigSymlinks(): void {
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
    try { stat = fs.lstatSync(symlinkPath); } catch {  }
    if (stat && stat.isSymbolicLink()) {
      let current: string;
      try { current = fs.readlinkSync(symlinkPath); } catch { continue; }
      const resolved = path.resolve(path.dirname(symlinkPath), current);
      if (resolved === path.resolve(userTarget)) continue;
      try {
        fs.unlinkSync(symlinkPath);
        createLink(userTarget, symlinkPath);
        repaired++;
      } catch {  }
    } else if (!stat) {
      try {
        createLink(userTarget, symlinkPath);
        repaired++;
      } catch {  }
    }
  }

  if (repaired > 0) {
    console.error(`Repaired ${repaired} agent config symlink${repaired === 1 ? '' : 's'} to point at ~/.agents/versions/`);
  }
}

export function repairSelfReferentialBinShims(
  versionsRoot: string = path.join(HISTORY_DIR, 'versions'),
  shimsDir: string = path.resolve(CACHE_DIR, 'shims'),
  historyDir: string = path.dirname(versionsRoot),
): void {
  shimsDir = path.resolve(shimsDir);
  try {
    shimsDir = fs.realpathSync(shimsDir);
  } catch {
  }
  let agents: string[];
  try {
    agents = fs.readdirSync(versionsRoot);
  } catch {
    return;
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
        continue;
      }
      if (!stat.isSymbolicLink()) continue;

      let real: string;
      try {
        real = fs.realpathSync(binLink);
      } catch {
        try {
          fs.unlinkSync(binLink);
          repaired++;
        } catch {  }
        continue;
      }

      if (!path.resolve(real).startsWith(shimsDir + path.sep)) continue;

      const realBinary = findInPath(cli, { shimsDir, historyDir });
      try {
        fs.unlinkSync(binLink);
        if (realBinary) createLink(realBinary, binLink);
        repaired++;
      } catch {  }
    }
  }

  if (repaired > 0) {
    console.error(`Repaired ${repaired} self-referential agent binary symlink${repaired === 1 ? '' : 's'} (infinite exec-loop fix).`);
  }
}

function moveDirOnce(src: string, dest: string): void {
  if (!fs.existsSync(src)) return;

  if (!fs.existsSync(dest)) {
    try {
      fs.mkdirSync(path.dirname(dest), { recursive: true, mode: 0o700 });
      fs.renameSync(src, dest);
      return;
    } catch {
    }
  }

  try {
    copyDirSkipExisting(src, dest);
    fs.rmSync(src, { recursive: true, force: true });
  } catch {  }
}

function moveFileOnce(src: string, dest: string): void {
  if (!fs.existsSync(src)) return;
  if (fs.existsSync(dest)) {
    try { fs.unlinkSync(src); } catch {  }
    return;
  }
  try {
    fs.mkdirSync(path.dirname(dest), { recursive: true, mode: 0o700 });
    fs.renameSync(src, dest);
  } catch {
    try {
      fs.copyFileSync(src, dest);
      fs.unlinkSync(src);
    } catch {  }
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
      } catch {  }
    }
    if (fs.readdirSync(dir).length === 0) fs.rmdirSync(dir);
  } catch {  }
}

function migrateRuntimeToHistory(): void {
  moveDirOnce(path.join(USER_DIR, 'sessions'), path.join(HISTORY_DIR, 'sessions'));
  moveDirOnce(path.join(USER_DIR, 'versions'), path.join(HISTORY_DIR, 'versions'));
  moveDirOnce(path.join(USER_DIR, '.trash'), path.join(HISTORY_DIR, 'trash'));
  moveDirOnce(path.join(USER_DIR, 'trash'), path.join(HISTORY_DIR, 'trash'));
  moveDirOnce(path.join(USER_DIR, '.backups'), path.join(HISTORY_DIR, 'backups'));
  moveDirOnce(path.join(USER_DIR, 'routines', 'runs'), path.join(HISTORY_DIR, 'runs'));
  moveDirOnce(path.join(USER_DIR, 'teams', 'agents'), path.join(HISTORY_DIR, 'teams', 'agents'));

  rmEmptyDirTree(path.join(USER_DIR, 'versions'));
  rmEmptyDirTree(path.join(USER_DIR, 'sessions'));
  const oldSessionsDb = path.join(USER_DIR, 'sessions.db');
  if (fs.existsSync(oldSessionsDb)) {
    try {
      if (fs.statSync(oldSessionsDb).size === 0) fs.unlinkSync(oldSessionsDb);
    } catch {  }
  }
}

function migrateLegacySessionMarkersToBookmarks(): void {
  moveFileOnce(
    path.join(HISTORY_DIR, 'favorites.json'),
    path.join(HISTORY_DIR, 'bookmarks.json'),
  );
}

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
      } catch {  }
    }
  }

  try {
    if (fs.readdirSync(cachePlugins).length === 0) fs.rmdirSync(cachePlugins);
  } catch {  }
}

function migrateRuntimeToCache(): void {
  moveDirOnce(path.join(USER_DIR, 'shims'), path.join(CACHE_DIR, 'shims'));
  moveDirOnce(path.join(USER_DIR, 'bin'), path.join(CACHE_DIR, 'bin'));
  moveDirOnce(path.join(USER_DIR, 'packages'), path.join(CACHE_DIR, 'packages'));
  moveDirOnce(path.join(USER_DIR, 'cloud'), path.join(CACHE_DIR, 'cloud'));
  moveDirOnce(path.join(USER_DIR, 'drive'), path.join(CACHE_DIR, 'drive'));
  moveDirOnce(path.join(USER_DIR, 'terminals'), path.join(CACHE_DIR, 'terminals'));
  moveDirOnce(path.join(USER_DIR, 'logs'), path.join(CACHE_DIR, 'logs'));
  moveDirOnce(path.join(USER_DIR, 'companion'), path.join(CACHE_DIR, 'companion'));
  moveDirOnce(path.join(USER_DIR, 'runtime'), path.join(CACHE_DIR, 'state'));

  const oldCache = path.join(USER_DIR, 'cache');
  if (fs.existsSync(oldCache) && fs.statSync(oldCache).isDirectory()) {
    try {
      fs.mkdirSync(CACHE_DIR, { recursive: true, mode: 0o700 });
      copyDirSkipExisting(oldCache, CACHE_DIR);
      fs.rmSync(oldCache, { recursive: true, force: true });
    } catch {  }
  }

  for (const root of [USER_DIR, SYSTEM_DIR]) {
    const src = path.join(root, 'helpers');
    if (!fs.existsSync(src)) continue;
    const destBase = path.join(CACHE_DIR, 'helpers');
    try {
      fs.mkdirSync(destBase, { recursive: true, mode: 0o700 });
      copyDirSkipExisting(src, destBase);
      fs.rmSync(src, { recursive: true, force: true });
    } catch {  }
  }

  const browserSrc = path.join(USER_DIR, 'browser');
  if (fs.existsSync(browserSrc) && fs.statSync(browserSrc).isDirectory()) {
    let entries: string[] = [];
    try { entries = fs.readdirSync(browserSrc); } catch {  }
    for (const entry of entries) {
      if (entry === 'profiles') continue;
      const src = path.join(browserSrc, entry);
      const dest = path.join(CACHE_DIR, 'browser', entry);
      moveDirOnce(src, dest);
    }
  }

  moveDirOnce(path.join(SYSTEM_DIR, '.fetch'), path.join(CACHE_DIR, '.fetch'));
  moveDirOnce(path.join(SYSTEM_DIR, 'browser'), path.join(CACHE_DIR, 'browser'));
  moveDirOnce(path.join(SYSTEM_DIR, 'state'), path.join(CACHE_DIR, 'state'));
  moveDirOnce(path.join(SYSTEM_DIR, 'companion'), path.join(CACHE_DIR, 'companion'));
  moveFileOnce(path.join(SYSTEM_DIR, '.cli-version-cache.json'), path.join(CACHE_DIR, '.cli-version-cache.json'));
  moveFileOnce(path.join(SYSTEM_DIR, '.update-check'), path.join(CACHE_DIR, '.update-check'));
  moveFileOnce(path.join(SYSTEM_DIR, '.migrated'), path.join(CACHE_DIR, '.migrated'));
  moveFileOnce(path.join(SYSTEM_DIR, '.models-cache.json'), path.join(CACHE_DIR, '.models-cache.json'));

  moveFileOnce(path.join(USER_DIR, '.cli-version-cache.json'), path.join(CACHE_DIR, '.cli-version-cache.json'));
  moveFileOnce(path.join(USER_DIR, '.update-check'), path.join(CACHE_DIR, '.update-check'));
  moveFileOnce(path.join(USER_DIR, '.migrated'), path.join(CACHE_DIR, '.migrated'));
  moveFileOnce(path.join(USER_DIR, '.models-cache.json'), path.join(CACHE_DIR, '.models-cache.json'));
  moveFileOnce(path.join(USER_DIR, 'watchdog.log'), path.join(CACHE_DIR, 'logs', 'watchdog.log'));
}

async function mergeSqliteDb(src: string, dest: string): Promise<void> {
  if (!fs.existsSync(src)) return;
  try {
    if (fs.statSync(src).size === 0) {
      try { fs.unlinkSync(src); } catch {  }
      for (const ext of ['-shm', '-wal']) {
        try { fs.unlinkSync(src + ext); } catch {  }
      }
      return;
    }
  } catch {  }

  if (!fs.existsSync(dest)) {
    try {
      fs.mkdirSync(path.dirname(dest), { recursive: true, mode: 0o700 });
      fs.renameSync(src, dest);
      for (const ext of ['-shm', '-wal']) {
        if (fs.existsSync(src + ext)) {
          try { fs.renameSync(src + ext, dest + ext); } catch {  }
        }
      }
      return;
    } catch {  }
  }

  try {
    const sqliteMod = (await import('../sqlite.js')) as { default: new (file: string) => SqliteLike };
    const Database = sqliteMod.default;
    const db = new Database(dest);
    try {
      db.exec(`ATTACH DATABASE '${src.replace(/'/g, "''")}' AS src`);
      const tables = db.prepare<{ name: string }>(
        `SELECT name FROM src.sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'`,
      ).all() as Array<{ name: string }>;
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
        } catch {  }
        const quoted = '"' + name.replace(/"/g, '""') + '"';
        try {
          db.exec(`INSERT OR IGNORE INTO main.${quoted} SELECT * FROM src.${quoted}`);
        } catch {  }
      }
      try { db.exec('DETACH DATABASE src'); } catch {  }
    } finally {
      try { db.close(); } catch {  }
    }
    try { fs.unlinkSync(src); } catch {  }
    for (const ext of ['-shm', '-wal']) {
      try { fs.unlinkSync(src + ext); } catch {  }
    }
  } catch {
    try { fs.unlinkSync(src); } catch {  }
    for (const ext of ['-shm', '-wal']) {
      try { fs.unlinkSync(src + ext); } catch {  }
    }
  }
}

interface SqliteLike {
  exec(sql: string): void;
  prepare<T = unknown>(sql: string): { get(...a: unknown[]): unknown; all(...a: unknown[]): unknown[] };
  close(): void;
}

async function migrateSystemSessionsToHistory(): Promise<void> {
  const src = path.join(SYSTEM_DIR, 'sessions');
  if (!fs.existsSync(src)) return;
  const dest = path.join(HISTORY_DIR, 'sessions');
  try { fs.mkdirSync(dest, { recursive: true, mode: 0o700 }); } catch {  }

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(src, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    const s = path.join(src, entry.name);
    if (entry.name === 'sessions.db' || entry.name === 'sessions.db-shm' || entry.name === 'sessions.db-wal') {
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
  } catch {  }
}

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
  } catch {  }
}

function migrateSystemTrashToHistory(): void {
  const src = path.join(SYSTEM_DIR, 'trash');
  if (!fs.existsSync(src)) return;
  moveDirOnce(src, path.join(HISTORY_DIR, 'trash'));
}

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
      if (entry.name === 'sessions.db') {
        await mergeSqliteDb(s, path.join(HISTORY_DIR, 'sessions', 'sessions.db'));
      }
      try { if (fs.existsSync(s)) fs.unlinkSync(s); } catch {  }
      continue;
    }
    if (entry.name === 'claude-usage.json') {
      try { fs.unlinkSync(s); } catch {  }
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
  } catch {  }
}

async function migrateSystemCloudToCache(): Promise<void> {
  const srcDir = path.join(SYSTEM_DIR, 'cloud');
  if (!fs.existsSync(srcDir)) return;
  await mergeSqliteDb(path.join(srcDir, 'tasks.db'), path.join(CACHE_DIR, 'cloud', 'tasks.db'));

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
  } catch {  }
}

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
      try { fs.unlinkSync(f); } catch {  }
    }
  }
  try {
    if (fs.readdirSync(src).length === 0) fs.rmdirSync(src);
  } catch {  }
}

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
      try { fs.rmSync(s, { recursive: true, force: true }); } catch {  }
      continue;
    }
    try {
      fs.renameSync(s, d);
      moved++;
    } catch {  }
  }
  try {
    if (fs.readdirSync(src).length === 0) fs.rmdirSync(src);
  } catch {  }
  if (moved > 0) {
    console.error(`Moved ${moved} extra repo${moved === 1 ? '' : 's'} from ~/.agents-system/repos/ to ~/.agents-<alias>/ peer dirs`);
  }
}

function dropDeadSystemArtifacts(): void {
  const binDir = path.join(SYSTEM_DIR, 'bin');
  if (fs.existsSync(binDir)) {
    try {
      for (const name of fs.readdirSync(binDir)) {
        if (name.startsWith('agents-keychain-')) {
          try { fs.unlinkSync(path.join(binDir, name)); } catch {  }
        }
      }
      if (fs.readdirSync(binDir).length === 0) fs.rmdirSync(binDir);
    } catch {  }
  }

  const shimsDir = path.join(SYSTEM_DIR, 'shims');
  if (fs.existsSync(shimsDir)) {
    try {
      if (fs.readdirSync(shimsDir).length === 0) fs.rmdirSync(shimsDir);
    } catch {  }
  }

  const versionsDir = path.join(SYSTEM_DIR, 'versions');
  if (fs.existsSync(versionsDir)) {
    try {
      if (containsOnlyDsStore(versionsDir)) {
        fs.rmSync(versionsDir, { recursive: true, force: true });
      }
    } catch {  }
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

function warnSystemOrphans(): void {
  const SHIPPED_ALLOWLIST = new Set<string>([
    'commands', 'hooks', 'skills', 'rules', 'mcp', 'clis', 'permissions', 'subagents', 'profiles', 'agents', 'routines', 'webhooks',
    'agents.yaml', 'hooks.yaml', 'README.md', 'CHANGELOG.md',
    '.git', '.githooks', '.gitignore', '.assets', '.environment', '.plans',
    '.DS_Store', '.claude',
  ]);

  let entries: string[];
  try {
    entries = fs.readdirSync(SYSTEM_DIR);
  } catch {
    return;
  }
  const orphans = entries.filter((name) => !SHIPPED_ALLOWLIST.has(name) && !name.endsWith('.sock'));
  if (orphans.length === 0) return;
  console.error(`~/.agents-system/ has unexpected entries (not part of the npm-shipped defaults): ${orphans.join(', ')}`);
}

const VERSION_RESOURCE_FLAT_KEYS = ['commands', 'skills', 'hooks', 'memory', 'subagents', 'plugins', 'workflows', 'permissions', 'mcp'] as const;

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
        if ((val as string[]).every(item => typeof item === 'string' && !item.includes(':'))) {
          if (key === 'memory') {
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

  if (hasLocal) {
    if (agents && Object.keys(agents).length > 0) {
      const pinsPath = path.join(USER_DIR, '.history', 'devices', `pins-${machineId()}.json`);
      let existing: { agents?: Record<string, string> } = {};
      try {
        existing = (JSON.parse(fs.readFileSync(pinsPath, 'utf-8')) as { agents?: Record<string, string> }) || {};
      } catch {  }
      fs.mkdirSync(path.dirname(pinsPath), { recursive: true });
      atomicWriteFileSync(
        pinsPath,
        JSON.stringify({ ...existing, agents: { ...agents, ...existing.agents } }, null, 2) + '\n',
      );
    }

    if (versions && Object.keys(versions).length > 0) {
      const vrPath = path.join(USER_DIR, '.history', 'version-resources.json');
      let existing: Record<string, unknown> = {};
      try { existing = (JSON.parse(fs.readFileSync(vrPath, 'utf-8')) as Record<string, unknown>) || {}; } catch {  }
      fs.mkdirSync(path.dirname(vrPath), { recursive: true });
      atomicWriteFileSync(vrPath, JSON.stringify({ ...versions, ...existing }, null, 2) + '\n');
    }

    delete meta.agents;
    delete meta.versions;
    atomicWriteFileSync(metaFile, HEADER + yaml.stringify(meta));
  }

  try {
    execSync('git update-index --no-skip-worktree agents.yaml', { cwd: USER_DIR, stdio: 'ignore' });
  } catch {  }

  if (hasLocal) {
    console.error('Split agents.yaml: agents: -> .history/devices/pins-*.json, versions: -> .history/version-resources.json');
  }
}

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

  const devicePath = path.join(userDir, 'devices', machine, 'agents.yaml');
  let deviceDoc: Record<string, unknown> = {};
  try {
    deviceDoc = (yaml.parse(fs.readFileSync(devicePath, 'utf-8')) as Record<string, unknown>) || {};
  } catch {  }
  const deviceBrowser = (deviceDoc.browser && typeof deviceDoc.browser === 'object' && !Array.isArray(deviceDoc.browser))
    ? deviceDoc.browser as Record<string, unknown>
    : {};
  if (deviceBrowser[LEGACY_DEFAULT_BROWSER_PROFILE_NAME] === undefined) {
    deviceBrowser[LEGACY_DEFAULT_BROWSER_PROFILE_NAME] = entry;
    deviceDoc.browser = deviceBrowser;
    fs.mkdirSync(path.dirname(devicePath), { recursive: true });
    atomicWriteFileSync(devicePath, DEVICE_META_HEADER + yaml.stringify(deviceDoc));
  }

  doc.deleteIn(['browser', LEGACY_DEFAULT_BROWSER_PROFILE_NAME]);
  if (Object.keys(browser as Record<string, unknown>).length === 1) {
    type Keyed = { key?: { value?: unknown; commentBefore?: string | null } };
    const itemsOf = (): Keyed[] => ((doc.contents as { items?: Keyed[] } | null)?.items) ?? [];
    const idx = itemsOf().findIndex((pair) => pair.key?.value === 'browser');
    const orphaned = idx >= 0 ? itemsOf()[idx]?.key?.commentBefore ?? undefined : undefined;
    doc.delete('browser');
    if (orphaned) {
      const next = itemsOf()[idx]?.key;
      if (next) next.commentBefore = next.commentBefore ? `${orphaned}\n${next.commentBefore}` : orphaned;
      else doc.commentBefore = orphaned;
    }
  }
  const remaining = Object.keys((doc.toJSON() as Record<string, unknown> | null) ?? {}).length;
  atomicWriteFileSync(metaFile, remaining === 0 ? DEVICE_META_HEADER : stringifyDoc(doc));
  console.error(`Migrated agents.yaml: browser '${LEGACY_DEFAULT_BROWSER_PROFILE_NAME}' profile -> devices/${machine}/agents.yaml`);
}

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
        } catch {  }
      } else if (oldExists && newExists) {
        try { fs.rmSync(oldDir, { recursive: true, force: true }); } catch {  }
      }

      const marketplaceJson = path.join(newDir, '.claude-plugin', 'marketplace.json');
      if (fs.existsSync(marketplaceJson)) {
        try {
          const raw = fs.readFileSync(marketplaceJson, 'utf-8');
          const parsed = JSON.parse(raw) as Record<string, unknown>;
          if (parsed?.name === OLD) {
            parsed.name = NEW;
            fs.writeFileSync(marketplaceJson, JSON.stringify(parsed, null, 2) + '\n', 'utf-8');
          }
        } catch {  }
      }

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
        } catch {  }
      }

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
        } catch {  }
      }
    }
  }

  if (renamedDirs > 0 || rewroteKnown > 0 || rewroteSettings > 0) {
    console.error(`Renamed extras-extras → agents-extras (dirs: ${renamedDirs}, known_marketplaces: ${rewroteKnown}, settings: ${rewroteSettings})`);
  }
}

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
      delete doc.remoteCwd;
      atomicWriteFileSync(filePath, yaml.stringify(doc));
      continue;
    }

    if ('cwd' in doc) {
      if (doc.cwd === remote) {
        delete doc.remoteCwd;
        atomicWriteFileSync(filePath, yaml.stringify(doc));
        migrated++;
      } else {
        conflicts++;
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

function pauseUnreadyEnabledRoutines(): void {
  const enabled = enabledRoutineNames();
  if (enabled === null) return;
  const enabledSet = new Set(enabled);
  const paused: string[] = [];
  for (const job of listJobs()) {
    if (!enabledSet.has(job.name)) continue;
    let ready = true;
    try {
      ready = validateJob(job).length === 0 && evaluateActivationReadiness(job).ready;
    } catch {
      ready = true;
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
  try { fs.rmSync(sentinelPath); } catch {  }
  console.error('Migrated watchdog: legacy enable sentinel → watchdog.enabled config (kept enabled)');
}

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

export const LEGACY_HUMANS_FILE = 'humans.yaml';

type HumansChannelEntry = { id?: unknown; transport?: unknown; to?: unknown };

const SEVERITY_EVENTS: Record<'low' | 'normal' | 'critical', OwnerEvent[]> = {
  critical: ['needs_you'],
  normal: ['failed', 'message'],
  low: ['completed'],
};

function accountChannelFor(transport: string): OwnerChannel | null {
  const t = transport.trim().toLowerCase();
  return t === 'imessage' || t === 'slack' || t === 'email' ? t : null;
}

/**
 * Translate humans.yaml into a `/me/preferences` patch. Severity policy maps onto
 * events (critical → needs_you, normal → failed + message, low → completed).
 * Transports the account cannot deliver (telegram, desktop, a command) have no
 * equivalent and are reported back as dropped.
 */
export function humansToPreferencesPatch(doc: unknown): { patch: OwnerPreferencesPatch; dropped: string[] } {
  const owner = (doc && typeof doc === 'object' ? (doc as Record<string, unknown>).owner : undefined) as Record<string, unknown> | undefined;
  const rawChannels = Array.isArray(owner?.channels) ? owner!.channels as HumansChannelEntry[] : [];
  const legacy = owner?.notify as { channel?: unknown; to?: unknown } | undefined;
  const channels = rawChannels.length > 0
    ? rawChannels
    : (typeof legacy?.channel === 'string' ? [{ id: legacy.channel, transport: legacy.channel, to: legacy.to }] : []);
  const byId = new Map<string, OwnerChannel>();
  const dropped: string[] = [];
  let imessageAddress: string | undefined;
  for (const entry of channels) {
    if (typeof entry.id !== 'string') continue;
    const transport = typeof entry.transport === 'string' ? entry.transport : entry.id;
    const channel = accountChannelFor(transport);
    if (!channel) { dropped.push(`${entry.id} (${transport})`); continue; }
    byId.set(entry.id, channel);
    if (channel === 'imessage' && typeof entry.to === 'string' && entry.to.trim()) imessageAddress ??= entry.to.trim();
  }
  const policy = (owner?.policy ?? {}) as Partial<Record<'low' | 'normal' | 'critical', unknown>>;
  const [firstChannel] = byId.keys();
  const preferences: NonNullable<OwnerPreferencesPatch['preferences']> = [];
  if (byId.size > 0) {
    for (const severity of ['critical', 'normal', 'low'] as const) {
      const listed = Array.isArray(policy[severity])
        ? (policy[severity] as unknown[]).filter((id): id is string => typeof id === 'string')
        : (severity === 'low' ? [] : [firstChannel]);
      const enabled = new Set(listed.map((id) => byId.get(id)).filter((c): c is OwnerChannel => Boolean(c)));
      for (const event of SEVERITY_EVENTS[severity]) {
        for (const channel of ['email', 'slack', 'imessage'] as const) {
          preferences.push({ event, channel, enabled: enabled.has(channel) });
        }
      }
    }
  }
  const patch: OwnerPreferencesPatch = {};
  if (preferences.length > 0) patch.preferences = preferences;
  const settings: NonNullable<OwnerPreferencesPatch['settings']> = {};
  if (typeof owner?.timezone === 'string' && owner.timezone.trim()) settings.timezone = owner.timezone.trim();
  const quiet = typeof owner?.quiet_hours === 'string' ? owner.quiet_hours.match(/^\s*(\d{1,2}:\d{2})\s*-\s*(\d{1,2}:\d{2})\s*$/) : null;
  if (quiet) {
    settings.quietStart = quiet[1].padStart(5, '0');
    settings.quietEnd = quiet[2].padStart(5, '0');
  }
  if (Object.keys(settings).length > 0) patch.settings = settings;
  if (imessageAddress) patch.destinations = { imessage: { address: imessageAddress } };
  return { patch, dropped };
}

/**
 * One-shot: upload humans.yaml to the account, then move it to trash. Needs a
 * Phoenix session (a worker's device token cannot write preferences); without
 * one, or when the upload fails, the file stays and the step reports 'pending'
 * so the next run retries.
 */
export async function migrateHumansToAccount(userDir: string = USER_DIR): Promise<'absent' | 'pending' | 'migrated'> {
  const humansFile = path.join(userDir, LEGACY_HUMANS_FILE);
  if (!fs.existsSync(humansFile)) return 'absent';
  if (resolveOwnerCredential()?.kind !== 'session') return 'pending';
  const { patch, dropped } = humansToPreferencesPatch(yaml.parse(fs.readFileSync(humansFile, 'utf-8')));
  try {
    if (Object.keys(patch).length > 0) await putOwnerPreferences(patch);
  } catch (err) {
    console.error(`humans.yaml migration: ${(err as Error).message} The file is kept and the upload retries next run.`);
    return 'pending';
  }
  const trashed = moveFileToTrash(humansFile);
  commitCentralConfig(userDir, LEGACY_HUMANS_FILE, 'chore(config): humans.yaml moved to account notification preferences');
  console.error(`Moved owner notification settings from ${humansFile} to your account (console Settings). Old file: ${trashed}`);
  if (dropped.length > 0) console.error(`No account equivalent, not migrated: ${dropped.join(', ')}`);
  return 'migrated';
}

export function seedActiveCursorLoginPerVersion(): void {
  const realHome = process.env.AGENTS_REAL_HOME || os.homedir();
  const globalAuth = path.join(realHome, '.config', 'cursor', 'auth.json');
  let versionHome: string;
  try {
    if (!fs.existsSync(globalAuth)) return;
    const link = fs.readlinkSync(path.join(realHome, '.cursor'));
    const resolved = path.isAbsolute(link) ? link : path.resolve(realHome, link);
    versionHome = path.dirname(resolved);
  } catch {
    return;
  }
  if (!versionHome.includes(path.join('versions', 'cursor'))) return;
  const dest = path.join(versionHome, '.cursor', 'auth.json');
  try {
    if (fs.existsSync(dest)) return;
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(globalAuth, dest);
  } catch {  }
}

export function migrateKimiSubagentsToMarkdown(versionsDir?: string): void {
  const kimiVersions = path.join(versionsDir ?? path.join(HISTORY_DIR, 'versions'), 'kimi');
  let versions: string[];
  try {
    versions = fs.readdirSync(kimiVersions);
  } catch {
    return;
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
        doomed.push(entry);
        continue;
      }
      if (!entry.endsWith('.yaml')) continue;
      const base = entry.slice(0, -'.yaml'.length);
      if (!present.has(`${base}.system.md`)) continue;
      doomed.push(entry, `${base}.system.md`);
    }
    for (const entry of doomed) {
      try {
        fs.rmSync(path.join(dir, entry), { force: true });
        removed++;
      } catch {
      }
    }
  }

  if (removed > 0) {
    console.error(`Removed ${removed} pre-markdown Kimi subagent file(s); run 'agents sync kimi' to write the new format`);
  }
}

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
        try { fs.unlinkSync(linkPath); } catch {  }
      }
    } else if (lstat.isFile()) {
      let copy = '';
      try { copy = fs.readFileSync(linkPath, 'utf8'); } catch { continue; }
      if (copy.startsWith(COMPILED_HEADER_PROJECT)) {
        try { fs.unlinkSync(linkPath); } catch {  }
      }
    }
  }

  try { fs.unlinkSync(agentsPath); } catch {  }
}

export async function runMigration(): Promise<void> {
  foldLegacySystemRepo();
  const cliMigrateDirs = [USER_DIR, SYSTEM_DIR];
  const projectDotAgents = path.join(process.cwd(), '.agents');
  if (fs.existsSync(projectDotAgents)) cliMigrateDirs.push(projectDotAgents);
  migrateCliDirToClis(cliMigrateDirs);
  migrateAgentsYaml();
  await migrateHumansToAccount();
  deleteSystemPromptsJson();
  migrateSystemConfigJson();
  detrackUserChangelog();
  migratePromptcutsIntoHooks();
  migrateSystemVersionsToUser();
  mergeOverlappingVersionHomes();
  seedActiveCursorLoginPerVersion();
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
  migrateSplitDeviceLocalMeta();
  migrateMachineLocalBrowserProfileOutOfCentral();
  migrateDeviceConfigStores();
  migrateRuntimeToHistory();
  migrateLegacySessionMarkersToBookmarks();
  migrateRuntimeToCache();
  migratePluginsBackToUserRoot();
  foldBrowserSessionsIntoProfiles();

  await migrateSystemSessionsToHistory();
  migrateSystemTeamsToUser();
  migrateSystemTrashToHistory();
  migrateLegacySwarmToTeams();
  migrateSystemReposToPeerDirs();
  await migrateSystemCacheToUserCache();
  await migrateSystemCloudToCache();
  dropDeadSystemArtifacts();
  warnSystemOrphans();

  migrateExtrasExtrasToAgentsExtras();

  migrateRoutineDeviceToDevices();
  migrateRoutineRemoteCwdToCwd();
  migrateLegacyRoutineActivation();

  migrateWatchdogSentinelToConfig();
  removeHomeCompiledProjectRules();
  pauseUnreadyEnabledRoutines();

  repairAgentConfigSymlinks();
  repairSelfReferentialBinShims();

  try {
    const { reconcileSessionHooks } = await import('../tmux/session.js');
    const { isTmuxInstalled } = await import('../tmux/binary.js');
    if (isTmuxInstalled()) await reconcileSessionHooks();
  } catch {
  }

  try {
    const { reportAccountSlotMigrationOnUpgrade } = await import('../accounts/migrate.js');
    await reportAccountSlotMigrationOnUpgrade();
  } catch {
  }
}
