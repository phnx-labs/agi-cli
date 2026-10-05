
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

export async function importAgentConfig(
  agentId: AgentId,
  version: string
): Promise<ImportConfigResult> {
  if (!isValidImportVersion(version)) {
    return { success: false, error: `Invalid version: ${JSON.stringify(version)}` };
  }

  // Import moves live config: enforce isolation and preserve its home-relative nested path.
  assertIsolationBoundary(agentId, 'adopt your existing install');
  const agent = AGENTS[agentId];
  const configDir = agent.configDir;
  const versionsDir = getVersionsDir();
  const versionHome = path.join(versionsDir, agentId, version, 'home');
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

export function finalizeImport(agentId: AgentId, version: string): void {
  setGlobalDefault(agentId, version);
  createShim(agentId);
  createVersionedAlias(agentId, version);
  switchHomeFileSymlinks(agentId, version);
  ensureShimCurrent(agentId);
}

interface AgentBinarySpec {
  agentId: string;
  npmPackage: string;
  cliCommand: string;
}

export function importAgentBinary(
  spec: AgentBinarySpec,
  version: string,
  globalPath: string,
  versionDir: string
): ImportBinaryResult {
  const binaryLink = path.join(versionDir, 'node_modules', '.bin', spec.cliCommand);

  // lstat keeps dangling install links visible; multi-bin packages select the exact CLI key.
  let alreadyExists = false;
  try {
    fs.lstatSync(binaryLink);
    alreadyExists = true;
  } catch {
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

export function resolvePackageDirFromBinary(binaryPath: string): string | null {
  try {
    let real = fs.realpathSync(binaryPath);
    let dir = path.dirname(real);

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

export function seedIsolatedConfigFromLocal(
  agentId: AgentId,
  version: string,
  opts: { withAuth?: boolean; all?: boolean } = {},
): { seeded: boolean; from: string; to: string; skippedAuth: string[]; skippedRuntime: string[]; error?: string } {
  // Seeding copies rather than adopts: auth/runtime stay excluded by default, destination links are followed, overwrite is forced, and links into ~/.agents are rejected.
  const agent = AGENTS[agentId];
  const configDir = agent.configDir;
  const versionHome = path.join(getVersionsDir(), agentId, version, 'home');
  let dest = path.join(versionHome, path.relative(os.homedir(), configDir));
  try {
    if (fs.lstatSync(dest).isSymbolicLink()) dest = fs.realpathSync(dest);
  } catch {
  }
  const result = { seeded: false, from: configDir, to: dest, skippedAuth: [] as string[], skippedRuntime: [] as string[] };

  if (!fs.existsSync(configDir)) return result;

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
      force: true,
      filter: (src) => {
        const rel = path.relative(configDir, src);
        if (!opts.withAuth && rel && (authRel.has(rel) || rel.startsWith('credentials' + path.sep))) {
          result.skippedAuth.push(rel);
          return false;
        }
        if (rel && isRuntime(rel)) {
          const top = rel.split(path.sep)[0];
          if (!result.skippedRuntime.includes(top)) result.skippedRuntime.push(top);
          return false;
        }
        try {
          const st = fs.lstatSync(src);
          if (st.isSymbolicLink()) {
            const tgt = path.resolve(path.dirname(src), fs.readlinkSync(src));
            if (tgt === agentsDir || tgt.startsWith(inside)) return false;
          }
        } catch {  }
        return true;
      },
    });
    result.seeded = true;
  } catch (err) {
    return { ...result, error: (err as Error).message };
  }
  return result;
}
