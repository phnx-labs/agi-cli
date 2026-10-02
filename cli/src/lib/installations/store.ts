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

/**
 * Persistence for {@link Installation} records.
 *
 * The record lives at `<versionDir>/installation.json` rather than in one
 * central index: the version dir is what `agents trash`/`agents prune` move,
 * copy and restore wholesale, so keeping identity inside it means identity
 * travels with the install instead of dangling in a registry that forgets to
 * follow. It is also why the file name is registered in versions.ts's
 * `PRESERVED_ON_CLEAN_REINSTALL` — a repair reinstall must not mint a new id.
 *
 * Path/enumeration plus frozen installation records. Depends on Node builtins,
 * installations-local modules, and base lib (`state`/`fs-atomic`/`primitives`/
 * `agents`/`shims`/`platform`) — never `plugins/`, `rules/`, `session/`, or
 * `devices/`, so those modules can import this file without an import cycle.
 */

/** Directory holding one installation. Same path as {@link getVersionDir}. */
export function installationDir(agent: AgentId, label: string): string {
  return path.join(getVersionsDir(), agent, label);
}

export function installationRecordPath(agent: AgentId, label: string): string {
  return path.join(installationDir(agent, label), INSTALLATION_RECORD_FILE);
}

/** Mint an opaque installation id. Random, never derived from the release. */
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

/**
 * Read the record for one installation, or null when the version dir has none.
 * Never mints — use {@link ensureInstallation} for the migrating read.
 */
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

/** Semantic feature checks use the release, while paths and settings keep the label. */
export function installedReleaseFor(agent: AgentId, label: string): string {
  if (!Object.hasOwn(AGENTS, agent) || !VERSION_RE.test(label)) return label;
  return readInstallation(agent, label)?.releaseVersion ?? label;
}

export function writeInstallation(installation: Installation): void {
  const file = installationRecordPath(installation.agent, installation.label);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  atomicWriteFileSync(file, `${JSON.stringify(installation, null, 2)}\n`);
}

/**
 * Read the record for an existing version dir, minting and persisting one on
 * first sight. This is the migration path for every installation created before
 * frozen identity existed: their directory name IS their release, so the
 * migrated record seeds `label === releaseVersion` and dates the install from
 * the directory's own mtime rather than pretending it was created now.
 *
 * Throws when the version dir does not exist — an installation record must never
 * describe an install that isn't there.
 */
export function ensureInstallation(agent: AgentId, label: string): Installation {
  const existing = readInstallation(agent, label);
  if (existing) return existing;
  if (!fs.existsSync(installationDir(agent, label))) throw new Error(`No installation directory for ${agent}@${label}.`);
  const createdAt = fs.statSync(installationDir(agent, label)).mtime.toISOString();
  return withFileLock(installationLockTarget(agent, label),
    () => ensureInstallationLocked(agent, label, createdAt),
    { ...INSTALLATION_LOCK_OPTIONS, acquireTimeoutMs: 0 });
}

/** Migration for callers already holding the canonical installation lock. */
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

/**
 * Create the record for a freshly-installed version dir. Idempotent: a repeat
 * `agents add` of the same label keeps the original id (identity is frozen) and
 * only records the release if it actually moved.
 */
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

/**
 * Move an installation's recorded release forward, preserving identity. Returns
 * the persisted record. Call only AFTER the new release is live on disk — the
 * record is the claim that it is.
 */
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

/** Version-dir basenames present for an agent, oldest-first by directory name. */
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

/**
 * Every installation of an agent, migrating records as needed. A version dir
 * that disappears mid-scan is skipped rather than failing the whole listing.
 */
