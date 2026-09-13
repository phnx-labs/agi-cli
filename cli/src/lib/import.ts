/**
 * Import existing unmanaged agent installations into agents-cli.
 *
 * Two flavors:
 *
 *  1. Config-only import — moves an agent's config dir (e.g. ~/.openclaw)
 *     into the version structure and symlinks it back. Used by `agents setup`
 *     on first-run when an agent was previously installed via npm/homebrew.
 *
 *  2. Full import — also registers an existing binary install (e.g. a global
 *     `npm i -g openclaw`) under the managed version path so the shim
 *     resolver can find it. This is what `agents import <agent>` does.
 *
 * The binary side never moves files. It creates a thin symlink farm under
 * `~/.agents/.history/versions/<agent>/<version>/` pointing at the original
 * global install, plus a package.json marker so `isVersionInstalled` returns
 * true.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { AgentId } from './types.js';
import { AGENTS, resolveNativeBinaryPath } from './agents.js';
import { getUserAgentsDir, getVersionsDir } from './state.js';
import { setGlobalDefault } from './installations/versions.js';
import { createShim, createVersionedAlias, ensureShimCurrent, switchHomeFileSymlinks, assertIsolationBoundary } from './installations/shims.js';

interface ImportConfigResult {
  success: boolean;
  skipped?: boolean;
  error?: string;
}

interface ImportBinaryResult {
  success: boolean;
  skipped?: boolean;
  error?: string;
  resolvedFromPath?: string;
}

const IMPORT_VERSION_RE = /^(?:latest|[A-Za-z0-9._+-]{1,64})$/;

export function isValidImportVersion(version: string): boolean {
  return IMPORT_VERSION_RE.test(version);
}

/**
 * Move an agent's config dir into the managed version structure and symlink it
 * back to its original location. Sets the imported version as the global
 * default and refreshes the shim so the user's PATH lookup hits the managed
 * version.
 *
 * No-op (returns skipped=true) if the version's config dir is already created.
 */
