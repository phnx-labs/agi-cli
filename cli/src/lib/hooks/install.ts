
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as yaml from 'yaml';
import * as TOML from 'smol-toml';
import { execFile, execFileSync } from 'child_process';
import { promisify } from 'util';
import { fileURLToPath } from 'url';
import { AGENTS, ALL_AGENT_IDS, agentConfigDirName, isAgentHardDeprecated } from '../agents.js';
import { supports, explainSkip, capableAgents } from '../capabilities.js';
import { getAgentsDir, getHooksDir as getSystemHooksDir, getUserHooksDir, getUserAgentsDir, getSystemAgentsDir, getProjectAgentsDir, getTrashHooksDir, getEnabledExtraRepos, getResolvedRulesDir, getUserRulesDir, getPerfDir, getHistoryDir } from '../state.js';
import { collectSubruleHooksFromState } from '../rules/compose.js';
import { codexShortKey, resolveCodexHome } from '../codex-home.js';

function getCentralHooksDir(): string { return getUserHooksDir(); }

function resolveContainedHookPath(hooksRoot: string, script: string): string | null {
  const resolvedRoot = path.resolve(hooksRoot);
  const candidate = path.join(hooksRoot, script);
  const resolved = path.resolve(candidate);
  if (!resolved.startsWith(resolvedRoot + path.sep)) return null;
  if (!fs.existsSync(resolved)) return null;
  return resolved;
}

const HOOK_GROUP_SKIP_DIRS = new Set(['node_modules', '.git', '.cache']);

export function resolveHookScriptPath(script: string): string | null {
  const extraDirs = getEnabledExtraRepos().map(e => e.dir);
  for (const root of [getUserAgentsDir(), ...extraDirs, getSystemAgentsDir()]) {
    const hooksRoot = path.join(root, 'hooks');
    const resolved = resolveContainedHookPath(hooksRoot, script);
    if (resolved) return resolved;
    const base = path.basename(script);
    const nested = findHookScriptInGroupDirs(hooksRoot, base);
    if (nested) return nested;
  }
  return null;
}

function findHookScriptInGroupDirs(hooksRoot: string, basename: string): string | null {
  if (!fs.existsSync(hooksRoot)) return null;
  let entries: string[];
  try {
    entries = fs.readdirSync(hooksRoot).sort();
  } catch {
    return null;
  }
  for (const name of entries) {
    if (name.startsWith('.') || HOOK_GROUP_SKIP_DIRS.has(name)) continue;
    const groupDir = path.join(hooksRoot, name);
    let st: fs.Stats;
    try {
      st = fs.lstatSync(groupDir);
    } catch {
      continue;
    }
    if (!st.isDirectory() || st.isSymbolicLink()) continue;
    let hasScript = false;
    try {
      for (const child of fs.readdirSync(groupDir)) {
        if (SCRIPT_EXTENSIONS.has(path.extname(child).toLowerCase())) {
          const cp = path.join(groupDir, child);
          if (fs.existsSync(cp) && fs.statSync(cp).isFile()) { hasScript = true; break; }
        }
      }
    } catch {
      continue;
    }
    if (!hasScript) continue;
    const candidate = path.join(groupDir, basename);
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
  }
  return null;
}

function getManagedHookPrefixes(): string[] {
  const extraDirs = getEnabledExtraRepos().map(e => e.dir);
  return [
    path.join(getUserAgentsDir(), 'hooks') + path.sep,
    ...extraDirs.map(d => path.join(d, 'hooks') + path.sep),
    path.join(getSystemAgentsDir(), 'hooks') + path.sep,
    path.join(getUserRulesDir(), 'subrules') + path.sep,
    ...extraDirs.map(d => path.join(d, 'rules', 'subrules') + path.sep),
    path.join(getResolvedRulesDir(), 'subrules') + path.sep,
  ];
}

export function toPortableCommand(
  absPath: string,
  home: string = os.homedir(),
  sep: string = path.sep
): string {
  const normalized = absPath.split(sep).join('/');
  const homeNorm = home.split(sep).join('/');
  if (normalized.startsWith(homeNorm + '/')) {
    return '~/' + normalized.slice(homeNorm.length + 1);
  }
  return normalized;
}

// Hook copies agents-cli writes into a version home or an account slot are its own, even in
// another home's settings: a slot carried a version home's file forward, then kept those paths.
const AGENTS_HOME_HOOK_RE = /\/\.agents\/\.history\/(?:versions\/[^/]+\/[^/]+\/home|accounts\/[^/]+\/[^/]+)\//;

function isManagedHookCommand(command: string, prefixes: string[]): boolean {
  let expanded = command;
  if (command.startsWith('~/')) {
    expanded = path.join(os.homedir(), command.slice(2));
  }
  if (AGENTS_HOME_HOOK_RE.test(expanded.split(path.sep).join('/'))) return true;
  const dir = path.dirname(expanded);
  let resolvedDir = dir;
  try { resolvedDir = fs.realpathSync(dir); } catch {  }
  const resolved = path.join(resolvedDir, path.basename(expanded));

  for (const prefix of prefixes) {
    if (resolved.startsWith(prefix)) return true;
    const rawPrefixDir = prefix.endsWith(path.sep) ? prefix.slice(0, -path.sep.length) : prefix;
    let resolvedPrefix = prefix;
    try { resolvedPrefix = fs.realpathSync(rawPrefixDir) + path.sep; } catch {  }
    if (resolvedPrefix !== prefix && resolved.startsWith(resolvedPrefix)) return true;
  }
  return false;
}

const VERSION_HOME_SEGMENT_RE = /\.history\/versions\/([^/]+)\/([^/]+)\/home(?:\/|$)/;
function versionHomeIdentity(commandOrPath: string): { agent: string; version: string } | null {
  const norm = commandOrPath.split(/[\\/]/).join('/');
  const m = VERSION_HOME_SEGMENT_RE.exec(norm);
  return m ? { agent: m[1], version: m[2] } : null;
}

// One script can serve several events, each through its own command (a matcher hook runs via a
// shim, a bare one runs direct), so a registration is owned by event + matcher + command.
function hookEntryKey(event: string, matcher: string | undefined, command: string): string {
  return `${event}\0${matcher ?? ''}\0${command}`;
}