export function listInstallations(agent: AgentId): Installation[] {
  const out: Installation[] = [];
  for (const label of listInstallationLabels(agent)) {
    try {
      out.push(ensureInstallation(agent, label));
    } catch {
      /* dir vanished or unreadable — not an installation we can act on */
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

/**
 * Resolve the ONE managed installation of a harness, or null when the harness
 * has no managed install yet. The winner is deterministic: the `main` label
 * first, then the recorded global default (the install the user actually
 * launches), then the first remaining non-isolated installation by label.
 * Isolated copies (`agents add --isolated`) never count — they are expert
 * second homes, not the managed install.
 */
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
  /** True when this call installed the harness just now; false when the managed installation already existed and was reused unchanged. */
  installed: boolean;
}

/**
 * The taught entry point for "make this harness runnable" (PHNX-3940): return
 * the harness's single managed installation, installing the current release
 * into the `main` label when the harness is not installed yet. `release` pins
 * the fresh install to a concrete release (recorded as a pinned update policy
 * by `installVersion`); it has no effect when an installation already exists —
 * moving an existing install is `agents update <agent> --to <release>`'s job.
 *
 * Throws (fail loud) when the install fails; never returns a half-installed
 * record.
 */
export async function ensureHarnessInstallation(
  agent: AgentId,
  opts: { release?: string; onProgress?: (message: string) => void } = {},
): Promise<EnsureHarnessInstallationResult> {
  const existing = resolveManagedInstallation(agent);
  if (existing) return { installation: existing, installed: false };
  const release = opts.release ?? 'latest';
  // installVersion lives in ./versions.js, which imports this file. A dynamic
  // import keeps the static module graph acyclic (see the docblock at the top
  // of this file) while the call itself runs after both modules are loaded.
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

/**
 * Get the directory where a specific version is installed.
 */
export function getVersionDir(agent: AgentId, version: string): string {
  return path.join(getVersionsDir(), agent, version);
}

/**
 * Grok binaries are never trusted below this size when picking among several
 * `grok-*` candidates with no exact version match (see
 * {@link resolveGrokFallbackBinary}). Grok's real native binary is ~100MB+; a
 * stray non-binary artifact sharing the `grok-*` naming pattern (a wrapper or
 * alias script) is at most a few hundred bytes, so 1MB comfortably separates
 * the two without depending on file content.
 */
const MIN_GROK_BINARY_BYTES = 1_000_000;

/**
 * Pick the real grok binary among `grok-*` entries in `downloadsDir` when NO
 * filename carries the pinned version string. Grok self-updates its binary in
 * place while running under the shim, so a version-home's downloads dir can
 * accumulate several `grok-*` files whose names have drifted away from that
 * version-home's pinned version (RUSH-2459: on yosemite-s0, version-home
 * `0.2.82` held `grok-1.0.0-linux-aarch64` after grok self-updated, plus a
 * stale, unrelated 99-byte `grok-0.2.118-linux-aarch64` wrapper script that
 * happened to sort alphabetically first).
 *
 * Never blindly take whatever `fs.readdirSync` returns first — that is exactly
 * the bug this replaces. Instead: exclude anything under
 * {@link MIN_GROK_BINARY_BYTES} (rejects wrapper/alias artifacts on size
 * alone, no content sniffing needed) and, among the survivors, prefer the most
 * recently modified — the file grok's self-updater actually wrote last.
 * Returns null (fail loud, never guess) when nothing survives the size filter.
 */
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

/**
 * Grok's own current-release pointer, `<grokHome>/bin/grok`, resolved to the
 * real binary, or null when absent or not a real binary. Grok's updater keeps
 * it current in both of its layouts (`bin/grok -> ../downloads/grok-<v>-<arch>`
 * and the newer `bin/grok -> grok-<v>`, which never touches downloads/), so it
 * is the only location that tracks `grok update`. Mirrors the shim's
 * `_resolve_grok_current`.
 */
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

/**
 * Get the binary path for a specific agent version.
 */
export function getBinaryPath(agent: AgentId, version: string): string {
  const agentConfig = AGENTS[agent];
  if (agent === 'grok') {
    const current = resolveGrokCurrentBinary(path.join(getVersionHomePath(agent, version), '.grok'));
    if (current) return current;
    const grokDownloads = path.join(getVersionHomePath(agent, version), '.grok', 'downloads');
    // The directory token is the stable installation/account label. A
    // self-updating slot may carry a newer vendor release, whose binary keeps
    // the release in its filename; resolve through the frozen install record.
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
    // Factory.ai's installer drops a standalone native binary (no npm package,
    // nothing in node_modules/.bin). The binary is global, not per-version —
    // config isolation rides the ~/.factory symlink switch, not a separate
    // binary per version. Install location is platform-specific:
    //   macOS/Linux: ~/.local/bin/droid       (curl app.factory.ai/cli | sh)
    //   Windows:     %USERPROFILE%\bin\droid.exe  (irm app.factory.ai/cli/windows | iex)
    // Mirror the shim's `droid` branch so isVersionInstalled/`agents view`
    // agree with what actually executes.
    return IS_WINDOWS
      ? path.join(getHomeDir(), 'bin', 'droid.exe')
      : path.join(getHomeDir(), '.local', 'bin', 'droid');
  }
  if (agent === 'muse') {
    // Muse Code install script drops a self-updating launcher at
    // ~/.local/bin/muse (curl -fsSL https://dev.meta.ai/install.sh | sh).
    // Same global-binary shape as droid: one binary for every version dir,
    // config isolation via version-home HOME rewrite. Mirror the shim's
    // `muse` branch so isVersionInstalled / agents view / agents import
    // agree with what executes.
    return IS_WINDOWS
      ? path.join(getHomeDir(), 'bin', 'muse.exe')
      : path.join(getHomeDir(), '.local', 'bin', 'muse');
  }
  if (agent === 'warp') {
    // Warp Agent CLI installs a single global, self-updating `warp` binary at
    // ~/.local/bin/warp via the curl installer (Windows: the agent-cli.ps1) —
    // like droid/muse. Resolve the real binary on PATH (findInPath skips our own
    // shims dir) so isVersionInstalled / agents view agree with what executes.
    // When warp is not installed, fall back to its default install path so
    // isVersionInstalled reports uninstalled honestly.
    const onPath = findInPath('warp');
    if (onPath) return onPath;
    return IS_WINDOWS
      ? path.join(getHomeDir(), 'bin', 'warp.exe')
      : path.join(getHomeDir(), '.local', 'bin', 'warp');
  }
  const versionDir = getVersionDir(agent, version);
  return path.join(versionDir, 'node_modules', '.bin', agentConfig.cliCommand);
}

/**
 * Does this agent resolve to ONE global binary that is the same file regardless
 * of the `version` argument? (droid → always `~/.local/bin/droid`.) Computed
 * generically by probing `getBinaryPath` with two distinct versions rather than
 * hardcoding an agent id, so it stays correct if another global-binary agent is
 * added.
 *
 * This is the narrower cousin of `isSelfUpdatingAgent`: every global-binary
 * agent is self-updating, but grok is self-updating WITHOUT a global binary — it
 * stores a real per-version binary copy under each version-home
 * (`versions/grok/<v>/home/.grok/downloads/grok-<v>`), so its version-homes are
 * genuinely distinct and must NOT be collapsed. Gate the single-binary
 * collapse/live-version logic on THIS predicate; gate pin-refusal / "switch
 * profile" copy on `isSelfUpdatingAgent`.
 */
export function isGlobalBinaryAgent(agent: AgentId): boolean {
  return getBinaryPath(agent, '0.0.0-probe-a') === getBinaryPath(agent, '0.0.0-probe-b');
}

// Live-version cache for self-updating global binaries. `<cli> --version` is a
// ~real shell-out, so hold the result briefly: the same `agents view` render
// asks for it from both listInstalledVersions (sync) and the label path (async).
const LIVE_VERSION_TTL_MS = 5000;
const liveVersionCache = new Map<AgentId, { at: number; version: string | null }>();

/** Drop the live-version cache (call after an install/remove that changes the
 * running binary, e.g. `agents add droid@latest`). */
export function invalidateLiveVersionCache(agent?: AgentId): void {
  if (agent) liveVersionCache.delete(agent);
  else liveVersionCache.clear();
}

/**
 * Resolve the version the ONE globally-installed binary actually reports via
 * `<cli> --version`, cached for {@link LIVE_VERSION_TTL_MS}. For a self-updating
 * global-binary agent (droid) this is the single source of truth for "which
 * version is installed" — the on-disk version-dir NAMES are just stale labels
 * left behind by successive `agents add`/self-update cycles. Returns null when
 * the binary isn't on PATH or the probe fails.
 */
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

/**
 * Synchronous, non-blocking read of the live-version cache — returns the value
 * only if a recent {@link getLiveVersion} call already warmed it, else null.
 * `listInstalledVersions` is sync and must not shell out, so it prefers this
 * warm value (accurate) and otherwise falls back to the newest on-disk dir.
 */
export function getCachedLiveVersion(agent: AgentId): string | null {
  const cached = liveVersionCache.get(agent);
  if (cached && Date.now() - cached.at < LIVE_VERSION_TTL_MS) return cached.version;
  return null;
}

/**
 * Get the isolated HOME directory for a specific agent version.
 * Each version has its own config isolation (like jobs sandbox).
 */
export function getVersionHomePath(agent: AgentId, version: string): string {
  return path.join(getVersionDir(agent, version), 'home');
}

/**
 * Resolve the REAL launch binary for an npm-package agent version: the file the
 * installed package's `bin` entry points to — e.g.
 * node_modules/@anthropic-ai/claude-code/bin/claude.exe on Windows. This is the
 * executable that the node_modules/.bin/<cli>.cmd wrapper ultimately execs (and
 * what `agents run` spawns), NOT the wrapper itself.
 *
 * The distinction is load-bearing: npm leaves the tiny node_modules/.bin/<cli>
 * and <cli>.cmd wrappers in place even after a vendor auto-updater destroys the
 * multi-hundred-MB real binary the wrapper points at. Keying "installed" on the
 * wrapper (getBinaryPath) — or on the version dir — therefore reports a gutted
 * install as healthy, and `agents run` then dies at spawn with
 * "'...claude.exe' is not recognized".
 *
 * Returns null for agents without an npm package (grok/droid/installScript,
 * whose getBinaryPath already resolves the real per-host binary) or when the
 * installed package.json can't be read/parsed — callers fall back to the
 * generic getBinaryPath check in those cases.
 */
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
    // Prefer the entry named after our launch command; else the first bin.
    rel = map[agentConfig.cliCommand] ?? Object.values(map)[0];
  }
  if (!rel || typeof rel !== 'string') return null;
  return path.join(pkgRoot, rel);
}

/**
 * Check if a specific version is installed.
 *
 * Probes the actual launch binary (the same executable the shims run), not just
 * the version dir or the node_modules/.bin/<cli> wrapper. For npm agents that
 * means statting the package's real `bin` target (getPackageBinaryPath), so a
 * present-but-gutted install (vendor auto-updater destroyed the binary) reports
 * as NOT installed and `agents add` re-runs its install step to repair it.
 */
export function isVersionInstalled(agent: AgentId, version: string): boolean {
  const packageBinary = getPackageBinaryPath(agent, version);
  if (packageBinary !== null) return fs.existsSync(packageBinary);
  return fs.existsSync(getBinaryPath(agent, version));
}

// Per-process cache for listInstalledVersions. The agent's versions dir mtime
// changes whenever a version dir is added or removed (install/remove), so a
// stamp match means the installed set is unchanged and we skip the readdir +
// N binary stats. Mirrors the readMeta() cache in state.ts. Hot path:
// resolveAgentTargets and every enumerate-style consumer hit this.
const installedVersionsCache = new Map<AgentId, { stamp: number; versions: string[] }>();

/** Drop the installed-versions cache (call after install/remove mutations). */
export function invalidateInstalledVersionsCache(agent?: AgentId): void {
  if (agent) installedVersionsCache.delete(agent);
  else installedVersionsCache.clear();
}

/**
 * Choose the single canonical version-dir to represent a self-updating
 * global-binary agent (droid). All its version dirs map to ONE binary, so
 * exactly one is real; the rest are stale labels. Prefer, in order: the dir the
 * live config symlink points at (what actually runs), the recorded global
 * default, the live `--version` (when the cache is warm), else the newest dir.
 * `versions` MUST be sorted ascending. Callers guarantee it is non-empty.
 */
export function pickCanonicalGlobalBinaryVersion(agent: AgentId, versions: string[]): string {
  const symlinkVersion = getConfigSymlinkVersion(agent);
  if (symlinkVersion && versions.includes(symlinkVersion)) return symlinkVersion;
  const globalDefault = getGlobalDefault(agent);
  if (globalDefault && versions.includes(globalDefault)) return globalDefault;
  const live = getCachedLiveVersion(agent);
  if (live && versions.includes(live)) return live;
  return versions[versions.length - 1];
}

/**
 * Collapse a global-binary agent's phantom version dirs to the single canonical
 * one (see {@link pickCanonicalGlobalBinaryVersion}). No-op for npm-packaged and
 * per-version agents (claude/codex/grok/…), whose version dirs are genuinely
 * distinct installs.
 */
function collapseGlobalBinaryVersions(agent: AgentId, versions: string[]): string[] {
  if (!isGlobalBinaryAgent(agent) || versions.length === 0) return versions;
  return [pickCanonicalGlobalBinaryVersion(agent, versions)];
}

/**
 * List all installed versions for an agent (cached by versions-dir mtime).
 *
 * For a self-updating global-binary agent (droid) every version dir resolves to
 * the SAME binary, so this collapses them to a single canonical entry — one
 * install, one row in `agents view`, never the phantom set of semver dir names.
 *
 * A directory is an installation only when it has a working launch binary.
 * Account credential slots (PHNX-3940, `~/.agents/.history/accounts/**`) are
 * HOME-shaped dirs with no binary and no `installation.json`, so they can
 * never appear here. Record-less pre-frozen installs are reported as-is; their
 * migration belongs to the record-based paths (`listInstallations`), never to
 * this read surface.
 */
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
    // Collapse is applied per-call (not cached): it depends on the live-version
    // cache + config symlink, which can change without the versions-dir mtime.
    return collapseGlobalBinaryVersions(agent, cached.versions);
  }

  const entries = fs.readdirSync(agentVersionsDir, { withFileTypes: true });
  const versions: string[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    // Probe the real launch binary (isVersionInstalled), not just the
    // node_modules/.bin wrapper — a gutted install must not count as healthy
    // in the balanced account/version picker. A dir with no working binary
    // (a slot, a partial download) is not an installation at all. Read-only:
    // `agents view` enumerates through here and must leave every version home
    // byte-identical (issue #2058), so a record-less pre-frozen install is
    // reported as-is — its migration belongs to the record-based paths
    // (listInstallations), never to a read surface.
    if (isVersionInstalled(agent, entry.name)) {
      versions.push(entry.name);
    }
  }

  versions.sort(compareVersions);
  installedVersionsCache.set(agent, { stamp, versions });
  return collapseGlobalBinaryVersions(agent, versions);
}

