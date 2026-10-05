import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import * as yaml from 'yaml';
import { atomicWriteFileSync, withFileLock } from '../fs-atomic.js';
import { installationLockTarget, INSTALLATION_LOCK_OPTIONS } from './installation-lock.js';
import { getHomeDir, getUserAgentsDir, getVersionsDir, readMeta } from '../state.js';
import { VERSION_RE, compareVersions } from '../agent-spec/primitives.js';
import type { AgentId } from '../types.js';
import { AGENTS, findInPath } from '../agents.js';
import { IS_WINDOWS } from '../platform/index.js';
import { getConfigSymlinkVersion } from './shims.js';
import { INSTALLATION_RECORD_FILE, INSTALLATION_SCHEMA, type Installation } from './types.js';

const execFileAsync = promisify(execFile);


export function installationDir(agent: AgentId, label: string): string {
  return path.join(getVersionsDir(), agent, label);
}

export function installationRecordPath(agent: AgentId, label: string): string {
  return path.join(installationDir(agent, label), INSTALLATION_RECORD_FILE);
}

// IDs are opaque and permanent; repair/update must preserve them.
export function mintInstallationId(): string {
  return `ins_${crypto.randomBytes(12).toString('hex')}`;
}

function nowIso(): string {
  return new Date().toISOString();
}