function pruneManagedHookEntries(
  hooks: Record<string, Array<{ matcher?: string; hooks?: Array<{ command: string }> }>>,
  expected: Set<string>,
  managedPrefixes: string[],
): void {
  for (const [event, groups] of Object.entries(hooks)) {
    if (!Array.isArray(groups)) continue;
    for (const group of groups) {
      if (!group.hooks) continue;
      const seen = new Set<string>();
      group.hooks = group.hooks.filter((h) => {
        if (!isManagedHookCommand(h.command, managedPrefixes)) return true;
        const key = hookEntryKey(event, group.matcher, h.command);
        if (!expected.has(key) || seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    }
    hooks[event] = groups.filter((g) => g.hooks && g.hooks.length > 0);
  }
}

import {
  getEffectiveHome,
  getGlobalDefault,
  getVersionHomePath,
  isVersionIsolated,
  listInstalledVersions,
  resolveVersion,
} from '../installations/versions.js';
import type { AgentId, HookCacheConfig, HookMatches, InstalledHook, ManifestHook } from '../types.js';
import { generateHookShim, getHookShimPath, isValidHookShimName, parseCacheConfig, removeHookShim } from './cache.js';
import { getHookShimsDir } from '../state.js';

type HookEntry = { name: string; scriptPath: string; dataFile?: string };

export interface VersionHookCopy {
  agent: AgentId;
  version: string;
  name: string;
  path: string;
  hash: string;
  active: boolean;
}

export interface DuplicateVersionHook {
  agent: AgentId;
  name: string;
  kind: 'duplicate' | 'drift';
  authoritative: VersionHookCopy;
  copies: VersionHookCopy[];
}

function hookContentHash(scriptPath: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(scriptPath)).digest('hex');
}

export function inspectDuplicateVersionHooks(cwd = process.cwd()): DuplicateVersionHook[] {
  const byResource = new Map<string, VersionHookCopy[]>();
  for (const { agent, version } of iterHooksCapableVersions()) {
    const activeVersion = resolveVersion(agent, cwd);
    for (const entry of listHooksInVersionHome(agent, version)) {
      let hash: string;
      try {
        hash = hookContentHash(entry.scriptPath);
      } catch {
        continue;
      }
      const copy: VersionHookCopy = {
        agent,
        version,
        name: entry.name,
        path: entry.scriptPath,
        hash,
        active: version === activeVersion,
      };
      const key = `${agent}\0${entry.name}`;
      const copies = byResource.get(key) ?? [];
      copies.push(copy);
      byResource.set(key, copies);
    }
  }

  const findings: DuplicateVersionHook[] = [];
  for (const copies of byResource.values()) {
    if (copies.length < 2) continue;
    copies.sort((a, b) => a.version.localeCompare(b.version, undefined, { numeric: true }));
    const authoritative = copies.find((copy) => copy.active) ?? copies[copies.length - 1];
    findings.push({
      agent: authoritative.agent,
      name: authoritative.name,
      kind: new Set(copies.map((copy) => copy.hash)).size === 1 ? 'duplicate' : 'drift',
      authoritative,
      copies,
    });
  }
  return findings.sort((a, b) => `${a.agent}/${a.name}`.localeCompare(`${b.agent}/${b.name}`));
}

function resolveHookCommand(
  name: string,
  hookDef: ManifestHook,
  resolveScript: (script: string) => string | null
): string | null {
  const scriptPath = resolveScript(hookDef.script);
  if (!scriptPath) return null;
  if (!isValidHookShimName(name)) return null;
  const cache = parseCacheConfig(hookDef.cache);
  const matches = hookDef.matches;
  const hasMatches = matches != null && Object.keys(matches).length > 0;
  const hasMatcher = !!hookDef.matcher;
  if (!cache && !hasMatches && !hasMatcher) {
    removeHookShim(name);
    return toPortableCommand(scriptPath);
  }
  return toPortableCommand(generateHookShim({
    name,
    scriptPath,
    cache,
    matches,
    failClosed: hookDef.events.includes('PreToolUse'),
  }));
}

const NON_SCRIPT_EXTENSIONS = new Set([
  '.md', '.markdown', '.rst', '.txt',
  '.yaml', '.yml', '.json', '.toml', '.ini', '.conf',
]);

const DOC_EXTENSIONS = new Set(['.md', '.markdown', '.rst']);

const SCRIPT_EXTENSIONS = new Set([
  '.sh',
  '.bash',
  '.zsh',
  '.py',
  '.js',
  '.ts',
  '.mjs',
  '.cjs',
  '.rb',
  '.pl',
  '.ps1',
  '.cmd',
  '.bat',
]);

function isExecutable(mode: number): boolean {
  return (mode & 0o111) !== 0;
}

function ensureExecutable(scriptPath: string): void {
  try {
    const mode = fs.statSync(scriptPath).mode;
    if (!isExecutable(mode)) fs.chmodSync(scriptPath, mode | 0o755);
  } catch {  }
}

function getHooksDir(agentId: AgentId): string {
  const agent = AGENTS[agentId];
  const home = getEffectiveHome(agentId);
  return path.join(home, agentConfigDirName(agentId), agent.hooksDir);
}

function getProjectHooksDirs(agentId: AgentId, cwd: string): string[] {
  const agent = AGENTS[agentId];
  const dirs: string[] = [];
  const projectAgentsDir = getProjectAgentsDir(cwd);
  if (projectAgentsDir) {
    dirs.push(path.join(projectAgentsDir, 'hooks'));
  }
  dirs.push(path.join(cwd, `.${agentId}`, agent.hooksDir));
  return dirs;
}

function ensureDir(dir: string): void {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function removeHookFiles(dir: string, name: string): void {
  if (!fs.existsSync(dir)) {
    return;
  }
  const files = fs.readdirSync(dir);
  for (const file of files) {
    const ext = path.extname(file);
    const base = path.basename(file, ext);
    if (base === name) {
      const fullPath = path.join(dir, file);
      const stat = fs.statSync(fullPath);
      if (stat.isFile()) {
        fs.unlinkSync(fullPath);
      }
    }
  }
}

function collectHookFilesFromRoot(dir: string): {
  name: string;
  base: string;
  ext: string;
  fullPath: string;
  isExec: boolean;
}[] {
  const files: {
    name: string;
    base: string;
    ext: string;
    fullPath: string;
    isExec: boolean;
  }[] = [];

  const pushFile = (fullPath: string, fileName: string, mode: number) => {
    const ext = path.extname(fileName);
    const base = path.basename(fileName, ext);
    files.push({
      name: fileName,
      base,
      ext,
      fullPath,
      isExec: isExecutable(mode),
    });
  };

  let top: string[];
  try {
    top = fs.readdirSync(dir);
  } catch {
    return files;
  }

  for (const file of top) {
    if (file.startsWith('.')) continue;
    const fullPath = path.join(dir, file);
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(fullPath);
    } catch {
      continue;
    }
    if (stat.isSymbolicLink()) continue;
    if (stat.isFile()) {
      pushFile(fullPath, file, stat.mode);
      continue;
    }
    if (!stat.isDirectory() || HOOK_GROUP_SKIP_DIRS.has(file)) continue;
    let nested: string[];
    try {
      nested = fs.readdirSync(fullPath);
    } catch {
      continue;
    }
    const nestedFiles: { nestedName: string; nestedPath: string; mode: number }[] = [];
    let hasScript = false;
    for (const nestedName of nested) {
      if (nestedName.startsWith('.')) continue;
      const nestedPath = path.join(fullPath, nestedName);
      let nstat: fs.Stats;
      try {
        nstat = fs.lstatSync(nestedPath);
      } catch {
        continue;
      }
      if (nstat.isSymbolicLink() || !nstat.isFile()) continue;
      nestedFiles.push({ nestedName, nestedPath, mode: nstat.mode });
      if (SCRIPT_EXTENSIONS.has(path.extname(nestedName).toLowerCase())) hasScript = true;
    }
    if (!hasScript) continue;
    for (const n of nestedFiles) pushFile(n.nestedPath, n.nestedName, n.mode);
  }
  return files;
}

export function listHookEntriesFromDir(dir: string): HookEntry[] {
  if (!fs.existsSync(dir)) {
    return [];
  }

  const files = collectHookFilesFromRoot(dir);

  const byBase = new Map<string, typeof files>();
  for (const file of files) {
    const list = byBase.get(file.base) || [];
    const isTop = path.dirname(file.fullPath) === path.resolve(dir);
    if (isTop) list.unshift(file);
    else list.push(file);
    byBase.set(file.base, list);
  }

  const entries: HookEntry[] = [];
  for (const [base, groupAll] of byBase) {
    const winnerScript =
      groupAll.find((f) => SCRIPT_EXTENSIONS.has(f.ext.toLowerCase())) ||
      groupAll.find((f) => f.isExec && !NON_SCRIPT_EXTENSIONS.has(f.ext.toLowerCase()));
    if (!winnerScript) continue;
    const groupDir = path.dirname(winnerScript.fullPath);
    const group = groupAll.filter((f) => path.dirname(f.fullPath) === groupDir);
    group.sort((a, b) => a.name.localeCompare(b.name));
    const script =
      group.find((f) => SCRIPT_EXTENSIONS.has(f.ext.toLowerCase())) ||
      group.find((f) => f.isExec && !NON_SCRIPT_EXTENSIONS.has(f.ext.toLowerCase()));
    if (!script) continue;
    const data = group.find((f) => f !== script && !DOC_EXTENSIONS.has(f.ext.toLowerCase()));
    entries.push({
      name: base,
      scriptPath: script.fullPath,
      dataFile: data ? data.fullPath : undefined,
    });
  }

  entries.sort((a, b) => a.name.localeCompare(b.name));
  return entries;
}

function buildHookMap(entries: HookEntry[]): Map<string, HookEntry> {
  const map = new Map<string, HookEntry>();
  for (const entry of entries) {
    map.set(entry.name, entry);
  }
  return map;
}

function copyHook(entry: HookEntry, targetDir: string): void {
  ensureDir(targetDir);
  removeHookFiles(targetDir, entry.name);

  const scriptTarget = path.join(targetDir, path.basename(entry.scriptPath));
  fs.copyFileSync(entry.scriptPath, scriptTarget);
  const scriptStat = fs.statSync(entry.scriptPath);
  fs.chmodSync(scriptTarget, scriptStat.mode);

  if (entry.dataFile) {
    const dataTarget = path.join(targetDir, path.basename(entry.dataFile));
    fs.copyFileSync(entry.dataFile, dataTarget);
  }
}

function normalizeContent(content: string): string {
  return content.replace(/\r\n/g, '\n').trim();
}

export function getHooksDirInHome(agentId: AgentId, home: string): string {
  const config = AGENTS[agentId];

  const hooksDir = path.isAbsolute(config.hooksDir)
    ? path.relative(config.configDir, config.hooksDir)
    : config.hooksDir;
  return path.join(home, agentConfigDirName(agentId), hooksDir);
}

export function listInstalledHooksWithScope(
  agentId: AgentId,
  cwd: string = process.cwd(),
  options?: { home?: string }
): InstalledHook[] {
  const agent = AGENTS[agentId];
  if (!agent.supportsHooks) {
    return [];
  }

  const results: InstalledHook[] = [];
  const seen = new Set<string>();

  const addHook = (hook: HookEntry, scope: 'user' | 'project', agentId: AgentId) => {
    if (seen.has(hook.name)) return;
    results.push({
      name: hook.name,
      path: hook.scriptPath,
      dataFile: hook.dataFile,
      scope,
      agent: agentId,
    });
    seen.add(hook.name);
  };

  const projectDirs = getProjectHooksDirs(agentId, cwd);
  for (const dir of projectDirs) {
    const projectHooks = listHookEntriesFromDir(dir);
    for (const hook of projectHooks) {
      addHook(hook, 'project', agentId);
    }
  }

  const home = options?.home || getEffectiveHome(agentId);
  const userDir = getHooksDirInHome(agentId, home);
  const userHooks = listHookEntriesFromDir(userDir);
  for (const hook of userHooks) {
    addHook(hook, 'user', agentId);
  }

  return results;
}

export async function installHooks(
  source: string,
  agents: AgentId[],
  options: { scope?: 'user' | 'project' } = {}
): Promise<{ installed: string[]; errors: string[] }> {
  const installed: string[] = [];
  const errors: string[] = [];
  const scope = options.scope || 'user';
  const cwd = process.cwd();

  const hooksDir = path.join(source, 'hooks');
  const hooks = listHookEntriesFromDir(hooksDir);

  const uniqueAgents = Array.from(new Set(agents));
  for (const agentId of uniqueAgents) {
    const agent = AGENTS[agentId];
    if (!agent || !agent.supportsHooks) {
      errors.push(`${agentId}:Agent does not support hooks`);
      continue;
    }

    const targetDir =
      scope === 'project' ? getProjectHooksDirs(agentId, cwd)[0] : getHooksDir(agentId);

    for (const entry of hooks) {
      try {
        copyHook(entry, targetDir);
        installed.push(`${entry.name}:${agentId}`);
      } catch (err) {
        errors.push(`${entry.name}:${agentId}:${(err as Error).message}`);
      }
    }
  }

  return { installed, errors };
}

export function getVersionHooksDir(agent: AgentId, version: string): string {
  return getHooksDirInHome(agent, getVersionHomePath(agent, version));
}

export function listHooksInVersionHome(agent: AgentId, version: string): HookEntry[] {
  return listHookEntriesFromDir(getVersionHooksDir(agent, version));
}


const SETTINGS_JSON_HOOK_FAMILY: readonly AgentId[] = ['claude', 'droid', 'muse'];
const HOOKS_JSON_HOOK_FAMILY: readonly AgentId[] = ['grok'];
const TOML_ARRAY_HOOK_FAMILY: readonly AgentId[] = ['kimi'];

export interface HookWiringIssue {
  name: string;
  event: string;
  matcher: string;
  command: string;
}

interface ManagedHookRuntimeArtifact {
  agent: AgentId;
  version: string;
  name: string;
  scriptPath: string;
  shimPath: string;
  cache: HookCacheConfig | null;
  matches?: HookMatches;
}

export interface BrokenManagedHookRuntimeArtifact extends ManagedHookRuntimeArtifact {
  reason: string;
}

export interface HookRuntimeIssue {
  name: string;
  path: string;
  reason: string;
}

export interface HookWiringReport {
  supported: boolean;
  settingsPath?: string;
  expected?: number;
  settingsMissing?: boolean;
  settingsUnparseable?: boolean;
  unwired: HookWiringIssue[];
  wired: HookWiringIssue[];
  runtimeBroken: HookRuntimeIssue[];
}

function shellQuoteForHookShim(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function hookRuntimeProblem(
  artifact: ManagedHookRuntimeArtifact,
  platform: NodeJS.Platform = process.platform,
): string | null {
  const { shimPath } = artifact;
  let link: fs.Stats;
  try {
    link = fs.lstatSync(shimPath);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return 'missing';
    return `cannot inspect (${code || 'error'})`;
  }

  let target: fs.Stats;
  try {
    target = link.isSymbolicLink() ? fs.statSync(shimPath) : link;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return 'broken symlink';
    return `cannot inspect (${code || 'error'})`;
  }
  if (!target.isFile()) return 'not a regular file';
  if (target.size === 0) return 'broken (empty)';
  if (platform !== 'win32' && (target.mode & 0o111) === 0) return 'not executable';
  try {
    const body = fs.readFileSync(shimPath, 'utf-8');
    if (!body.includes(`SOURCE=${shellQuoteForHookShim(artifact.scriptPath)}`)) {
      return 'source mismatch';
    }
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return `cannot inspect (${code || 'error'})`;
  }
  return null;
}

function managedHookRuntimeArtifactsForVersion(agent: AgentId, version: string): ManagedHookRuntimeArtifact[] {
  if (!AGENTS[agent].supportsHooks) return [];
  const localHooksDir = getVersionHooksDir(agent, version);
  const resolveScript = (script: string): string | null => {
    if (path.isAbsolute(script) && fs.existsSync(script)) return script;
    return resolveContainedHookPath(localHooksDir, script);
  };
  const artifacts: ManagedHookRuntimeArtifact[] = [];
  for (const [name, hookDef] of Object.entries(parseHookManifest({ warn: false }))) {
    if (!hookDef.events || hookDef.events.length === 0 || !isValidHookShimName(name)) continue;
    const scriptPath = resolveScript(hookDef.script);
    if (!scriptPath) continue;
    const cache = parseCacheConfig(hookDef.cache);
    const hasMatches = hookDef.matches != null && Object.keys(hookDef.matches).length > 0;
    if (!cache && !hasMatches && !hookDef.matcher) continue;
    artifacts.push({
      agent,
      version,
      name,
      scriptPath,
      shimPath: getHookShimPath(name),
      cache,
      matches: hookDef.matches,
    });
  }
  return artifacts;
}

export function inspectBrokenManagedHookRuntimeArtifacts(
  filter?: { agent?: AgentId; version?: string },
  platform: NodeJS.Platform = process.platform,
): BrokenManagedHookRuntimeArtifact[] {
  const versions = iterHooksCapableVersions();
  if (
    filter?.agent &&
    filter.version &&
    !versions.some((v) => v.agent === filter.agent && v.version === filter.version)
  ) {
    versions.push({ agent: filter.agent, version: filter.version });
  }
  const artifacts: ManagedHookRuntimeArtifact[] = [];
  for (const { agent, version } of versions) {
    artifacts.push(...managedHookRuntimeArtifactsForVersion(agent, version));
  }

  const requestedArtifacts = filter?.agent
    ? artifacts.filter((artifact) =>
      artifact.agent === filter.agent &&
      (!filter.version || artifact.version === filter.version),
    )
    : undefined;
  const relevantShimPaths = requestedArtifacts
    ? new Set(eligibleHookRuntimeArtifacts(requestedArtifacts).map((artifact) => artifact.shimPath))
    : undefined;

  const broken: BrokenManagedHookRuntimeArtifact[] = [];
  for (const artifact of selectCanonicalHookRuntimeArtifacts(artifacts)) {
    if (relevantShimPaths && !relevantShimPaths.has(artifact.shimPath)) continue;
    const reason = hookRuntimeProblem(artifact, platform);
    if (reason) broken.push({ ...artifact, reason });
  }
  return broken.sort((a, b) =>
    a.shimPath.localeCompare(b.shimPath) ||
    `${a.agent}@${a.version}/${a.name}`.localeCompare(`${b.agent}@${b.version}/${b.name}`),
  );
}

export interface HookRuntimeRepairAttempt {
  name: string;
  path: string;
  reasonBefore: string;
  attempted: boolean;
  repaired: boolean;
  reason?: string;
}

export interface HookRuntimeRepairReport {
  brokenBefore: BrokenManagedHookRuntimeArtifact[];
  attemptedPaths: string[];
  attempts: HookRuntimeRepairAttempt[];
  fixed: string[];
  needsAttention: string[];
}

interface RepairManagedHookRuntimeOptions {
  dryRun?: boolean;
  filter?: { agent?: AgentId; version?: string };
  platform?: NodeJS.Platform;
}

function pickCanonicalHookRuntimeArtifact<T extends ManagedHookRuntimeArtifact>(
  candidates: T[],
): T {
  if (candidates.length === 1) return candidates[0];
  const agents = Array.from(new Set(candidates.map((c) => c.agent))).sort();
  for (const agent of agents) {
    const defaultVersion = getGlobalDefault(agent);
    if (!defaultVersion || isVersionIsolated(agent, defaultVersion)) continue;
    const active = candidates.find((c) => c.agent === agent && c.version === defaultVersion);
    if (active) return active;
  }
  for (const agent of agents) {
    for (const version of [...listInstalledVersions(agent)].reverse()) {
      const newest = candidates.find((c) => c.agent === agent && c.version === version);
      if (newest) return newest;
    }
  }
  return candidates[0];
}

function selectCanonicalHookRuntimeArtifacts<T extends ManagedHookRuntimeArtifact>(
  artifacts: T[],
): T[] {
  const pool = eligibleHookRuntimeArtifacts(artifacts);

  const byPath = new Map<string, T[]>();
  for (const artifact of pool) {
    const list = byPath.get(artifact.shimPath) ?? [];
    list.push(artifact);
    byPath.set(artifact.shimPath, list);
  }
  const selected: T[] = [];
  for (const group of byPath.values()) {
    selected.push(pickCanonicalHookRuntimeArtifact(group));
  }
  return selected;
}

function eligibleHookRuntimeArtifacts<T extends ManagedHookRuntimeArtifact>(
  artifacts: T[],
): T[] {
  return artifacts.filter(
    (artifact) =>
      supports(artifact.agent, 'hooks', artifact.version).ok &&
      !isVersionIsolated(artifact.agent, artifact.version),
  );
}

function stableHookRuntimeRepairFailure(
  before: string,
  err: unknown,
): string {
  const code = (err as NodeJS.ErrnoException)?.code;
  return `repair failed [${code || 'UNKNOWN'}]: ${before}`;
}

function repairManagedHookRuntimeArtifact(
  artifact: ManagedHookRuntimeArtifact,
  platform: NodeJS.Platform = process.platform,
): { repaired: boolean; reason?: string } {
  const before = hookRuntimeProblem(artifact, platform);
  if (!before) return { repaired: false };
  try {
    generateHookShim({
      name: artifact.name,
      scriptPath: artifact.scriptPath,
      cache: artifact.cache,
      matches: artifact.matches,
    });
  } catch (err) {
    return { repaired: false, reason: stableHookRuntimeRepairFailure(before, err) };
  }
  const after = hookRuntimeProblem(artifact, platform);
  return after
    ? { repaired: false, reason: `${before}; repair did not produce a usable shim (${after})` }
    : { repaired: true };
}

export function repairManagedHookRuntimeArtifacts(
  opts: RepairManagedHookRuntimeOptions = {},
): HookRuntimeRepairReport {
  const platform = opts.platform ?? process.platform;
  const dryRun = opts.dryRun ?? false;
  const brokenBefore = inspectBrokenManagedHookRuntimeArtifacts(opts.filter, platform);
  const targets = selectCanonicalHookRuntimeArtifacts(brokenBefore);

  const attemptedPaths: string[] = [];
  const attempts: HookRuntimeRepairAttempt[] = [];
  const fixed: string[] = [];
  const needsAttention: string[] = [];

  for (const artifact of targets) {
    attemptedPaths.push(artifact.shimPath);

    if (dryRun) {
      attempts.push({
        name: artifact.name,
        path: artifact.shimPath,
        reasonBefore: artifact.reason,
        attempted: false,
        repaired: false,
      });
      fixed.push(`hook shim ${artifact.name}`);
      continue;
    }

    const result = repairManagedHookRuntimeArtifact(artifact, platform);
    attempts.push({
      name: artifact.name,
      path: artifact.shimPath,
      reasonBefore: artifact.reason,
      attempted: true,
      repaired: result.repaired,
      reason: result.reason,
    });

    if (result.repaired) {
      fixed.push(`hook shim ${artifact.name}`);
    } else if (result.reason) {
      needsAttention.push(`hook shim ${artifact.name}: ${result.reason}`);
    }
  }

  return { brokenBefore, attemptedPaths, attempts, fixed, needsAttention };
}

export function checkVersionHookWiring(agent: AgentId, version: string): HookWiringReport {
  const runtimeBroken = inspectBrokenManagedHookRuntimeArtifacts({ agent, version })
    .map(({ name, shimPath, reason }) => ({ name, path: shimPath, reason }));
  if (
    !AGENTS[agent].supportsHooks ||
    (!SETTINGS_JSON_HOOK_FAMILY.includes(agent) &&
      !HOOKS_JSON_HOOK_FAMILY.includes(agent) &&
      !TOML_ARRAY_HOOK_FAMILY.includes(agent))
  ) {
    return { supported: false, unwired: [], wired: [], runtimeBroken };
  }

  const versionHome = getVersionHomePath(agent, version);
  const settingsPath = HOOKS_JSON_HOOK_FAMILY.includes(agent)
    ? path.join(versionHome, '.grok', 'hooks', 'hooks.json')
    : TOML_ARRAY_HOOK_FAMILY.includes(agent)
      ? path.join(versionHome, '.kimi-code', 'config.toml')
      : path.join(versionHome, agentConfigDirName(agent), 'settings.json');
  const localHooksDir = getVersionHooksDir(agent, version);

  const resolveScript = (script: string): string | null => {
    if (path.isAbsolute(script) && fs.existsSync(script)) return script;
    return resolveContainedHookPath(localHooksDir, script);
  };
  const expectedCommand = (name: string, hookDef: ManifestHook): string | null => {
    const scriptPath = resolveScript(hookDef.script);
    if (!scriptPath) return null;
    if (!isValidHookShimName(name)) return null;
    const cache = parseCacheConfig(hookDef.cache);
    const hasMatches = hookDef.matches != null && Object.keys(hookDef.matches).length > 0;
    if (!cache && !hasMatches && !hookDef.matcher) return toPortableCommand(scriptPath);
    return toPortableCommand(getHookShimPath(name));
  };

  const manifest = parseHookManifest({ warn: false });
  const expected: HookWiringIssue[] = [];
  for (const [name, hookDef] of Object.entries(manifest)) {
    if (!hookDef.events || hookDef.events.length === 0) continue;
    const command = expectedCommand(name, hookDef);
    if (!command) continue;
    for (const event of hookDef.events) {
      if (HOOKS_JSON_HOOK_FAMILY.includes(agent)) {
        const matcher = GROK_MATCHER_EVENTS.has(event)
          ? (GROK_MATCHER_ALIASES[hookDef.matcher || ''] ?? hookDef.matcher ?? '')
          : '';
        expected.push({ name, event, matcher, command });
      } else {
        expected.push({ name, event, matcher: hookDef.matcher || '', command });
      }
    }
  }

  if (!fs.existsSync(settingsPath)) {
    return {
      supported: true,
      settingsPath,
      expected: expected.length,
      settingsMissing: expected.length > 0,
      unwired: [],
      wired: [],
      runtimeBroken,
    };
  }
  let config: Record<string, unknown>;
  try {
    const raw = fs.readFileSync(settingsPath, 'utf-8');
    config = TOML_ARRAY_HOOK_FAMILY.includes(agent)
      ? TOML.parse(raw) as Record<string, unknown>
      : JSON.parse(raw);
  } catch {
    return {
      supported: true,
      settingsPath,
      expected: expected.length,
      settingsUnparseable: true,
      unwired: [],
      wired: [],
      runtimeBroken,
    };
  }

  const wiredByGroup = new Map<string, Set<string>>();
  const groupKey = (event: string, matcher: string): string => `${event}\n${matcher}`;
  if (TOML_ARRAY_HOOK_FAMILY.includes(agent)) {
    const hooks = Array.isArray(config.hooks) ? config.hooks : [];
    for (const hook of hooks as Array<{ event?: unknown; matcher?: unknown; command?: unknown }>) {
      if (typeof hook.event !== 'string' || typeof hook.command !== 'string') continue;
      const matcher = typeof hook.matcher === 'string' ? hook.matcher : '';
      const key = groupKey(hook.event, matcher);
      let cmds = wiredByGroup.get(key);
      if (!cmds) { cmds = new Set<string>(); wiredByGroup.set(key, cmds); }
      cmds.add(hook.command);
    }
  } else {
    const hooks = config.hooks && typeof config.hooks === 'object'
      ? (config.hooks as Record<string, unknown>)
      : {};
    for (const [event, groups] of Object.entries(hooks)) {
      if (!Array.isArray(groups)) continue;
      for (const group of groups as Array<{ matcher?: unknown; hooks?: Array<{ command?: unknown }> }>) {
        if (!group || !Array.isArray(group.hooks)) continue;
        const matcher = typeof group.matcher === 'string' ? group.matcher : '';
        const key = groupKey(event, matcher);
        let cmds = wiredByGroup.get(key);
        if (!cmds) { cmds = new Set<string>(); wiredByGroup.set(key, cmds); }
        for (const h of group.hooks) {
          if (h && typeof h.command === 'string') cmds.add(h.command);
        }
      }
    }
  }

  const isWired = (entry: HookWiringIssue): boolean =>
    wiredByGroup.get(groupKey(entry.event, entry.matcher))?.has(entry.command) ?? false;
  const unwired = expected.filter((entry) => !isWired(entry));
  const wired = expected.filter(isWired);
  return { supported: true, settingsPath, expected: expected.length, unwired, wired, runtimeBroken };
}

function versionHookMatches(agent: AgentId, version: string, hookName: string): boolean {
  const central = listHookEntriesFromDir(getCentralHooksDir()).find((e) => e.name === hookName);
  if (!central) return false;
  const installed = listHooksInVersionHome(agent, version).find((e) => e.name === hookName);
  if (!installed) return false;

  try {
    if (normalizeContent(fs.readFileSync(installed.scriptPath, 'utf-8')) !==
        normalizeContent(fs.readFileSync(central.scriptPath, 'utf-8'))) {
      return false;
    }
    if (!!installed.dataFile !== !!central.dataFile) return false;
    if (installed.dataFile && central.dataFile) {
      if (normalizeContent(fs.readFileSync(installed.dataFile, 'utf-8')) !==
          normalizeContent(fs.readFileSync(central.dataFile, 'utf-8'))) {
        return false;
      }
    }
    return true;
  } catch {
    return false;
  }
}

interface VersionHookDiff {
  agent: AgentId;
  version: string;
  toAdd: string[];
  toUpdate: string[];
  matched: string[];
  orphans: string[];
}

export function diffVersionHooks(agent: AgentId, version: string): VersionHookDiff {
  const central = new Set(listHookEntriesFromDir(getCentralHooksDir()).map((e) => e.name));
  const installed = new Set(listHooksInVersionHome(agent, version).map((e) => e.name));

  const toAdd: string[] = [];
  const toUpdate: string[] = [];
  const matched: string[] = [];
  const orphans: string[] = [];

  for (const name of central) {
    if (!installed.has(name)) {
      toAdd.push(name);
    } else if (!versionHookMatches(agent, version, name)) {
      toUpdate.push(name);
    } else {
      matched.push(name);
    }
  }

  for (const name of installed) {
    if (!central.has(name)) orphans.push(name);
  }

  return { agent, version, toAdd: toAdd.sort(), toUpdate: toUpdate.sort(), matched, orphans: orphans.sort() };
}

export function removeHookFromVersion(
  agent: AgentId,
  version: string,
  hookName: string
): { success: boolean; error?: string } {
  try {
    const hooksDir = getVersionHooksDir(agent, version);
    if (!fs.existsSync(hooksDir)) return { success: true };

    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const trashDir = path.join(getTrashHooksDir(), agent, version, hookName, stamp);
    let moved = false;

    const files = fs.readdirSync(hooksDir);
    for (const file of files) {
      const ext = path.extname(file);
      const base = path.basename(file, ext);
      if (base === hookName) {
        const fullPath = path.join(hooksDir, file);
        const stat = fs.statSync(fullPath);
        if (stat.isFile()) {
          if (!moved) {
            fs.mkdirSync(trashDir, { recursive: true, mode: 0o700 });
            moved = true;
          }
          fs.renameSync(fullPath, path.join(trashDir, file));
        }
      }
    }
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
  return { success: true };
}

export function iterHooksCapableVersions(filter?: { agent?: AgentId; version?: string }): Array<{ agent: AgentId; version: string }> {
  const pairs: Array<{ agent: AgentId; version: string }> = [];
  const hookAgents: AgentId[] = capableAgents('hooks');
  const agents = filter?.agent ? [filter.agent] : hookAgents;
  for (const agent of agents) {
    if (!hookAgents.includes(agent)) continue;
    const versions = listInstalledVersions(agent);
    for (const version of versions) {
      if (filter?.version && filter.version !== version) continue;
      pairs.push({ agent, version });
    }
  }
  return pairs;
}

export async function removeHook(
  name: string,
  agents: AgentId[]
): Promise<{ removed: string[]; errors: string[] }> {
  const removed: string[] = [];
  const errors: string[] = [];

  const uniqueAgents = Array.from(new Set(agents));
  for (const agentId of uniqueAgents) {
    const agent = AGENTS[agentId];
    if (!agent || !agent.supportsHooks) {
      errors.push(`${agentId}:Agent does not support hooks`);
      continue;
    }

    try {
      const dir = getHooksDir(agentId);
      const filesBefore = fs.existsSync(dir) ? fs.readdirSync(dir) : [];
      removeHookFiles(dir, name);
      const filesAfter = fs.existsSync(dir) ? fs.readdirSync(dir) : [];
      if (filesBefore.length !== filesAfter.length) {
        removed.push(`${name}:${agentId}`);
      }
    } catch (err) {
      errors.push(`${name}:${agentId}:${(err as Error).message}`);
    }
  }

  return { removed, errors };
}

export function getHookInfo(name: string): {
  name: string;
  path: string;
  content: string;
} | null {
  const centralDir = getCentralHooksDir();
  const hookPath = path.join(centralDir, name);

  if (!fs.existsSync(hookPath)) {
    return null;
  }

  let content = '';
  const stat = fs.statSync(hookPath);
  if (stat.isFile()) {
    content = fs.readFileSync(hookPath, 'utf-8');
  } else if (stat.isDirectory()) {
    const files = fs.readdirSync(hookPath);
    content = `Directory hook containing:\n${files.map((f) => `  - ${f}`).join('\n')}`;
  }

  return {
    name,
    path: hookPath,
    content,
  };
}

export function discoverHooksFromRepo(repoPath: string): string[] {
  const hooksDir = path.join(repoPath, 'hooks');
  return listHookEntriesFromDir(hooksDir).map((h) => h.name);
}

export async function installHooksCentrally(
  source: string
): Promise<{ installed: string[]; errors: string[] }> {
  const installed: string[] = [];
  const errors: string[] = [];

  const centralDir = getCentralHooksDir();
  if (!fs.existsSync(centralDir)) {
    fs.mkdirSync(centralDir, { recursive: true });
  }

  const sharedDir = path.join(source, 'hooks');
  const sharedHooks = listHookEntriesFromDir(sharedDir);

  for (const entry of sharedHooks) {
    try {
      copyHook(entry, centralDir);
      installed.push(entry.name);
    } catch (err) {
      errors.push(`${entry.name}: ${(err as Error).message}`);
    }
  }

  return { installed, errors };
}

export function listCentralHooks(): HookEntry[] {
  const seen = new Set<string>();
  const results: HookEntry[] = [];
  for (const dir of [getUserHooksDir(), getSystemHooksDir()]) {
    for (const entry of listHookEntriesFromDir(dir)) {
      if (!seen.has(entry.name)) {
        seen.add(entry.name);
        results.push(entry);
      }
    }
  }
  return results;
}

const MAX_HOOK_DURATION_SECONDS = 24 * 60 * 60;

export function normalizeHookTimeoutSeconds(value: unknown): number | null {
  if (typeof value === 'number') {
    return Number.isFinite(value) && value > 0 ? value : null;
  }
  if (typeof value === 'string') {
    const s = value.trim();
    if (s === '') return null;
    if (/^\d+$/.test(s)) {
      const n = Number(s);
      return n > 0 ? n : null;
    }
    const m = s.match(/^(?:(\d+)w)?(?:(\d+)d)?(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/i);
    if (!m) return null;
    const weeks = Number(m[1] || 0);
    const days = Number(m[2] || 0);
    const hours = Number(m[3] || 0);
    const minutes = Number(m[4] || 0);
    const seconds = Number(m[5] || 0);
    const total = ((weeks * 7 + days) * 24 + hours) * 3600 + minutes * 60 + seconds;
    return total > 0 && total <= MAX_HOOK_DURATION_SECONDS ? total : null;
  }
  return null;
}

export function parseHookManifest(opts: { warn?: boolean } = {}): Record<string, ManifestHook> {
  const warn = opts.warn !== false;
  const merged: Record<string, ManifestHook> = {};
  const systemHooks: Record<string, ManifestHook> = {};

  try {
    const subruleHooks = collectSubruleHooksFromState();
    for (const [name, def] of Object.entries(subruleHooks)) merged[name] = def;
  } catch {  }

  const systemPath = path.join(getSystemAgentsDir(), 'agents.yaml');
  if (fs.existsSync(systemPath)) {
    try {
      const meta = yaml.parse(fs.readFileSync(systemPath, 'utf-8')) as { hooks?: Record<string, ManifestHook> } | null;
      if (meta?.hooks) for (const [name, def] of Object.entries(meta.hooks)) {
        systemHooks[name] = def;
        merged[name] = def;
      }
    } catch {  }
  }

  for (const { dir } of [...getEnabledExtraRepos()].reverse()) {
    const extraMetaPath = path.join(dir, 'agents.yaml');
    if (!fs.existsSync(extraMetaPath)) continue;
    try {
      const meta = yaml.parse(fs.readFileSync(extraMetaPath, 'utf-8')) as { hooks?: Record<string, ManifestHook> } | null;
      if (meta?.hooks) for (const [name, def] of Object.entries(meta.hooks)) merged[name] = def;
    } catch {  }
  }

  const userMetaPath = path.join(getUserAgentsDir(), 'agents.yaml');
  if (fs.existsSync(userMetaPath)) {
    try {
      const meta = yaml.parse(fs.readFileSync(userMetaPath, 'utf-8')) as { hooks?: Record<string, ManifestHook> } | null;
      if (meta?.hooks) for (const [name, def] of Object.entries(meta.hooks)) {
        if (warn && systemHooks[name] && def.override !== true) {
          const action = def.enabled === false ? 'disables' : 'shadows';
          console.warn(
            `[agents hooks] User-layer hook '${name}' ${action} system-shipped hook. Set 'override: true' to silence this warning.`,
          );
        }
        merged[name] = def;
      }
    } catch {  }
  }

  for (const [name, def] of Object.entries(merged)) {
    if (def.enabled === false) delete merged[name];
  }

  for (const [name, def] of Object.entries(merged)) {
    const raw = (def as { timeout?: unknown }).timeout;
    if (raw === undefined) continue;
    const seconds = normalizeHookTimeoutSeconds(raw);
    if (seconds === null) {
      if (warn) {
        console.warn(
          `[agents hooks] Hook '${name}' has an invalid timeout ${JSON.stringify(raw)}; ` +
          `expected seconds or a duration string like '5s', '2m', '1h30m'. Ignoring it.`,
        );
      }
      delete def.timeout;
    } else {
      def.timeout = seconds;
    }
  }

  return merged;
}

export function selectHookManifest(
  manifest: Record<string, ManifestHook>,
  selected: string[]
): Record<string, ManifestHook> {
  const selectedHooks = new Set(selected);
  return Object.fromEntries(
    Object.entries(manifest).filter(([name, hook]) =>
      selectedHooks.has(name) || selectedHooks.has(path.basename(hook.script))
    )
  );
}

export function unmanagedHookNames(installedHookNames: string[], sourceHookScripts: string[]): string[] {
  const inSource = new Set(sourceHookScripts.map((s) => path.basename(s).replace(/\.[^.]+$/, '')));
  return installedHookNames.filter((name) => !inSource.has(name)).sort();
}

function listResolvedSourceHookScripts(): string[] {
  const roots = [
    getUserHooksDir(),
    getSystemHooksDir(),
    ...getEnabledExtraRepos().map((e) => path.join(e.dir, 'hooks')),
  ];
  const scripts: string[] = [];
  for (const root of roots) {
    for (const entry of listHookEntriesFromDir(root)) scripts.push(entry.scriptPath);
  }
  return scripts;
}

export function listUnmanagedHooksInVersionHome(agent: AgentId, version: string): string[] {
  if (!AGENTS[agent].supportsHooks) return [];
  const installed = listHooksInVersionHome(agent, version).map((e) => e.name);
  return unmanagedHookNames(installed, listResolvedSourceHookScripts());
}

const CODEX_MATCHER_EVENTS = new Set(['PreToolUse', 'PostToolUse', 'SessionStart']);

type CodexMatcherGroup = {
  matcher?: string;
  hooks: Array<{ type: string; command: string; timeout: number }>;
};

type CodexHooksFile = {
  hooks: Record<string, CodexMatcherGroup[]>;
};

const CODEX_EVENT_KEY_LABELS: Record<string, string> = {
  PreToolUse: 'pre_tool_use',
  PermissionRequest: 'permission_request',
  PostToolUse: 'post_tool_use',
  PreCompact: 'pre_compact',
  PostCompact: 'post_compact',
  SessionStart: 'session_start',
  UserPromptSubmit: 'user_prompt_submit',
  SubagentStart: 'subagent_start',
  SubagentStop: 'subagent_stop',
  Stop: 'stop',
};

function canonicalizeForHash(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalizeForHash);
  }
  if (value && typeof value === 'object') {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      sorted[key] = canonicalizeForHash((value as Record<string, unknown>)[key]);
    }
    return sorted;
  }
  return value;
}

export function computeCodexHookTrustHash(
  eventKeyLabel: string,
  command: string,
  timeout: number,
  matcher: string | undefined
): string {
  const handler: Record<string, unknown> = {
    type: 'command',
    command,
    timeout: Math.max(timeout, 1),
    async: false,
  };
  const identity: Record<string, unknown> = {
    event_name: eventKeyLabel,
    hooks: [handler],
  };
  if (matcher !== undefined && matcher !== '') {
    identity.matcher = matcher;
  }
  const canonical = canonicalizeForHash(identity);
  const hex = crypto.createHash('sha256').update(JSON.stringify(canonical), 'utf-8').digest('hex');
  return `sha256:${hex}`;
}

function sweepOrphanShims(manifest: Record<string, ManifestHook>): void {
  const shimsDir = getHookShimsDir();
  if (!fs.existsSync(shimsDir)) return;
  const activeNames = new Set(Object.keys(manifest));
  for (const file of fs.readdirSync(shimsDir)) {
    if (!file.endsWith('.sh')) continue;
    const name = file.slice(0, -3);
    if (activeNames.has(name)) continue;
    try { fs.unlinkSync(path.join(shimsDir, file)); } catch {  }
  }
}

interface RegisterHooksOptions {
  skipGlobalShimSweep?: boolean;
}

export function registerHooksToSettings(
  agentId: AgentId,
  versionHome: string,
  hookManifest?: Record<string, ManifestHook>,
  agentsDirOverride?: string,
  options?: RegisterHooksOptions
): { registered: string[]; errors: string[] } {
  if (isAgentHardDeprecated(agentId)) {
    return { registered: [], errors: [] };
  }
  const manifest = hookManifest || parseHookManifest();
  if (Object.keys(manifest).length === 0) {
    if (agentId === 'opencode') {
      const pluginPath = path.join(versionHome, '.config', 'opencode', 'plugins', 'agents-cli-hooks.ts');
      try {
        fs.rmSync(pluginPath, { force: true });
      } catch (e) {
        return { registered: [], errors: [`Failed to remove agents-cli-hooks.ts: ${(e as Error).message}`] };
      }
    }
    return { registered: [], errors: [] };
  }
  if (!options?.skipGlobalShimSweep) sweepOrphanShims(manifest);

  const overrideRoots = agentsDirOverride ? [agentsDirOverride] : null;
  const localHooksDir = !overrideRoots
    ? getHooksDirInHome(agentId, versionHome)
    : null;
  const resolveScript = (script: string): string | null => {
    if (path.isAbsolute(script) && fs.existsSync(script)) {
      ensureExecutable(script);
      return script;
    }
    if (overrideRoots) {
      return resolveContainedHookPath(path.join(overrideRoots[0], 'hooks'), script);
    }
    if (localHooksDir) {
      const local =
        resolveContainedHookPath(localHooksDir, script) ||
        resolveContainedHookPath(localHooksDir, path.basename(script));
      if (local) return local;
    }
    return resolveHookScriptPath(script);
  };
  const managedPrefixes = overrideRoots
    ? [
        path.join(overrideRoots[0], 'hooks') + path.sep,
        getHookShimsDir() + path.sep,
      ]
    : [
        ...getManagedHookPrefixes(),
        ...(localHooksDir ? [localHooksDir + path.sep] : []),
        getHookShimsDir() + path.sep,
      ];

  if (agentId === 'claude') {
    return registerHooksForClaude(versionHome, manifest, resolveScript, managedPrefixes);
  }
  if (agentId === 'droid') {
    return registerHooksForClaude(
      versionHome,
      manifest,
      resolveScript,
      managedPrefixes,
      agentConfigDirName('droid')
    );
  }
  if (agentId === 'muse') {
    return registerHooksForClaude(
      versionHome,
      manifest,
      resolveScript,
      managedPrefixes,
      agentConfigDirName('muse'),
      { schemaVersion: 1 }
    );
  }
  if (agentId === 'codex') {
    return registerHooksForCodex(versionHome, manifest, resolveScript, managedPrefixes);
  }
  if (agentId === 'antigravity') {
    return registerHooksForAntigravity(versionHome, manifest, resolveScript, managedPrefixes);
  }
  if (agentId === 'grok') {
    return registerHooksForGrok(versionHome, manifest, resolveScript, managedPrefixes);
  }
  if (agentId === 'opencode') {
    return registerHooksForOpenCode(versionHome, manifest, resolveScript);
  }
  if (agentId === 'kimi') {
    return registerHooksForKimi(versionHome, manifest, resolveScript, managedPrefixes);
  }
  if (agentId === 'copilot') {
    return registerHooksForCopilot(versionHome, manifest, resolveScript, managedPrefixes);
  }
  if (agentId === 'goose') {
    return registerHooksForGoose(versionHome, manifest, resolveScript, managedPrefixes);
  }
  if (agentId === 'cursor') {
    return registerHooksForCursor(versionHome, manifest, resolveScript, managedPrefixes);
  }
  if (agentId === 'hermes') {
    return registerHooksForHermes(versionHome, manifest, resolveScript, managedPrefixes);
  }
  return { registered: [], errors: [] };
}

export function hookRegistrationTargets(agentId: AgentId, home: string): string[] {
  switch (agentId) {
    case 'claude':
    case 'droid':
    case 'muse':
      return [path.join(home, agentConfigDirName(agentId), 'settings.json')];
    case 'codex':
      return [path.join(home, '.codex', 'hooks.json'), path.join(home, '.codex', 'config.toml')];
    case 'antigravity':
      return [path.join(home, '.gemini', 'antigravity-cli', 'settings.json')];
    case 'grok':
      return [path.join(home, '.grok', 'hooks', 'hooks.json')];
    case 'kimi':
      return [path.join(home, '.kimi-code', 'config.toml')];
    case 'copilot':
      return [path.join(home, '.copilot', 'hooks', COPILOT_MANAGED_HOOKS_FILE)];
    case 'goose':
      return [path.join(home, '.agents', 'plugins', GOOSE_MANAGED_PLUGIN_NAME, 'hooks', 'hooks.json')];
    case 'cursor':
      return [path.join(home, '.cursor', 'hooks.json')];
    case 'hermes':
      return [path.join(home, '.hermes', 'config.yaml')];
    case 'opencode':
      return [path.join(home, '.config', 'opencode', 'plugins', 'agents-cli-hooks.ts')];
    default:
      return [];
  }
}

const OPENCODE_DIRECT_EVENT_MAP: Record<string, string> = {
  PreToolUse: 'tool.execute.before',
  PostToolUse: 'tool.execute.after',
  UserPromptSubmit: 'chat.message',
};

const OPENCODE_LIFECYCLE_EVENT_MAP: Record<string, string[]> = {
  SessionStart: ['session.created'],
  SessionEnd: ['session.deleted'],
  Stop: ['session.idle', 'session.error'],
  PreCompact: ['session.compacted'],
  OnError: ['session.error'],
  Notification: ['permission.asked'],
};

type OpenCodeGeneratedHook = {
  name: string;
  command: string;
  timeout?: number;
  matcher?: string;
};

function registerHooksForOpenCode(
  versionHome: string,
  manifest: Record<string, ManifestHook>,
  resolveScript: (script: string) => string | null
): { registered: string[]; errors: string[] } {
  const registered: string[] = [];
  const errors: string[] = [];
  const direct = new Map<string, OpenCodeGeneratedHook[]>();
  const lifecycle = new Map<string, OpenCodeGeneratedHook[]>();

  for (const [name, hookDef] of Object.entries(manifest)) {
    if (!hookDef.events || hookDef.events.length === 0) continue;
    const command = resolveHookCommand(name, hookDef, resolveScript);
    if (!command) {
      errors.push(`${name}: script not found`);
      continue;
    }
    const generated = {
      name,
      command,
      ...(hookDef.timeout !== undefined ? { timeout: hookDef.timeout } : {}),
      ...(hookDef.matcher ? { matcher: hookDef.matcher } : {}),
    };
    for (const event of hookDef.events) {
      const directEvent = OPENCODE_DIRECT_EVENT_MAP[event];
      if (directEvent) {
        const hooks = direct.get(directEvent) ?? [];
        hooks.push(generated);
        direct.set(directEvent, hooks);
        registered.push(`${name} -> ${directEvent}`);
      }
      for (const lifecycleEvent of OPENCODE_LIFECYCLE_EVENT_MAP[event] ?? []) {
        const hooks = lifecycle.get(lifecycleEvent) ?? [];
        hooks.push(generated);
        lifecycle.set(lifecycleEvent, hooks);
        registered.push(`${name} -> ${lifecycleEvent}`);
      }
    }
  }

  const serializedDirect = JSON.stringify(Object.fromEntries(direct), null, 2);
  const serializedLifecycle = JSON.stringify(Object.fromEntries(lifecycle), null, 2);
  const perfSpoolPath = path.join(getPerfDir(), 'spool.jsonl');
  const pluginSource = `// Generated by agents-cli. Re-run agents sync to update.
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const directHooks = ${serializedDirect}
const lifecycleHooks = ${serializedLifecycle}
const PERF_SPOOL = ${JSON.stringify(perfSpoolPath)}

function recordTimeoutSample(hook, payload) {
  // hook.command already ran through a generated shim (hooks/cache.ts) that
  // writes its own hook.fire sample on exit — but Bun.spawn's child.kill()
  // below (SIGTERM) tears the shim down before it reaches that trailing
  // printf, so a timed-out fire would otherwise leave ZERO trace in the
  // warehouse. Write the sample ourselves from the side that knows it timed out.
  try {
    // path.dirname — not lastIndexOf('/') — so Windows backslash spool paths
    // still resolve to the parent dir (see #1869).
    fs.mkdirSync(path.dirname(PERF_SPOOL), { recursive: true })
    const line = JSON.stringify({
      ts_ms: Date.now(),
      kind: "hook.fire",
      label: hook.name,
      duration_ms: hook.timeout * 1000,
      cache: "none",
      exit_code: null,
      status: "timeout",
      cwd: payload && typeof payload.cwd === "string" ? payload.cwd : undefined,
      session_id: payload && typeof payload.session_id === "string" ? payload.session_id : undefined,
      hostname: (() => { try { return os.hostname() } catch { return "unknown" } })(),
    }) + "\\n"
    fs.appendFileSync(PERF_SPOOL, line)
  } catch {
    // best effort — never let sample recording break the timeout error path
  }
}

function matches(hook, tool) {
  if (!hook.matcher) return true
  try {
    return new RegExp(hook.matcher).test(tool)
  } catch {
    return hook.matcher === tool
  }
}

async function runHooks(hooks, payload, $, matchTool = false) {
  for (const hook of hooks ?? []) {
    if (matchTool && !matches(hook, payload.tool_name ?? "")) continue
    const input = JSON.stringify(payload)
    const home = Bun.env.HOME ?? Bun.env.USERPROFILE ?? ""
    const command = hook.command.startsWith("~/")
      ? \`\${home}/\${hook.command.slice(2)}\`
      : hook.command
    const shell = Bun.which("bash") ?? Bun.which("sh")
    if (!shell) throw new Error(\`\${hook.name} requires bash or sh\`)
    const execArgs = [shell, "-c", 'exec "$1"', "agents-hook", command]
    if (hook.timeout !== undefined) {
      const child = Bun.spawn(execArgs, {
        stdin: new Response(input),
        stdout: "ignore",
        stderr: "pipe",
      })
      let timedOut = false
      const timer = setTimeout(() => {
        timedOut = true
        if (process.platform === "win32") {
          Bun.spawnSync(["taskkill", "/PID", String(child.pid), "/T", "/F"])
        } else {
          child.kill()
        }
      }, hook.timeout * 1000)
      const exitCode = await child.exited.finally(() => clearTimeout(timer))
      const stderr = await new Response(child.stderr).text()
      if (timedOut) {
        recordTimeoutSample(hook, payload)
        throw new Error(\`\${hook.name} timed out after \${hook.timeout} seconds\`)
      }
      if (exitCode !== 0) {
        throw new Error(\`\${hook.name} failed with exit code \${exitCode}: \${stderr.trim()}\`)
      }
      continue
    }
    const result = await $\`\${shell} -c \${'exec "$1"'} \${"agents-hook"} \${command} < \${new Response(input)}\`.nothrow().quiet()
    if (result.exitCode !== 0) {
      throw new Error(\`\${hook.name} failed with exit code \${result.exitCode}: \${result.stderr.toString().trim()}\`)
    }
  }
}

export const AgentsCliHooks = async ({ $ }) => ({
  event: async ({ event }) => {
    await runHooks(lifecycleHooks[event.type], { hook_event_name: event.type, ...event }, $)
  },
  "chat.message": async (input, output) => {
    await runHooks(directHooks["chat.message"], { hook_event_name: "UserPromptSubmit", ...input, ...output }, $)
  },
  "tool.execute.before": async (input, output) => {
    await runHooks(directHooks["tool.execute.before"], { hook_event_name: "PreToolUse", tool_name: input.tool, tool_input: output.args, ...input }, $, true)
  },
  "tool.execute.after": async (input, output) => {
    await runHooks(directHooks["tool.execute.after"], { hook_event_name: "PostToolUse", tool_name: input.tool, tool_input: input.args, tool_response: output, ...input }, $, true)
  },
})
`;

  const pluginDir = path.join(versionHome, '.config', 'opencode', 'plugins');
  try {
    fs.mkdirSync(pluginDir, { recursive: true });
    fs.writeFileSync(path.join(pluginDir, 'agents-cli-hooks.ts'), pluginSource, 'utf-8');
  } catch (e) {
    errors.push(`Failed to write agents-cli-hooks.ts: ${(e as Error).message}`);
  }
  return { registered, errors };
}

const ANTIGRAVITY_EVENT_MAP: Record<string, string> = {
  PreToolUse: 'before_tool_call',
  PostToolUse: 'after_model_call',
  Stop: 'on_loop_stop',
  OnError: 'on_error',
};

function registerHooksForClaude(
  versionHome: string,
  manifest: Record<string, ManifestHook>,
  resolveScript: (script: string) => string | null,
  managedPrefixes: string[],
  configDirName = '.claude',
  options?: { schemaVersion?: number }
): { registered: string[]; errors: string[] } {
  const registered: string[] = [];
  const errors: string[] = [];

  const configDir = path.join(versionHome, configDirName);
  const settingsPath = path.join(configDir, 'settings.json');

  let config: Record<string, unknown> = {};
  let existingRaw: string | undefined;
  if (fs.existsSync(settingsPath)) {
    try {
      existingRaw = fs.readFileSync(settingsPath, 'utf-8');
      config = JSON.parse(existingRaw);
    } catch {
      errors.push('Failed to parse settings.json');
      return { registered, errors };
    }
  }

  if (options?.schemaVersion !== undefined && config.schema_version === undefined) {
    config.schema_version = options.schemaVersion;
  }

  if (!config.hooks || typeof config.hooks !== 'object') {
    config.hooks = {};
  }
  const hooks = config.hooks as Record<string, unknown[]>;

  const expected = new Set<string>();
  for (const [hookName, hookDef] of Object.entries(manifest)) {
    if (!hookDef.events || hookDef.events.length === 0) continue;
    const resolved = resolveHookCommand(hookName, hookDef, resolveScript);
    if (!resolved) continue;
    for (const event of hookDef.events) expected.add(hookEntryKey(event, hookDef.matcher, resolved));
  }
  pruneManagedHookEntries(hooks as Parameters<typeof pruneManagedHookEntries>[0], expected, managedPrefixes);

  for (const [name, hookDef] of Object.entries(manifest)) {
    if (!hookDef.events || hookDef.events.length === 0) continue;

    const commandPath = resolveHookCommand(name, hookDef, resolveScript);
    if (!commandPath) {
      errors.push(`${name}: script not found in user or system hooks dir`);
      continue;
    }

    for (const event of hookDef.events) {
      if (!hooks[event]) {
        hooks[event] = [];
      }

      const eventEntries = hooks[event] as Array<{
        matcher?: string;
        hooks?: Array<{ type: string; command: string; timeout?: number }>;
      }>;

      const matcher = hookDef.matcher || '';
      const timeout = hookDef.timeout || 600;

      let matcherGroup = eventEntries.find((e) => (e.matcher || '') === matcher);
      if (!matcherGroup) {
        matcherGroup = { matcher, hooks: [] };
        eventEntries.push(matcherGroup);
      }

      if (!matcherGroup.hooks) {
        matcherGroup.hooks = [];
      }

      const existingIdx = matcherGroup.hooks.findIndex((h) => h.command === commandPath);
      const hookEntry = { type: 'command' as const, command: commandPath, timeout };

      if (existingIdx >= 0) {
        matcherGroup.hooks[existingIdx] = hookEntry;
      } else {
        matcherGroup.hooks.push(hookEntry);
      }

      registered.push(`${name} -> ${event}`);
    }
  }

  try {
    fs.mkdirSync(configDir, { recursive: true });
    const nextRaw = JSON.stringify(config, null, 2);
    if (existingRaw !== nextRaw) {
      fs.writeFileSync(settingsPath, nextRaw, 'utf-8');
    }
  } catch (err) {
    errors.push(`Failed to write settings.json: ${(err as Error).message}`);
  }

  return { registered, errors };
}

export function pruneVersionHomeHookEntriesFromSettings(
  settingsPath: string,
  agent: AgentId,
  removedVersion: string
): number {
  if (!fs.existsSync(settingsPath)) return 0;

  let config: Record<string, unknown>;
  try {
    config = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
  } catch {
    return 0;
  }
  if (!config.hooks || typeof config.hooks !== 'object') return 0;
  const hooks = config.hooks as Record<string, unknown[]>;

  let removed = 0;
  for (const eventEntries of Object.values(hooks)) {
    if (!Array.isArray(eventEntries)) continue;
    for (const group of eventEntries as Array<{ hooks?: Array<{ command: string }> }>) {
      if (!group.hooks) continue;
      const before = group.hooks.length;
      group.hooks = group.hooks.filter((h) => {
        const id = versionHomeIdentity(h.command);
        return !(id !== null && id.agent === agent && id.version === removedVersion);
      });
      removed += before - group.hooks.length;
    }
  }
  if (removed === 0) return 0;

  for (const [event, eventEntries] of Object.entries(hooks)) {
    if (!Array.isArray(eventEntries)) continue;
    hooks[event] = (eventEntries as Array<{ hooks?: unknown[] }>).filter(
      (g) => g.hooks && g.hooks.length > 0
    );
  }

  try {
    fs.writeFileSync(settingsPath, JSON.stringify(config, null, 2), 'utf-8');
  } catch {
    return 0;
  }
  return removed;
}

function trustCodexHooks(hooksPath: string): void {
  const hookPaths = [...new Set([hooksPath, path.join(fs.realpathSync(path.dirname(hooksPath)), 'hooks.json')])];
  const configPath = path.join(path.dirname(hooksPath), 'config.toml');
  const hooksFile = JSON.parse(fs.readFileSync(hooksPath, 'utf-8')) as CodexHooksFile;
  let tomlConfig: Record<string, unknown> = {};
  if (fs.existsSync(configPath)) {
    tomlConfig = TOML.parse(fs.readFileSync(configPath, 'utf-8')) as Record<string, unknown>;
  }

  if (!tomlConfig.features || typeof tomlConfig.features !== 'object') {
    tomlConfig.features = {};
  }
  const features = tomlConfig.features as Record<string, unknown>;
  delete features.codex_hooks;
  features.hooks = true;

  if (!tomlConfig.hooks || typeof tomlConfig.hooks !== 'object') {
    tomlConfig.hooks = {};
  }
  const hooksTable = tomlConfig.hooks as Record<string, unknown>;
  const existingState =
    hooksTable.state && typeof hooksTable.state === 'object'
      ? (hooksTable.state as Record<string, { enabled?: boolean; trusted_hash?: string }>)
      : {};
  const hookState: Record<string, { enabled?: boolean; trusted_hash?: string }> = {};

  for (const [event, eventGroups] of Object.entries(hooksFile.hooks)) {
    const eventKeyLabel = CODEX_EVENT_KEY_LABELS[event];
    if (!eventKeyLabel) continue;
    eventGroups.forEach((group, groupIdx) => {
      if (!group.hooks) return;
      group.hooks.forEach((handler, handlerIdx) => {
        if (handler.type !== 'command') return;
        const keys = hookPaths.map((file) => `${file}:${eventKeyLabel}:${groupIdx}:${handlerIdx}`);
        const trustedHash = computeCodexHookTrustHash(
          eventKeyLabel,
          handler.command,
          handler.timeout,
          group.matcher
        );
        const entry: { enabled?: boolean; trusted_hash?: string } = { trusted_hash: trustedHash };
        if (keys.some((key) => existingState[key]?.enabled === false)) {
          entry.enabled = false;
        }
        for (const key of keys) hookState[key] = entry;
      });
    });
  }

  for (const [key, entry] of Object.entries(existingState)) {
    if (!(key in hookState)) {
      hookState[key] = entry;
    }
  }

  hooksTable.state = hookState;

  fs.writeFileSync(configPath, TOML.stringify(tomlConfig as Parameters<typeof TOML.stringify>[0]), 'utf-8');
}

function registerHooksForCodex(
  versionHome: string,
  manifest: Record<string, ManifestHook>,
  resolveScript: (script: string) => string | null,
  managedPrefixes: string[]
): { registered: string[]; errors: string[] } {
  const registered: string[] = [];
  const errors: string[] = [];

  const configDir = path.join(versionHome, '.codex');
  const hooksPath = path.join(configDir, 'hooks.json');

  let hooksFile: CodexHooksFile = { hooks: {} };
  if (fs.existsSync(hooksPath)) {
    try {
      const existing = JSON.parse(fs.readFileSync(hooksPath, 'utf-8'));
      if (
        existing &&
        typeof existing === 'object' &&
        !Array.isArray(existing) &&
        existing.hooks &&
        typeof existing.hooks === 'object'
      ) {
        hooksFile = existing as CodexHooksFile;
      }
    } catch {
      errors.push('Failed to parse hooks.json');
      return { registered, errors };
    }
  }

  const expected = new Set<string>();
  for (const [hookName, hookDef] of Object.entries(manifest)) {
    if (!hookDef.events || hookDef.events.length === 0) continue;
    const resolved = resolveHookCommand(hookName, hookDef, resolveScript);
    if (!resolved) continue;
    for (const event of hookDef.events) {
      const matcher = CODEX_MATCHER_EVENTS.has(event) ? hookDef.matcher : undefined;
      expected.add(hookEntryKey(event, matcher, resolved));
    }
  }
  pruneManagedHookEntries(hooksFile.hooks, expected, managedPrefixes);

  for (const [name, hookDef] of Object.entries(manifest)) {
    if (!hookDef.events || hookDef.events.length === 0) continue;

    const commandPath = resolveHookCommand(name, hookDef, resolveScript);
    if (!commandPath) {
      errors.push(`${name}: script not found in user or system hooks dir`);
      continue;
    }

    const timeout = hookDef.timeout || 600;

    for (const event of hookDef.events) {
      if (!hooksFile.hooks[event]) {
        hooksFile.hooks[event] = [];
      }

      const eventGroups = hooksFile.hooks[event];

      const usesMatcher = CODEX_MATCHER_EVENTS.has(event);
      const matcherValue = usesMatcher ? (hookDef.matcher ?? '') : undefined;

      let group: CodexMatcherGroup | undefined;
      if (matcherValue !== undefined) {
        group = eventGroups.find((g) => (g.matcher ?? '') === matcherValue);
        if (!group) {
          group = matcherValue ? { matcher: matcherValue, hooks: [] } : { hooks: [] };
          eventGroups.push(group);
        }
      } else {
        group = eventGroups.find((g) => g.matcher === undefined);
        if (!group) {
          group = { hooks: [] };
          eventGroups.push(group);
        }
      }

      if (!group.hooks) {
        group.hooks = [];
      }

      const existingIdx = group.hooks.findIndex((h) => h.command === commandPath);
      const eventTimeout = event === 'SessionEnd' ? Math.min(timeout, 3) : timeout;
      const hookEntry = { type: 'command', command: commandPath, timeout: eventTimeout };

      if (existingIdx >= 0) {
        group.hooks[existingIdx] = hookEntry;
      } else {
        group.hooks.push(hookEntry);
      }

      registered.push(`${name} -> ${event}`);
    }
  }

  if (registered.length === 0) {
    return { registered, errors };
  }

  try {
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(hooksPath, JSON.stringify(hooksFile, null, 2), 'utf-8');
  } catch (err) {
    errors.push(`Failed to write hooks.json: ${(err as Error).message}`);
    return { registered, errors };
  }

  try {
    trustCodexHooks(hooksPath);
  } catch (err) {
    errors.push(`Failed to update config.toml: ${(err as Error).message}`);
  }

  return { registered, errors };
}

function registerHooksForAntigravity(
  versionHome: string,
  manifest: Record<string, ManifestHook>,
  resolveScript: (script: string) => string | null,
  managedPrefixes: string[]
): { registered: string[]; errors: string[] } {
  const registered: string[] = [];
  const errors: string[] = [];

  const configDir = path.join(versionHome, '.gemini', 'antigravity-cli');
  const settingsPath = path.join(configDir, 'settings.json');

  let config: Record<string, unknown> = {};
  if (fs.existsSync(settingsPath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        config = parsed as Record<string, unknown>;
      }
    } catch {
      errors.push('Failed to parse antigravity settings.json');
      return { registered, errors };
    }
  }

  if (!config.hooks || typeof config.hooks !== 'object' || Array.isArray(config.hooks)) {
    config.hooks = {};
  }
  const hooks = config.hooks as Record<string, unknown[]>;

  const currentManifestPaths = new Set<string>();
  for (const [hookName, hookDef] of Object.entries(manifest)) {
    if (!hookDef.events || hookDef.events.length === 0) continue;
    const anyMapped = hookDef.events.some((e) => ANTIGRAVITY_EVENT_MAP[e]);
    if (!anyMapped) continue;
    const resolved = resolveHookCommand(hookName, hookDef, resolveScript);
    if (resolved) currentManifestPaths.add(resolved);
  }

  for (const eventKey of Object.keys(hooks)) {
    const entries = hooks[eventKey];
    if (!Array.isArray(entries)) continue;
    hooks[eventKey] = entries.filter((entry) => {
      if (!entry || typeof entry !== 'object') return true;
      const cmd = (entry as { command?: unknown }).command;
      if (typeof cmd !== 'string') return true;
      if (!isManagedHookCommand(cmd, managedPrefixes)) return true;
      return currentManifestPaths.has(cmd);
    });
    if ((hooks[eventKey] as unknown[]).length === 0) {
      delete hooks[eventKey];
    }
  }

  for (const [name, hookDef] of Object.entries(manifest)) {
    if (!hookDef.events || hookDef.events.length === 0) continue;

    const commandPath = resolveHookCommand(name, hookDef, resolveScript);
    if (!commandPath) {
      errors.push(`${name}: script not found in user or system hooks dir`);
      continue;
    }

    for (const event of hookDef.events) {
      const agyEvent = ANTIGRAVITY_EVENT_MAP[event];
      if (!agyEvent) continue;

      if (!hooks[agyEvent]) {
        hooks[agyEvent] = [];
      }
      const list = hooks[agyEvent] as Array<{ command: string; matcher?: string }>;

      const existingIdx = list.findIndex(
        (e) => e && typeof e === 'object' && e.command === commandPath
      );
      const entry: { command: string; matcher?: string } = { command: commandPath };
      if (hookDef.matcher) entry.matcher = hookDef.matcher;
      if (existingIdx >= 0) {
        list[existingIdx] = entry;
      } else {
        list.push(entry);
      }

      registered.push(`${name} -> ${agyEvent}`);
    }
  }

  try {
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(settingsPath, JSON.stringify(config, null, 2) + '\n', 'utf-8');
  } catch (err) {
    errors.push(`Failed to write antigravity settings.json: ${(err as Error).message}`);
  }

  return { registered, errors };
}

const GROK_MATCHER_EVENTS = new Set(['PreToolUse', 'PostToolUse', 'Notification']);

const GROK_MATCHER_ALIASES: Record<string, string> = {
  ExitPlanMode: 'ExitPlanMode|exit_plan_mode',
};

function registerHooksForGrok(
  versionHome: string,
  manifest: Record<string, ManifestHook>,
  resolveScript: (script: string) => string | null,
  managedPrefixes: string[]
): { registered: string[]; errors: string[] } {
  const registered: string[] = [];
  const errors: string[] = [];

  const grokHooksDir = path.join(versionHome, '.grok', 'hooks');
  fs.mkdirSync(grokHooksDir, { recursive: true });

  const eventMap: Record<string, string> = {
    SessionStart: 'SessionStart',
    SessionEnd: 'SessionEnd',
    UserPromptSubmit: 'UserPromptSubmit',
    PreToolUse: 'PreToolUse',
    PostToolUse: 'PostToolUse',
    PreCompact: 'PreCompact',
    Stop: 'Stop',
    Notification: 'Notification',
  };

  type GrokGroup = {
    matcher?: string;
    hooks: Array<{ type: 'command'; command: string; timeout: number }>;
  };
  const grokHooks: { hooks: Record<string, GrokGroup[]> } = { hooks: {} };

  for (const [name, hookDef] of Object.entries(manifest)) {
    if (!hookDef.events || hookDef.events.length === 0) continue;

    const commandPath = resolveHookCommand(name, hookDef, resolveScript);
    if (!commandPath) {
      errors.push(`${name}: script not found`);
      continue;
    }

    const timeout = hookDef.timeout ?? 30;

    for (const ev of hookDef.events) {
      const grokEvent = eventMap[ev] || ev;

      if (!grokHooks.hooks[grokEvent]) {
        grokHooks.hooks[grokEvent] = [];
      }
      const groups = grokHooks.hooks[grokEvent];

      let matcher: string | undefined;
      if (GROK_MATCHER_EVENTS.has(grokEvent) && hookDef.matcher) {
        matcher = GROK_MATCHER_ALIASES[hookDef.matcher] ?? hookDef.matcher;
      }

      let group = groups.find((g) => (g.matcher ?? '') === (matcher ?? ''));
      if (!group) {
        group = matcher ? { matcher, hooks: [] } : { hooks: [] };
        groups.push(group);
      }

      const hookEntry = { type: 'command' as const, command: commandPath, timeout };
      const existingIdx = group.hooks.findIndex((h) => h.command === commandPath);
      if (existingIdx >= 0) {
        group.hooks[existingIdx] = hookEntry;
      } else {
        group.hooks.push(hookEntry);
      }

      registered.push(`${name} -> ${grokEvent}`);
    }
  }

  const mainHooksPath = path.join(grokHooksDir, 'hooks.json');
  try {
    fs.writeFileSync(mainHooksPath, JSON.stringify(grokHooks, null, 2));
  } catch (e) {
    errors.push(`Failed to write hooks.json: ${(e as Error).message}`);
  }

  try {
    for (const file of fs.readdirSync(grokHooksDir)) {
      if (!file.endsWith('.json') || file === 'hooks.json') continue;
      const filePath = path.join(grokHooksDir, file);
      if (isManagedGrokHookFile(filePath, managedPrefixes)) {
        fs.rmSync(filePath, { force: true });
      }
    }
  } catch (e) {
    errors.push(`Failed to prune stale grok hook files: ${(e as Error).message}`);
  }

  return { registered, errors };
}

function isManagedGrokHookFile(filePath: string, managedPrefixes: string[]): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch {
    return false;
  }
  if (!parsed || typeof parsed !== 'object') return false;
  const hooks = (parsed as { hooks?: unknown }).hooks;
  if (!hooks || typeof hooks !== 'object' || Array.isArray(hooks)) return false;

  const commands: string[] = [];
  for (const groups of Object.values(hooks as Record<string, unknown>)) {
    if (!Array.isArray(groups)) return false;
    for (const group of groups) {
      const entries = (group as { hooks?: unknown }).hooks;
      if (!Array.isArray(entries)) return false;
      for (const entry of entries) {
        const cmd = (entry as { command?: unknown }).command;
        if (typeof cmd !== 'string') return false;
        commands.push(cmd);
      }
    }
  }
  if (commands.length === 0) return false;
  return commands.every((cmd) => isManagedHookCommand(cmd, managedPrefixes));
}