/**
 * Get the global default version for an agent.
 */
export function getGlobalDefault(agent: AgentId): string | null {
  const meta = readMeta();
  return meta.agents?.[agent] || null;
}

/**
 * Get the preferred ISOLATED version for an agent — the copy a bare
 * `agents run <agent>` falls back to when there is no global default.
 */
export function getIsolatedDefault(agent: AgentId): string | null {
  const meta = readMeta();
  return meta.isolatedAgents?.[agent] || null;
}

/**
 * Path to the sentinel file that marks a version as an isolated install.
 *
 * It lives at the version-dir root (a sibling of `home/`), so it is carried
 * along when `softDeleteVersionDir` moves the whole directory to trash and is
 * restored intact by `agents restore`. Its mere presence is the marker;
 * the contents are an informational timestamp only.
 */
function getIsolatedMarkerPath(agent: AgentId, version: string): string {
  return path.join(getVersionDir(agent, version), '.isolated');
}

/**
 * Mark an installed version as an isolated install (`agents add --isolated`).
 *
 * Isolated versions are fully self-contained: they never become the global
 * default and never own the user's real `~/.<agent>` config directory. This
 * flag is what keeps every "adopting" code path away from them.
 */
export function markVersionIsolated(agent: AgentId, version: string): void {
  fs.writeFileSync(getIsolatedMarkerPath(agent, version), `${new Date().toISOString()}\n`, { mode: 0o600 });
}