export async function importAgentConfig(
  agentId: AgentId,
  version: string
): Promise<ImportConfigResult> {
  if (!isValidImportVersion(version)) {
    return { success: false, error: `Invalid version: ${JSON.stringify(version)}` };
  }

  // Adoption, done inline rather than via switchConfigSymlink — so it needs the gate
  // directly. commands/import.ts checks at its entry point too (it must: it registers
  // a normal version first, which would un-protect the agent before this runs), but
  // an exported function that moves the user's real config must not depend on every
  // future caller remembering.
  assertIsolationBoundary(agentId, 'adopt your existing install');
  const agent = AGENTS[agentId];
  const configDir = agent.configDir;
  const versionsDir = getVersionsDir();
  const versionHome = path.join(versionsDir, agentId, version, 'home');
  // Match the shim's derivation in generateShimScript: the per-version config
  // path mirrors the original configDir's path relative to $HOME. Hardcoding
  // `.${agentId}` broke for nested configDirs like Antigravity
  // (`~/.gemini/antigravity-cli`) — the destination would be `.antigravity`,
  // mismatching the shim's expectation of `.gemini/antigravity-cli`.
  const versionConfigDir = path.join(versionHome, path.relative(os.homedir(), configDir));

  if (fs.existsSync(versionConfigDir)) {
    return { success: false, skipped: true, error: `${version} already installed` };
  }

  try {
    fs.mkdirSync(path.dirname(versionConfigDir), { recursive: true });
    fs.renameSync(configDir, versionConfigDir);
    fs.symlinkSync(versionConfigDir, configDir);
    setGlobalDefault(agentId, version);
    switchHomeFileSymlinks(agentId, version);
    ensureShimCurrent(agentId);
    return { success: true };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
}

/**
 * Wire an imported version into the rest of the system so it behaves the same
 * as a freshly installed version:
 *
 *   - registered as the global default in agents.yaml (so `agents view`
 *     reports it correctly and resolvers find it),
 *   - main shim refreshed (`~/.agents/.cache/shims/<cli>`),
 *   - versioned alias created (`~/.agents/.cache/shims/<cli>@<version>`),
 *   - home-file symlinks (CLAUDE.md / AGENTS.md / etc.) repointed at this
 *     version's home dir.
 *
 * Without this, the binary-only import path would leave the version stranded:
 * isVersionInstalled returns true, but the resolver never picks it. Safe to
 * call multiple times — each underlying function is idempotent.
 */
export function finalizeImport(agentId: AgentId, version: string): void {
  setGlobalDefault(agentId, version);
  createShim(agentId);
  createVersionedAlias(agentId, version);
  switchHomeFileSymlinks(agentId, version);
  ensureShimCurrent(agentId);
}

/**
 * Agent metadata needed by importAgentBinary. Taking these as explicit
 * inputs (rather than looking up AGENTS internally) decouples the symlink
 * farm from the AGENTS registry, which keeps the function pure and avoids
 * fragile coupling in test setups that stub `lib/agents.ts`.
 */
interface AgentBinarySpec {
  /** Agent id used in the marker package.json (`agents-{agentId}-{version}`). */
  agentId: string;
  /** npm package name (e.g. `openclaw`) — used as the `node_modules/<name>` dir. */
  npmPackage: string;
  /** Binary name on PATH (e.g. `openclaw`) — used as the `.bin/<name>` entry. */
  cliCommand: string;
}

/**
 * Register an existing global npm package install under the managed version
 * path so the shim resolver finds it.
 *
 * Layout produced (everything is a symlink, nothing is copied):
 *
 *   {versionDir}/
 *     package.json                          # marker so isVersionInstalled() is true
 *     home/                                 # empty isolated $HOME for this version
 *     node_modules/{npmPackage}    -> {globalPath}
 *     node_modules/.bin/{cliCommand} -> {binaryEntry}
 */
export function importAgentBinary(
  spec: AgentBinarySpec,
  version: string,
  globalPath: string,
  versionDir: string
): ImportBinaryResult {
  const binaryLink = path.join(versionDir, 'node_modules', '.bin', spec.cliCommand);

  // lstat — we want to detect the symlink itself, not follow it. fs.existsSync
  // can return false on dangling symlinks, which would incorrectly let us
  // proceed to symlinkSync below and throw EEXIST.
  let alreadyExists = false;
  try {
    fs.lstatSync(binaryLink);
    alreadyExists = true;
  } catch {
    /* not present */
  }
  if (alreadyExists) {
    return { success: false, skipped: true, error: `${version} already installed`, resolvedFromPath: globalPath };
  }

  if (!fs.existsSync(globalPath)) {
    return { success: false, error: `Path does not exist: ${globalPath}` };
  }

  const globalPkgJson = path.join(globalPath, 'package.json');
  if (!fs.existsSync(globalPkgJson)) {
    return { success: false, error: `Not an npm package (no package.json): ${globalPath}` };
  }

  let pkgBinEntry: string | undefined;
  try {
    const pkg = JSON.parse(fs.readFileSync(globalPkgJson, 'utf8'));
    if (typeof pkg.bin === 'string') {
      pkgBinEntry = pkg.bin;
    } else if (pkg.bin && typeof pkg.bin === 'object') {
      // Strict: only accept the exact cliCommand key. Multi-bin packages
      // (e.g. @anthropic-ai/claude-code ships several bins) would otherwise
      // silently get a wrong binary chosen by Object.values() ordering.
      pkgBinEntry = pkg.bin[spec.cliCommand];
    }
  } catch (err) {
    return { success: false, error: `Failed to read package.json: ${(err as Error).message}` };
  }

  if (!pkgBinEntry) {
    return { success: false, error: `package.json has no bin entry for "${spec.cliCommand}" — pass --from-path to a package that ships it` };
  }

  const binaryTarget = path.resolve(globalPath, pkgBinEntry);
  if (!fs.existsSync(binaryTarget)) {
    return { success: false, error: `Binary entry missing: ${binaryTarget}` };
  }

  try {
    fs.mkdirSync(path.join(versionDir, 'home'), { recursive: true });
    fs.mkdirSync(path.join(versionDir, 'node_modules', '.bin'), { recursive: true });

    fs.writeFileSync(
      path.join(versionDir, 'package.json'),
      JSON.stringify({ name: `agents-${spec.agentId}-${version}`, version: '1.0.0', private: true, imported: true, from: globalPath }, null, 2)
    );

    const pkgLink = path.join(versionDir, 'node_modules', spec.npmPackage);
    fs.mkdirSync(path.dirname(pkgLink), { recursive: true });
    if (!fs.existsSync(pkgLink)) {
      fs.symlinkSync(globalPath, pkgLink);
    }

    fs.symlinkSync(binaryTarget, binaryLink);

    return { success: true, resolvedFromPath: globalPath };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
}

/**
 * Register an existing installScript-based binary (Grok, Antigravity, Cursor,
 * etc. — anything with `npmPackage: ''` and a curl/brew installer) under the
 * managed version path. Unlike `importAgentBinary` this skips the npm
 * package.json walk and just symlinks the resolved PATH binary directly into
 * `{versionDir}/node_modules/.bin/{cliCommand}`. The symlink is what makes
 * `listInstalledVersions` consider the version Managed.
 *
 * Layout produced:
 *
 *   {versionDir}/
 *     package.json                              # marker (private, imported, from)
 *     home/                                     # empty isolated $HOME
 *     node_modules/.bin/{cliCommand} -> {binaryPath}
 *
 * For agents whose binary lookup is special-cased elsewhere (e.g. Grok's
 * `~/.grok/downloads/`), the symlink is still created — `getBinaryPath` won't
 * read it for those agents, but it documents provenance and lets a future
 * refactor consolidate the binary-resolution registry.
 */
export function importInstallScriptBinary(
  spec: AgentBinarySpec,
  version: string,
  binaryPath: string,
  versionDir: string
): ImportBinaryResult {
  const binaryLink = path.join(versionDir, 'node_modules', '.bin', spec.cliCommand);

  let alreadyExists = false;
  try {
    fs.lstatSync(binaryLink);
    alreadyExists = true;
  } catch {
    /* not present */
  }
  if (alreadyExists) {
    return { success: false, skipped: true, error: `${version} already installed`, resolvedFromPath: binaryPath };
  }

  const nativeBinary = resolveNativeBinaryPath(spec.cliCommand, binaryPath);
  if (!nativeBinary) {
    return { success: false, error: `Binary does not resolve to a native executable: ${binaryPath}` };
  }

  try {
    fs.mkdirSync(path.join(versionDir, 'home'), { recursive: true });
    fs.mkdirSync(path.join(versionDir, 'node_modules', '.bin'), { recursive: true });

    fs.writeFileSync(
      path.join(versionDir, 'package.json'),
      JSON.stringify(
        { name: `agents-${spec.agentId}-${version}`, version: '1.0.0', private: true, imported: true, from: nativeBinary, installScriptBased: true },
        null,
        2
      )
    );

    fs.symlinkSync(nativeBinary, binaryLink);

    return { success: true, resolvedFromPath: nativeBinary };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
}

/**
 * Resolve the on-disk npm package directory for an agent's CLI binary by
 * walking up from the binary, following any symlinks. Returns null if the
 * package can't be identified.
 *
 * Handles the homebrew/global-npm pattern where:
 *   /opt/homebrew/bin/{cli}  ->  ../lib/node_modules/{pkg}/dist/index.js
 */
export function resolvePackageDirFromBinary(binaryPath: string): string | null {
  try {
    let real = fs.realpathSync(binaryPath);
    let dir = path.dirname(real);

    // Walk up looking for the nearest package.json
    for (let i = 0; i < 6; i++) {
      const pkg = path.join(dir, 'package.json');
      if (fs.existsSync(pkg)) {
        return dir;
      }
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Seed an ISOLATED version's home from the user's real `~/.<agent>` — the mirror of
 * {@link importAgentConfig}, which adopts.
 *
 * The difference is the whole point: this COPIES and leaves the original in place,
 * never symlinks it, never sets a default, never creates a shim. So an isolated copy
 * can start from the setup the user already has instead of from nothing, which was
 * the only way to get a working sandbox before.
 *
 * Credentials are skipped by default and reported, not silently included. An isolated
 * copy is a separate principal — `agents add --isolated` already tells the user to
 * sign in on first run — and copying tokens into it should be a choice, not a side
 * effect of wanting your settings. `--with-auth` opts in.
 */
export function seedIsolatedConfigFromLocal(
  agentId: AgentId,
  version: string,
  opts: { withAuth?: boolean; all?: boolean } = {},
): { seeded: boolean; from: string; to: string; skippedAuth: string[]; skippedRuntime: string[]; error?: string } {
  const agent = AGENTS[agentId];
  const configDir = agent.configDir;
  const versionHome = path.join(getVersionsDir(), agentId, version, 'home');
  // Mirror importAgentConfig's derivation so nested config dirs (e.g. Antigravity's
  // ~/.gemini/antigravity-cli) land where the shim expects them.
  let dest = path.join(versionHome, path.relative(os.homedir(), configDir));
  // Codex uses a SUN_LEN-safe CODEX_HOME: `home/.codex` is a SYMLINK to
  // `~/.agents/.codex-homes/<version>/.codex`, because the real path is too long for a
  // unix socket. cpSync cannot overwrite a symlink with a directory (it fails with
  // "Cannot overwrite non-directory"), and writing beside it would put settings
  // somewhere the agent never reads. Follow the link and seed the actual home.
  try {
    if (fs.lstatSync(dest).isSymbolicLink()) dest = fs.realpathSync(dest);
  } catch {
    /* not created yet — the plain path is correct */
  }
  const result = { seeded: false, from: configDir, to: dest, skippedAuth: [] as string[], skippedRuntime: [] as string[] };

  if (!fs.existsSync(configDir)) return result;

  // Known credential paths, relative to the config dir. `authFiles` covers the agents
  // that declare them for cross-version carry; the rest are verified filenames for
  // agents that do not declare any (codex `auth.json`, claude `.credentials.json`).
  // Runtime state, not settings. Seeding a sandbox with the user's session history,
  // logs and caches duplicated 757MB on a real machine — 349MB of `sessions` alone —
  // for a copy that wants config. These are regenerated by the agent as it runs, and
  // an isolated copy keeps its own; carrying them over also drags conversation history
  // into a sandbox the user may have created precisely to keep separate.
  const RUNTIME_PREFIXES = ['sessions', 'log', 'logs', 'cache', '.tmp', 'tmp', 'generated_images'];
  const RUNTIME_FILES = ['history.jsonl', 'session_index.jsonl'];
  const isRuntime = (rel: string): boolean =>
    !opts.all && (
      RUNTIME_FILES.includes(rel) ||
      /\.sqlite(-shm|-wal)?$/.test(rel) ||
      RUNTIME_PREFIXES.some((d) => rel === d || rel.startsWith(d + path.sep))
    );

  const authRel = new Set<string>([
    ...(agent.authFiles ?? []),
    'auth.json',
    '.credentials.json',
    'credentials.json',
  ]);

  try {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const agentsDir = getUserAgentsDir();
    const inside = agentsDir + path.sep;
    fs.cpSync(configDir, dest, {
      recursive: true,
      // `force: true` is Node's default, but Bun drops it when a `filter` is supplied —
      // existing files are then silently left alone. `dist/bin/agents` is bun-compiled,
      // so this is a production path, not just a test artifact. State it explicitly.
      force: true,
      filter: (src) => {
        const rel = path.relative(configDir, src);
        if (!opts.withAuth && rel && (authRel.has(rel) || rel.startsWith('credentials' + path.sep))) {
          result.skippedAuth.push(rel);
          return false;
        }
        if (rel && isRuntime(rel)) {
          // Record only the top-level name so the report stays one line per item.
          const top = rel.split(path.sep)[0];
          if (!result.skippedRuntime.includes(top)) result.skippedRuntime.push(top);
          return false;
        }
        // Same rule as the export path: a link into ~/.agents would dangle for a copy
        // that is supposed to stand on its own.
        try {
          const st = fs.lstatSync(src);
          if (st.isSymbolicLink()) {
            const tgt = path.resolve(path.dirname(src), fs.readlinkSync(src));
            if (tgt === agentsDir || tgt.startsWith(inside)) return false;
          }
        } catch { /* let cpSync surface unreadable entries */ }
        return true;
      },
    });
    result.seeded = true;
  } catch (err) {
    return { ...result, error: (err as Error).message };
  }
  return result;
}