function registerHooksForKimi(
  versionHome: string,
  manifest: Record<string, ManifestHook>,
  resolveScript: (script: string) => string | null,
  managedPrefixes: string[]
): { registered: string[]; errors: string[] } {
  const registered: string[] = [];
  const errors: string[] = [];

  const configPath = path.join(versionHome, '.kimi-code', 'config.toml');

  let config: Record<string, unknown> = {};
  if (fs.existsSync(configPath)) {
    try {
      config = TOML.parse(fs.readFileSync(configPath, 'utf-8')) as Record<string, unknown>;
    } catch {
      errors.push('Failed to parse config.toml');
      return { registered, errors };
    }
  }

  const currentManifestPaths = new Set<string>();
  for (const [hookName, hookDef] of Object.entries(manifest)) {
    if (!hookDef.events || hookDef.events.length === 0) continue;
    const resolved = resolveHookCommand(hookName, hookDef, resolveScript);
    if (resolved) currentManifestPaths.add(resolved);
  }

  let hooksArray: Array<Record<string, unknown>> = [];
  if (Array.isArray(config.hooks)) {
    hooksArray = config.hooks as Array<Record<string, unknown>>;
  }

  const filteredHooks = hooksArray.filter((h) => {
    const cmd = typeof h.command === 'string' ? h.command : '';
    if (!cmd) return true;
    if (!isManagedHookCommand(cmd, managedPrefixes)) return true;
    return currentManifestPaths.has(cmd);
  });

  for (const [name, hookDef] of Object.entries(manifest)) {
    if (!hookDef.events || hookDef.events.length === 0) continue;

    const commandPath = resolveHookCommand(name, hookDef, resolveScript);
    if (!commandPath) {
      errors.push(`${name}: script not found in user or system hooks dir`);
      continue;
    }

    const timeout = hookDef.timeout ?? 30;

    for (const event of hookDef.events) {
      const matcher = hookDef.matcher;

      const existingIdx = filteredHooks.findIndex((h) => {
        const sameEvent = h.event === event;
        const sameCmd = h.command === commandPath;
        const sameMatcher = (h.matcher ?? '') === (matcher ?? '');
        return sameEvent && sameCmd && sameMatcher;
      });

      const hookEntry: Record<string, unknown> = {
        event,
        command: commandPath,
        timeout,
      };
      if (matcher) {
        hookEntry.matcher = matcher;
      }

      if (existingIdx >= 0) {
        filteredHooks[existingIdx] = hookEntry;
      } else {
        filteredHooks.push(hookEntry);
      }

      registered.push(`${name} -> ${event}`);
    }
  }

  config.hooks = filteredHooks;

  try {
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, TOML.stringify(config as Parameters<typeof TOML.stringify>[0]), 'utf-8');
  } catch (err) {
    errors.push(`Failed to write config.toml: ${(err as Error).message}`);
  }

  return { registered, errors };
}