/**
 * Whether a version was installed as an isolated install (`agents add --isolated`).
 *
 * Used to exclude such versions from global-default promotion and from any
 * flow that would touch the user's real `~/.<agent>` directory, and to gate the
 * `--isolated` safety check on `agents remove`.
 */
export function isVersionIsolated(agent: AgentId, version: string): boolean {
  return fs.existsSync(getIsolatedMarkerPath(agent, version));
}

/**
 * Get version specified in a project-root agents.yaml (not the user ~/.agents/.system/agents.yaml).
 */
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
        // Ignore parsing errors
      }
    }
    dir = path.dirname(dir);
  }

  return null;
}

/**
 * Get the resolved version for an agent in the current context.
 * Checks project manifest first, then global default.
 */
export function resolveVersion(agent: AgentId, projectPath?: string): string | null {
  // Check project manifest
  if (projectPath) {
    const version = getProjectVersion(agent, projectPath);
    if (version) {
      return version;
    }
  }

  // Fall back to global default
  const globalDefault = getGlobalDefault(agent);
  if (globalDefault) return globalDefault;

  // Last resort: the preferred isolated copy. Strictly a fallback — a global
  // default always wins, so nothing changes for anyone who has one. Without this,
  // an isolated-only user cannot reach their installs by bare name at all: the
  // resolution chain ended here, so `agents run codex` fell through to whatever
  // `codex` meant on PATH, and only `agents run codex@<version>` worked.
  //
  // The pointer is verified on read. It survives in agents.yaml across a trash +
  // restore cycle, but a version removed for good would otherwise leave a dangling
  // pin that resolves to a directory that is not there.
  const isolated = getIsolatedDefault(agent);
  if (isolated && isVersionInstalled(agent, isolated) && isVersionIsolated(agent, isolated)) {
    return isolated;
  }
  return null;
}

/**
 * Get the effective HOME directory for an agent.
 * If version-managed with a resolved version, returns the version's home directory.
 * Otherwise returns the real HOME.
 */
export function getEffectiveHome(agentId: AgentId): string {
  const resolved = resolveVersion(agentId, process.cwd());
  if (resolved && isVersionInstalled(agentId, resolved)) {
    return getVersionHomePath(agentId, resolved);
  }
  return getHomeDir();
}