function assertValidRecord(value: unknown, file: string): Installation {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Installation record corrupted at ${file}: expected a JSON object.`);
  }
  const record = value as Partial<Installation>;
  if (typeof record.schema !== 'number') {
    throw new Error(`Installation record corrupted at ${file}: missing numeric "schema".`);
  }
  if (record.schema > INSTALLATION_SCHEMA) {
    throw new Error(
      `Installation record at ${file} was written by a newer agents-cli (schema ${record.schema} > ${INSTALLATION_SCHEMA}). Upgrade agents-cli.`
    );
  }
  for (const key of ['id', 'agent', 'label', 'releaseVersion', 'createdAt', 'updatedAt'] as const) {
    if (typeof record[key] !== 'string' || !record[key]) {
      throw new Error(`Installation record corrupted at ${file}: missing string "${key}".`);
    }
  }
  if (!Array.isArray(record.history) || record.history.length === 0) {
    throw new Error(`Installation record corrupted at ${file}: "history" must be a non-empty array.`);
  }
  if (record.updatePolicy !== undefined && record.updatePolicy !== 'latest' && record.updatePolicy !== 'pinned') {
    throw new Error(`Installation record corrupted at ${file}: unknown update policy.`);
  }
  return record as Installation;
}

export function readInstallation(agent: AgentId, label: string): Installation | null {
  const file = installationRecordPath(agent, label);
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf-8');
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`Installation record corrupted at ${file}: not valid JSON.`);
  }
  return assertValidRecord(parsed, file);
}

export function installedReleaseFor(agent: AgentId, label: string): string {
  if (!Object.hasOwn(AGENTS, agent) || !VERSION_RE.test(label)) return label;
  return readInstallation(agent, label)?.releaseVersion ?? label;
}

export function writeInstallation(installation: Installation): void {
  const file = installationRecordPath(installation.agent, installation.label);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  atomicWriteFileSync(file, `${JSON.stringify(installation, null, 2)}\n`);
}

export function ensureInstallation(agent: AgentId, label: string): Installation {
  const existing = readInstallation(agent, label);
  if (existing) return existing;
  if (!fs.existsSync(installationDir(agent, label))) throw new Error(`No installation directory for ${agent}@${label}.`);
  const createdAt = fs.statSync(installationDir(agent, label)).mtime.toISOString();
  return withFileLock(installationLockTarget(agent, label),
    () => ensureInstallationLocked(agent, label, createdAt),
    { ...INSTALLATION_LOCK_OPTIONS, acquireTimeoutMs: 0 });
}

export function ensureInstallationLocked(agent: AgentId, label: string, legacyCreatedAt?: string): Installation {
  const existing = readInstallation(agent, label);
  if (existing) return existing;

  const dir = installationDir(agent, label);
  if (!fs.existsSync(dir)) {
    throw new Error(`No installation directory for ${agent}@${label} at ${dir}.`);
  }
  let createdAt: string;
  try {
    createdAt = legacyCreatedAt ?? fs.statSync(dir).mtime.toISOString();
  } catch {
    createdAt = nowIso();
  }
  const migrated: Installation = {
    schema: INSTALLATION_SCHEMA,
    id: mintInstallationId(),
    agent,
    label,
    releaseVersion: label,
    createdAt,
    updatedAt: createdAt,
    history: [{ releaseVersion: label, at: createdAt }],
  };
  writeInstallation(migrated);
  return migrated;
}

export function createInstallation(
  agent: AgentId,
  label: string,
  releaseVersion: string,
  initialPolicy: Installation['updatePolicy'] = 'latest',
): Installation {
  if (!VERSION_RE.test(label)) {
    throw new Error(`Invalid installation label: ${JSON.stringify(label)}`);
  }
  const existing = readInstallation(agent, label);
  if (existing) {
    return existing.releaseVersion === releaseVersion
      ? existing
      : recordRelease(existing, releaseVersion);
  }
  const at = nowIso();
  const created: Installation = {
    schema: INSTALLATION_SCHEMA,
    id: mintInstallationId(),
    agent,
    label,
    releaseVersion,
    createdAt: at,
    updatedAt: at,
    history: [{ releaseVersion, at }],
    updatePolicy: initialPolicy,
  };
  writeInstallation(created);
  return created;
}

// The label is stable installation identity; releaseVersion is the moving payload.
export function recordRelease(installation: Installation, releaseVersion: string): Installation {
  const at = nowIso();
  const next: Installation = {
    ...installation,
    releaseVersion,
    updatedAt: at,
    history: [...installation.history, { releaseVersion, at }],
  };
  writeInstallation(next);
  return next;
}

export function listInstallationLabels(agent: AgentId): string[] {
  const agentDir = path.join(getVersionsDir(), agent);
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(agentDir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.isDirectory() && VERSION_RE.test(entry.name))
    .map((entry) => entry.name)
    .sort();
}

export function listInstallations(agent: AgentId): Installation[] {
  const out: Installation[] = [];
  for (const label of listInstallationLabels(agent)) {
    try {
      out.push(ensureInstallation(agent, label));
    } catch {
    }
  }
  return out;
}

/**
 * The label of the single managed installation every harness gets under the
 * account model v2 (PHNX-3940). One managed install per harness per device;
 * accounts live in credential slots beside it, and a second home is an expert
 * `--isolated` copy, never another managed install.
 */
export const MANAGED_INSTALLATION_LABEL = 'main';

export function resolveManagedInstallation(agent: AgentId): Installation | null {
  const managed = listInstallations(agent).filter((i) => !isVersionIsolated(agent, i.label));
  if (managed.length === 0) return null;
  const main = managed.find((i) => i.label === MANAGED_INSTALLATION_LABEL);
  if (main) return main;
  const globalDefault = getGlobalDefault(agent);
  const def = globalDefault ? managed.find((i) => i.label === globalDefault) : undefined;
  return def ?? managed[0];
}

export interface EnsureHarnessInstallationResult {
  installation: Installation;
  installed: boolean;
}

export async function ensureHarnessInstallation(
  agent: AgentId,
  opts: { release?: string; onProgress?: (message: string) => void } = {},
): Promise<EnsureHarnessInstallationResult> {
  const existing = resolveManagedInstallation(agent);
  if (existing) return { installation: existing, installed: false };
  const release = opts.release ?? 'latest';
  const { installVersion } = await import('./versions.js');
  const result = await installVersion(agent, release, opts.onProgress, { installationLabel: MANAGED_INSTALLATION_LABEL });
  if (!result.success) {
    throw new Error(result.error || `Failed to install ${agent}@${release}.`);
  }
  const record = readInstallation(agent, MANAGED_INSTALLATION_LABEL);
  if (!record) {
    throw new Error(`Install of ${agent}@${release} reported success but left no installation record at ${MANAGED_INSTALLATION_LABEL}.`);
  }
  return { installation: record, installed: true };
}

export function getVersionDir(agent: AgentId, version: string): string {
  return path.join(getVersionsDir(), agent, version);
}

const MIN_GROK_BINARY_BYTES = 1_000_000;

export function resolveGrokFallbackBinary(downloadsDir: string): string | null {
  let entries: string[];
  try {
    entries = fs.readdirSync(downloadsDir);
  } catch {
    return null;
  }
  let best: { name: string; mtimeMs: number } | null = null;
  for (const entry of entries) {
    if (!entry.startsWith('grok-')) continue;
    const full = path.join(downloadsDir, entry);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(full);
    } catch {
      continue;
    }
    if (!stat.isFile() || stat.size < MIN_GROK_BINARY_BYTES) continue;
    if (!best || stat.mtimeMs > best.mtimeMs) best = { name: entry, mtimeMs: stat.mtimeMs };
  }
  return best ? path.join(downloadsDir, best.name) : null;
}

export function resolveGrokCurrentBinary(grokHome: string): string | null {
  try {
    const target = fs.realpathSync(path.join(grokHome, 'bin', 'grok'));
    const stat = fs.statSync(target);
    if (!stat.isFile() || stat.size < MIN_GROK_BINARY_BYTES) return null;
    fs.accessSync(target, fs.constants.X_OK);
    return target;
  } catch {
    return null;
  }
}

export function getBinaryPath(agent: AgentId, version: string): string {
  const agentConfig = AGENTS[agent];
  if (agent === 'grok') {
    const current = resolveGrokCurrentBinary(path.join(getVersionHomePath(agent, version), '.grok'));
    if (current) return current;
    const grokDownloads = path.join(getVersionHomePath(agent, version), '.grok', 'downloads');
    const releaseVersion = readInstallation(agent, version)?.releaseVersion ?? version;
    try {
      const entries = fs.readdirSync(grokDownloads);
      const match = entries.find((e: string) => e.includes(releaseVersion) && e.startsWith('grok-'));
      if (match) return path.join(grokDownloads, match);
    } catch {}
    const fallback = resolveGrokFallbackBinary(grokDownloads);
    if (fallback) return fallback;
    return path.join(grokDownloads, `grok-${releaseVersion}`);
  }
  if (agent === 'droid') {
    return IS_WINDOWS
      ? path.join(getHomeDir(), 'bin', 'droid.exe')
      : path.join(getHomeDir(), '.local', 'bin', 'droid');
  }
  if (agent === 'muse') {
    return IS_WINDOWS
      ? path.join(getHomeDir(), 'bin', 'muse.exe')
      : path.join(getHomeDir(), '.local', 'bin', 'muse');
  }
  if (agent === 'warp') {
    const onPath = findInPath('warp');
    if (onPath) return onPath;
    return IS_WINDOWS
      ? path.join(getHomeDir(), 'bin', 'warp.exe')
      : path.join(getHomeDir(), '.local', 'bin', 'warp');
  }
  const versionDir = getVersionDir(agent, version);
  return path.join(versionDir, 'node_modules', '.bin', agentConfig.cliCommand);
}

export function isGlobalBinaryAgent(agent: AgentId): boolean {
  // Only identical paths across two labels prove a global binary; per-home binaries stay isolated.
  return getBinaryPath(agent, '0.0.0-probe-a') === getBinaryPath(agent, '0.0.0-probe-b');
}

const LIVE_VERSION_TTL_MS = 5000;
const liveVersionCache = new Map<AgentId, { at: number; version: string | null }>();

export function invalidateLiveVersionCache(agent?: AgentId): void {
  if (agent) liveVersionCache.delete(agent);
  else liveVersionCache.clear();
}

export async function getCliVersionFromPath(agent: AgentId): Promise<string | null> {
  const agentConfig = AGENTS[agent];
  try {
    const { stdout } = await execFileAsync(agentConfig.cliCommand, ['--version'], { timeout: 3000, shell: process.platform === 'win32' });
    const match = stdout.match(/(\d+\.\d+\.\d+)/);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

export async function getLiveVersion(agent: AgentId): Promise<string | null> {
  const cached = liveVersionCache.get(agent);
  if (cached && Date.now() - cached.at < LIVE_VERSION_TTL_MS) return cached.version;
  const version = await getCliVersionFromPath(agent);
  liveVersionCache.set(agent, { at: Date.now(), version });
  return version;
}

export function getCachedLiveVersion(agent: AgentId): string | null {
  const cached = liveVersionCache.get(agent);
  if (cached && Date.now() - cached.at < LIVE_VERSION_TTL_MS) return cached.version;
  return null;
}

export function getVersionHomePath(agent: AgentId, version: string): string {
  return path.join(getVersionDir(agent, version), 'home');
}

function getPackageBinaryPath(agent: AgentId, version: string): string | null {
  const agentConfig = AGENTS[agent];
  if (!agentConfig.npmPackage) return null;
  const pkgRoot = path.join(getVersionDir(agent, version), 'node_modules', agentConfig.npmPackage);
  let bin: unknown;
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(pkgRoot, 'package.json'), 'utf-8'));
    bin = pkg.bin;
  } catch {
    return null;
  }
  let rel: string | undefined;
  if (typeof bin === 'string') {
    rel = bin;
  } else if (bin && typeof bin === 'object') {
    const map = bin as Record<string, string>;
    rel = map[agentConfig.cliCommand] ?? Object.values(map)[0];
  }
  if (!rel || typeof rel !== 'string') return null;
  return path.join(pkgRoot, rel);
}

export function isVersionInstalled(agent: AgentId, version: string): boolean {
  const packageBinary = getPackageBinaryPath(agent, version);
  if (packageBinary !== null) return fs.existsSync(packageBinary);
  return fs.existsSync(getBinaryPath(agent, version));
}

const installedVersionsCache = new Map<AgentId, { stamp: number; versions: string[] }>();

export function invalidateInstalledVersionsCache(agent?: AgentId): void {
  if (agent) installedVersionsCache.delete(agent);
  else installedVersionsCache.clear();
}

export function pickCanonicalGlobalBinaryVersion(agent: AgentId, versions: string[]): string {
  const symlinkVersion = getConfigSymlinkVersion(agent);
  if (symlinkVersion && versions.includes(symlinkVersion)) return symlinkVersion;
  const globalDefault = getGlobalDefault(agent);
  if (globalDefault && versions.includes(globalDefault)) return globalDefault;
  const live = getCachedLiveVersion(agent);
  if (live && versions.includes(live)) return live;
  return versions[versions.length - 1];
}

function collapseGlobalBinaryVersions(agent: AgentId, versions: string[]): string[] {
  if (!isGlobalBinaryAgent(agent) || versions.length === 0) return versions;
  return [pickCanonicalGlobalBinaryVersion(agent, versions)];
}

export function listInstalledVersions(agent: AgentId): string[] {
  const agentVersionsDir = path.join(getVersionsDir(), agent);
  let stamp: number;
  try {
    stamp = fs.statSync(agentVersionsDir).mtimeMs;
  } catch {
    installedVersionsCache.set(agent, { stamp: 0, versions: [] });
    return [];
  }

  const cached = installedVersionsCache.get(agent);
  if (cached && cached.stamp === stamp) {
    return collapseGlobalBinaryVersions(agent, cached.versions);
  }

  const entries = fs.readdirSync(agentVersionsDir, { withFileTypes: true });
  const versions: string[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (isVersionInstalled(agent, entry.name)) {
      versions.push(entry.name);
    }
  }

  versions.sort(compareVersions);
  installedVersionsCache.set(agent, { stamp, versions });
  return collapseGlobalBinaryVersions(agent, versions);
}

export function getGlobalDefault(agent: AgentId): string | null {
  const meta = readMeta();
  return meta.agents?.[agent] || null;
}

export function getIsolatedDefault(agent: AgentId): string | null {
  const meta = readMeta();
  return meta.isolatedAgents?.[agent] || null;
}

function getIsolatedMarkerPath(agent: AgentId, version: string): string {
  return path.join(getVersionDir(agent, version), '.isolated');
}

export function markVersionIsolated(agent: AgentId, version: string): void {
  fs.writeFileSync(getIsolatedMarkerPath(agent, version), `${new Date().toISOString()}\n`, { mode: 0o600 });
}

export function isVersionIsolated(agent: AgentId, version: string): boolean {
  return fs.existsSync(getIsolatedMarkerPath(agent, version));
}

export function getProjectVersion(agent: AgentId, startPath: string): string | null {
  const userAgentsYaml = path.join(getUserAgentsDir(), 'agents.yaml');
  let dir = path.resolve(startPath);

  while (dir !== path.dirname(dir)) {
    const manifestPath = path.join(dir, 'agents.yaml');
    if (manifestPath !== userAgentsYaml && fs.existsSync(manifestPath)) {
      try {
        const content = fs.readFileSync(manifestPath, 'utf-8');
        const parsed = yaml.parse(content);
        const version = parsed?.agents?.[agent];
        if (typeof version === 'string' && version.trim()) {
          const normalized = version.trim();
          if (!VERSION_RE.test(normalized)) {
            throw new Error(`Invalid version in agents.yaml for ${agent}: ${normalized}. Allowed: latest or [A-Za-z0-9._+-]{1,64}`);
          }
          return normalized;
        }
      } catch (err) {
        if (err instanceof Error && err.message.startsWith('Invalid version in agents.yaml')) {
          throw err;
        }
      }
    }
    dir = path.dirname(dir);
  }

  return null;
}

export function resolveVersion(agent: AgentId, projectPath?: string): string | null {
  if (projectPath) {
    const version = getProjectVersion(agent, projectPath);
    if (version) {
      return version;
    }
  }

  const globalDefault = getGlobalDefault(agent);
  if (globalDefault) return globalDefault;

  const isolated = getIsolatedDefault(agent);
  if (isolated && isVersionInstalled(agent, isolated) && isVersionIsolated(agent, isolated)) {
    return isolated;
  }
  return null;
}

export function getEffectiveHome(agentId: AgentId): string {
  const resolved = resolveVersion(agentId, process.cwd());
  if (resolved && isVersionInstalled(agentId, resolved)) {
    return getVersionHomePath(agentId, resolved);
  }
  return getHomeDir();
}