const COPILOT_EVENT_MAP: Record<string, string> = {
  SessionStart: 'sessionStart',
  SessionEnd: 'sessionEnd',
  UserPromptSubmit: 'userPromptSubmitted',
  PreToolUse: 'preToolUse',
  PostToolUse: 'postToolUse',
  PostToolUseFailure: 'postToolUseFailure',
  Stop: 'agentStop',
  SubagentStart: 'subagentStart',
  SubagentStop: 'subagentStop',
  OnError: 'errorOccurred',
  PreCompact: 'preCompact',
  Notification: 'notification',
  PermissionRequest: 'permissionRequest',
};

const COPILOT_MATCHER_EVENTS = new Set([
  'preToolUse',
  'postToolUse',
  'permissionRequest',
  'preCompact',
  'notification',
  'subagentStart',
]);

const COPILOT_MANAGED_HOOKS_FILE = 'agents-cli-hooks.json';

function registerHooksForCopilot(
  versionHome: string,
  manifest: Record<string, ManifestHook>,
  resolveScript: (script: string) => string | null,
  _managedPrefixes: string[]
): { registered: string[]; errors: string[] } {
  const registered: string[] = [];
  const errors: string[] = [];

  const copilotHooksDir = path.join(versionHome, '.copilot', 'hooks');
  fs.mkdirSync(copilotHooksDir, { recursive: true });

  type CopilotEntry = {
    type: 'command';
    command: string;
    timeoutSec: number;
    matcher?: string;
  };
  const hooks: Record<string, CopilotEntry[]> = {};

  for (const [name, hookDef] of Object.entries(manifest)) {
    if (!hookDef.events || hookDef.events.length === 0) continue;

    const commandPath = resolveHookCommand(name, hookDef, resolveScript);
    if (!commandPath) {
      errors.push(`${name}: script not found in user or system hooks dir`);
      continue;
    }

    const timeoutSec = hookDef.timeout ?? 30;

    for (const event of hookDef.events) {
      const copilotEvent = COPILOT_EVENT_MAP[event];
      if (!copilotEvent) continue;

      if (!hooks[copilotEvent]) hooks[copilotEvent] = [];

      const entry: CopilotEntry = {
        type: 'command',
        command: commandPath,
        timeoutSec,
      };
      if (COPILOT_MATCHER_EVENTS.has(copilotEvent) && hookDef.matcher) {
        entry.matcher = hookDef.matcher;
      }

      const existingIdx = hooks[copilotEvent].findIndex(
        (h) => h.command === entry.command && (h.matcher ?? '') === (entry.matcher ?? '')
      );
      if (existingIdx >= 0) {
        hooks[copilotEvent][existingIdx] = entry;
      } else {
        hooks[copilotEvent].push(entry);
      }

      registered.push(`${name} -> ${copilotEvent}`);
    }
  }

  const outPath = path.join(copilotHooksDir, COPILOT_MANAGED_HOOKS_FILE);
  try {
    fs.writeFileSync(
      outPath,
      JSON.stringify({ version: 1, hooks }, null, 2) + '\n',
      'utf-8'
    );
  } catch (err) {
    errors.push(`Failed to write ${COPILOT_MANAGED_HOOKS_FILE}: ${(err as Error).message}`);
  }

  return { registered, errors };
}







const GOOSE_EVENT_MAP: Record<string, string> = {
  SessionStart: 'SessionStart',
  SessionEnd: 'SessionEnd',
  Stop: 'Stop',
  UserPromptSubmit: 'UserPromptSubmit',
  PreToolUse: 'PreToolUse',
  PostToolUse: 'PostToolUse',
  PostToolUseFailure: 'PostToolUseFailure',
  BeforeReadFile: 'BeforeReadFile',
  AfterFileEdit: 'AfterFileEdit',
  BeforeShellExecution: 'BeforeShellExecution',
  AfterShellExecution: 'AfterShellExecution',
};

const GOOSE_MANAGED_PLUGIN_NAME = 'agents-cli-hooks';

function registerHooksForGoose(
  versionHome: string,
  manifest: Record<string, ManifestHook>,
  resolveScript: (script: string) => string | null,
  _managedPrefixes: string[]
): { registered: string[]; errors: string[] } {
  const registered: string[] = [];
  const errors: string[] = [];

  type GooseCmd = { type: 'command'; command: string; timeout?: number };
  type GooseGroup = { matcher?: string; hooks: GooseCmd[] };
  const eventHooks: Record<string, GooseGroup[]> = {};

  for (const [name, hookDef] of Object.entries(manifest)) {
    if (!hookDef.events || hookDef.events.length === 0) continue;

    const commandPath = resolveHookCommand(name, hookDef, resolveScript);
    if (!commandPath) {
      errors.push(`${name}: script not found in user or system hooks dir`);
      continue;
    }

    const timeout = hookDef.timeout ?? 60;
    const cmd: GooseCmd = { type: 'command', command: commandPath, timeout };

    for (const event of hookDef.events) {
      const gooseEvent = GOOSE_EVENT_MAP[event];
      if (!gooseEvent) continue;

      if (!eventHooks[gooseEvent]) eventHooks[gooseEvent] = [];
      const groups = eventHooks[gooseEvent];
      const matcher = hookDef.matcher || undefined;

      let group = groups.find((g) => (g.matcher || undefined) === matcher);
      if (!group) {
        group = { hooks: [] };
        if (matcher) group.matcher = matcher;
        groups.push(group);
      }

      const existingIdx = group.hooks.findIndex((h) => h.command === cmd.command);
      if (existingIdx >= 0) {
        group.hooks[existingIdx] = cmd;
      } else {
        group.hooks.push(cmd);
      }

      registered.push(`${name} -> ${gooseEvent}`);
    }
  }

  const pluginRoot = path.join(versionHome, '.agents', 'plugins', GOOSE_MANAGED_PLUGIN_NAME);
  const hooksDir = path.join(pluginRoot, 'hooks');
  const outPath = path.join(hooksDir, 'hooks.json');

  try {
    fs.mkdirSync(hooksDir, { recursive: true });
    const markerPath = path.join(pluginRoot, '.agents-cli-managed');
    if (!fs.existsSync(markerPath)) {
      fs.writeFileSync(markerPath, 'managed by agents-cli hooks sync\n', 'utf-8');
    }
    fs.writeFileSync(
      outPath,
      JSON.stringify({ hooks: eventHooks }, null, 2) + '\n',
      'utf-8'
    );
  } catch (err) {
    errors.push(`Failed to write goose hooks plugin: ${(err as Error).message}`);
  }

  return { registered, errors };
}


const CURSOR_EVENT_MAP: Record<string, string> = {
  SessionStart: 'sessionStart',
  SessionEnd: 'sessionEnd',
  Stop: 'stop',
  UserPromptSubmit: 'beforeSubmitPrompt',
  PreToolUse: 'preToolUse',
  PostToolUse: 'postToolUse',
  PostToolUseFailure: 'postToolUseFailure',
  PreCompact: 'preCompact',
  SubagentStart: 'subagentStart',
  SubagentStop: 'subagentStop',
  BeforeShellExecution: 'beforeShellExecution',
  AfterShellExecution: 'afterShellExecution',
  BeforeReadFile: 'beforeReadFile',
  AfterFileEdit: 'afterFileEdit',
};

function registerHooksForCursor(
  versionHome: string,
  manifest: Record<string, ManifestHook>,
  resolveScript: (script: string) => string | null,
  managedPrefixes: string[]
): { registered: string[]; errors: string[] } {
  const registered: string[] = [];
  const errors: string[] = [];

  const configDir = path.join(versionHome, '.cursor');
  const hooksPath = path.join(configDir, 'hooks.json');

  type CursorEntry = {
    command: string;
    timeout?: number;
    matcher?: string;
  };

  let existing: { version?: number; hooks?: Record<string, CursorEntry[]> } = { version: 1, hooks: {} };
  if (fs.existsSync(hooksPath)) {
    try {
      existing = JSON.parse(fs.readFileSync(hooksPath, 'utf-8'));
      if (!existing.hooks || typeof existing.hooks !== 'object') existing.hooks = {};
    } catch {
      errors.push('Failed to parse existing hooks.json');
      return { registered, errors };
    }
  }

  const desiredManaged = new Set<string>();
  for (const [hookName, hookDef] of Object.entries(manifest)) {
    if (!hookDef.events || hookDef.events.length === 0) continue;
    const resolved = resolveHookCommand(hookName, hookDef, resolveScript);
    if (!resolved) continue;
    for (const event of hookDef.events) {
      const cursorEvent = CURSOR_EVENT_MAP[event];
      if (!cursorEvent) continue;
      desiredManaged.add(`${cursorEvent}|${resolved}|${hookDef.matcher ?? ''}`);
    }
  }

  const hooks: Record<string, CursorEntry[]> = {};
  for (const [event, entries] of Object.entries(existing.hooks || {})) {
    if (!Array.isArray(entries)) continue;
    hooks[event] = entries.filter((e) => {
      if (typeof e?.command !== 'string') return true;
      if (!isManagedHookCommand(e.command, managedPrefixes)) return true;
      return desiredManaged.has(`${event}|${e.command}|${e.matcher ?? ''}`);
    });
    if (hooks[event].length === 0) delete hooks[event];
  }

  for (const [name, hookDef] of Object.entries(manifest)) {
    if (!hookDef.events || hookDef.events.length === 0) continue;

    const commandPath = resolveHookCommand(name, hookDef, resolveScript);
    if (!commandPath) {
      errors.push(`${name}: script not found in user or system hooks dir`);
      continue;
    }

    const timeout = hookDef.timeout ?? 30;

    for (const event of hookDef.events) {
      const cursorEvent = CURSOR_EVENT_MAP[event];
      if (!cursorEvent) continue;

      if (!hooks[cursorEvent]) hooks[cursorEvent] = [];

      const entry: CursorEntry = { command: commandPath, timeout };
      if (hookDef.matcher) entry.matcher = hookDef.matcher;

      const existingIdx = hooks[cursorEvent].findIndex(
        (h) => h.command === entry.command && (h.matcher ?? '') === (entry.matcher ?? '')
      );
      if (existingIdx >= 0) {
        hooks[cursorEvent][existingIdx] = entry;
      } else {
        hooks[cursorEvent].push(entry);
      }

      registered.push(`${name} -> ${cursorEvent}`);
    }
  }

  try {
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(
      hooksPath,
      JSON.stringify({ version: 1, hooks }, null, 2) + '\n',
      'utf-8'
    );
  } catch (err) {
    errors.push(`Failed to write hooks.json: ${(err as Error).message}`);
  }

  return { registered, errors };
}

const HERMES_EVENT_MAP: Record<string, string> = {
  SessionStart: 'on_session_start',
  SessionEnd: 'on_session_end',
  PreToolUse: 'pre_tool_call',
  PostToolUse: 'post_tool_call',
  SubagentStop: 'subagent_stop',
  UserPromptSubmit: 'pre_llm_call',
  Stop: 'on_session_finalize',
};

const HERMES_TIMEOUT_CAP = 300;
const HERMES_TIMEOUT_DEFAULT = 60;

function registerHooksForHermes(
  versionHome: string,
  manifest: Record<string, ManifestHook>,
  resolveScript: (script: string) => string | null,
  managedPrefixes: string[]
): { registered: string[]; errors: string[] } {
  const registered: string[] = [];
  const errors: string[] = [];

  const configDir = path.join(versionHome, '.hermes');
  const configPath = path.join(configDir, 'config.yaml');

  type HermesEntry = { command: string; timeout: number; matcher?: string };

  let config: Record<string, unknown> = {};
  if (fs.existsSync(configPath)) {
    try {
      const parsed = yaml.parse(fs.readFileSync(configPath, 'utf-8'));
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        config = parsed as Record<string, unknown>;
      }
    } catch {
      errors.push('Failed to parse existing config.yaml');
      return { registered, errors };
    }
  }

  const existingHooks =
    config.hooks && typeof config.hooks === 'object' && !Array.isArray(config.hooks)
      ? (config.hooks as Record<string, HermesEntry[]>)
      : {};

  const desiredManaged = new Set<string>();
  for (const [hookName, hookDef] of Object.entries(manifest)) {
    if (!hookDef.events || hookDef.events.length === 0) continue;
    const resolved = resolveHookCommand(hookName, hookDef, resolveScript);
    if (!resolved) continue;
    for (const event of hookDef.events) {
      const hermesEvent = HERMES_EVENT_MAP[event];
      if (!hermesEvent) continue;
      desiredManaged.add(`${hermesEvent}|${resolved}|${hookDef.matcher ?? ''}`);
    }
  }

  const hooks: Record<string, HermesEntry[]> = {};
  for (const [event, entries] of Object.entries(existingHooks)) {
    if (!Array.isArray(entries)) continue;
    hooks[event] = entries.filter((e) => {
      if (typeof e?.command !== 'string') return true;
      if (!isManagedHookCommand(e.command, managedPrefixes)) return true;
      return desiredManaged.has(`${event}|${e.command}|${e.matcher ?? ''}`);
    });
    if (hooks[event].length === 0) delete hooks[event];
  }

  for (const [name, hookDef] of Object.entries(manifest)) {
    if (!hookDef.events || hookDef.events.length === 0) continue;

    const commandPath = resolveHookCommand(name, hookDef, resolveScript);
    if (!commandPath) {
      errors.push(`${name}: script not found in user or system hooks dir`);
      continue;
    }

    const timeout = Math.min(HERMES_TIMEOUT_CAP, hookDef.timeout ?? HERMES_TIMEOUT_DEFAULT);

    for (const event of hookDef.events) {
      const hermesEvent = HERMES_EVENT_MAP[event];
      if (!hermesEvent) continue;

      if (!hooks[hermesEvent]) hooks[hermesEvent] = [];

      const entry: HermesEntry = { command: commandPath, timeout };
      if (hookDef.matcher) entry.matcher = hookDef.matcher;

      const existingIdx = hooks[hermesEvent].findIndex(
        (h) => h.command === entry.command && (h.matcher ?? '') === (entry.matcher ?? '')
      );
      if (existingIdx >= 0) {
        hooks[hermesEvent][existingIdx] = entry;
      } else {
        hooks[hermesEvent].push(entry);
      }

      registered.push(`${name} -> ${hermesEvent}`);
    }
  }

  if (Object.keys(hooks).length > 0) {
    config.hooks = hooks;
  } else {
    delete config.hooks;
  }

  try {
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(configPath, yaml.stringify(config), 'utf-8');
  } catch (err) {
    errors.push(`Failed to write config.yaml: ${(err as Error).message}`);
  }

  return { registered, errors };
}

const execFileAsync = promisify(execFile);

interface InstallSessionTrackerHookResult {
  installed: boolean;
  error?: string;
}

function resolveSessionTrackerRoot(): string | null {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const built = path.resolve(here, '..', '..', 'session-tracker');
  if (fs.existsSync(path.join(built, 'dist', 'hook.sh'))) {
    return built;
  }
  const source = path.resolve(here, '..', '..', '..', '..', 'packages', 'session-tracker');
  if (fs.existsSync(path.join(source, 'src', 'hook.sh'))) {
    return source;
  }
  return null;
}

function resolveTsxLoader(trackerRoot: string): string | null {
  const loader = path.join(trackerRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs');
  if (fs.existsSync(loader)) return loader;
  return null;
}

function buildInstallHookInvocation(
  trackerRoot: string,
  agent: AgentId,
): { command: string; args: string[] } | null {
  const distScript = path.join(trackerRoot, 'dist', 'install-hook.js');
  if (fs.existsSync(distScript)) {
    return { command: process.execPath, args: [distScript, agent] };
  }
  const loader = resolveTsxLoader(trackerRoot);
  if (!loader) return null;
  return {
    command: process.execPath,
    args: [loader, path.join(trackerRoot, 'src', 'install-hook.ts'), agent],
  };
}

export async function installSessionTrackerHook(
  agent: AgentId,
  version?: string,
  home?: string,
): Promise<InstallSessionTrackerHookResult> {
  const gate = supports(agent, 'hooks', version);
  if (!gate.ok) {
    return { installed: false, error: explainSkip(agent, 'hooks', gate, version) };
  }
  const trackerRoot = resolveSessionTrackerRoot();
  if (!trackerRoot) {
    return { installed: false, error: 'session-tracker package not found' };
  }
  const invocation = buildInstallHookInvocation(trackerRoot, agent);
  if (!invocation) {
    return { installed: false, error: 'session-tracker not built and tsx is unavailable' };
  }
  try {
    const env = sessionTrackerInstallEnv(agent, version, home);
    await execFileAsync(invocation.command, invocation.args, {
      env,
      encoding: 'utf8',
    });
    if (agent === 'codex') trustCodexHooks(path.join(env.HOME ?? os.homedir(), '.codex', 'hooks.json'));
    return { installed: true };
  } catch (err) {
    return { installed: false, error: installFailureMessage(err) };
  }
}

function installFailureMessage(err: unknown): string {
  const e = err as Error & { stdout?: string | Buffer; stderr?: string | Buffer };
  for (const stream of [e.stderr, e.stdout]) {
    const text = stream == null ? '' : String(stream).trim();
    if (text.length > 0) return text;
  }
  return e.message;
}

export function installSessionTrackerHookSync(
  agent: AgentId,
  version?: string,
  home?: string,
): InstallSessionTrackerHookResult {
  const gate = supports(agent, 'hooks', version);
  if (!gate.ok) {
    return { installed: false, error: explainSkip(agent, 'hooks', gate, version) };
  }
  const trackerRoot = resolveSessionTrackerRoot();
  if (!trackerRoot) {
    return { installed: false, error: 'session-tracker package not found' };
  }
  const invocation = buildInstallHookInvocation(trackerRoot, agent);
  if (!invocation) {
    return { installed: false, error: 'session-tracker not built and tsx is unavailable' };
  }
  try {
    const env = sessionTrackerInstallEnv(agent, version, home);
    execFileSync(invocation.command, invocation.args, {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      encoding: 'utf8',
    });
    if (agent === 'codex') trustCodexHooks(path.join(env.HOME ?? os.homedir(), '.codex', 'hooks.json'));
    return { installed: true };
  } catch (err) {
    return { installed: false, error: installFailureMessage(err) };
  }
}

function sessionTrackerInstallEnv(agent: AgentId, version?: string, home?: string): NodeJS.ProcessEnv {

  const target = home ?? (version ? getVersionHomePath(agent, version) : undefined);
  if (agent === 'codex' && target && version) {
    const originHome = path.join(target, '.codex');
    const historyDir = getHistoryDir();
    resolveCodexHome(originHome, path.dirname(historyDir), codexShortKey(originHome, version, historyDir));
  }
  return target ? { ...process.env, HOME: target, USERPROFILE: target } : { ...process.env };
}
