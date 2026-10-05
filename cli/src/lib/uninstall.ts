/** Complete teardown, the reverse of `agents setup`: restore the real `~/.<agent>` dirs that
 * adoption symlinked, release launchers, strip PATH lines, dispose of `~/.agents`. A `~/.<agent>`
 * never adopted is a real user dir and is never touched (`getConfigSymlinkVersion`). */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { AGENTS, ALL_AGENT_IDS } from './agents.js';
import type { AgentId } from './types.js';
import {
  getAgentConfigPath,
  getConfigSymlinkVersion,
  stripShimPathLines,
  releaseAdoptedLauncher,
  removeGhOverloadShim,
} from './installations/shims.js';
import { moveDirCrossDevice, copyDirStrippingAgentsSymlinks } from './config-transfer.js';
import {
  getUserAgentsDir,
  getBackupsDir,
  getHistoryDir,
  getShimsDir,
  getLegacySystemAgentsDir,
} from './state.js';

/** What the uninstall intends to do with one agent's config directory. */
export type ConfigAction =
  | { agent: AgentId; realPath: string; kind: 'restore-backup'; source: string }
  | { agent: AgentId; realPath: string; kind: 'restore-version-home'; source: string }
  | { agent: AgentId; realPath: string; kind: 'remove-dangling' }
  | { agent: AgentId; realPath: string; kind: 'leave-real' }
  | { agent: AgentId; realPath: string; kind: 'leave-foreign' }
  | { agent: AgentId; realPath: string; kind: 'absent' };

/** A home-level file symlink (e.g. `~/.claude.json`) agents-cli owns. */
export interface HomeFileAction {
  realPath: string;
  /** Resolved symlink target whose contents are copied back to `realPath`. */
  source: string;
}

/** The full, read-only plan describing what an uninstall would change. */
export interface UninstallPlan {
  isInstalled: boolean;
  agentsDir: string;
  legacySymlink: string | null;
  configs: ConfigAction[];
  homeFiles: HomeFileAction[];
  launchers: string[];
  rcFiles: string[];
}

/** Structured result of an executed uninstall (for reporting). */
export interface UninstallResult {
  restoredConfigs: Array<{ agent: AgentId; realPath: string }>;
  removedDanglingConfigs: Array<{ agent: AgentId; realPath: string }>;
  restoredHomeFiles: string[];
  releasedLaunchers: string[];
  cleanedRcFiles: string[];
  agentsDir: { path: string; disposition: 'moved' | 'purged' | 'absent'; movedTo?: string };
  legacySymlinkRemoved: boolean;
  /** True when `--purge` was requested but downgraded to move-aside after errors. */
  purgeDowngraded: boolean;
  errors: string[];
}

/** Home dir honoring the AGENTS_REAL_HOME test/override, mirroring shims.ts. */
function realHome(): string {
  return process.env.AGENTS_REAL_HOME || os.homedir();
}

/** Newest timestamped backup dir under `<backups>/<agent>/`, or null. */
function newestBackupDir(agent: AgentId): string | null {
  const dir = path.join(getBackupsDir(), agent);
  let entries: string[];
  try {
    entries = fs.readdirSync(dir).filter((n) => /^\d+$/.test(n));
  } catch {
    return null;
  }
  if (entries.length === 0) return null;
  entries.sort((a, b) => Number(a) - Number(b));
  return path.join(dir, entries[entries.length - 1]);
}

/** Absolute target of a symlink, or null if `p` is not a readable symlink. */
function symlinkTarget(p: string): string | null {
  try {
    const raw = fs.readlinkSync(p);
    return path.resolve(path.dirname(p), raw);
  } catch {
    return null;
  }
}

/** Remove a symlink/junction without following it: `unlinkSync` works on POSIX and Windows
 * junctions, while `fs.rmSync` throws EFAULT on a Windows reparse point. */
function removeLink(p: string): void {
  fs.unlinkSync(p);
}

/** Classify one agent's config dir without mutating anything. */
function planConfig(agent: AgentId): ConfigAction {
  const realPath = getAgentConfigPath(agent);
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(realPath);
  } catch {
    return { agent, realPath, kind: 'absent' };
  }
  // A real directory means agents-cli never adopted it — leave it alone.
  if (!stat.isSymbolicLink()) return { agent, realPath, kind: 'leave-real' };
  // A symlink we don't own (target not under our versions dir) — leave it alone.
  if (getConfigSymlinkVersion(agent) === null) return { agent, realPath, kind: 'leave-foreign' };

  // Owned symlink: prefer the timestamped backup (switchConfigSymlink moved the
  // real dir there); otherwise the symlink target itself holds the user's data
  // (importAgent renamed the real dir INTO the version home).
  const backup = newestBackupDir(agent);
  if (backup) return { agent, realPath, kind: 'restore-backup', source: backup };
  const target = symlinkTarget(realPath);
  if (target && fs.existsSync(target)) {
    return { agent, realPath, kind: 'restore-version-home', source: target };
  }
  return { agent, realPath, kind: 'remove-dangling' };
}

/** Owned home-file symlinks (e.g. `~/.claude.json`) to copy back as real files. */
function planHomeFiles(): HomeFileAction[] {
  const home = realHome();
  const userDir = getUserAgentsDir();
  const out: HomeFileAction[] = [];
  for (const agent of ALL_AGENT_IDS) {
    const homeFiles = AGENTS[agent].homeFiles;
    if (!homeFiles) continue;
    for (const fileName of homeFiles) {
      const realPath = path.join(home, fileName);
      let stat: fs.Stats;
      try {
        stat = fs.lstatSync(realPath);
      } catch {
        continue;
      }
      if (!stat.isSymbolicLink()) continue;
      const target = symlinkTarget(realPath);
      // Only ours (points into ~/.agents) and only if the target still exists.
      if (target && target.startsWith(userDir + path.sep) && fs.existsSync(target)) {
        out.push({ realPath, source: target });
      }
    }
  }
  return out;
}

/** cliCommand basenames that have an adopted-launcher record to release. */
function planLaunchers(): string[] {
  const dir = path.join(getHistoryDir(), 'adopted-launchers');
  try {
    return fs.readdirSync(dir).filter((n) => !n.startsWith('.'));
  } catch {
    return [];
  }
}

/** Candidate shell rc files that currently contain a shim PATH entry. */
function planRcFiles(): string[] {
  const home = realHome();
  const shimsDir = getShimsDir();
  const candidates = ['.zshrc', '.bashrc', '.bash_profile', '.profile', path.join('.config', 'fish', 'config.fish')];
  const out: string[] = [];
  for (const rel of candidates) {
    const rc = path.join(home, rel);
    let content: string;
    try {
      content = fs.readFileSync(rc, 'utf-8');
    } catch {
      continue;
    }
    if (stripShimPathLines(content, shimsDir) !== content) out.push(rc);
  }
  return out;
}

/** Build a read-only plan of everything an uninstall would change; no mutations, safe for
 * `--dry-run`. */
export function planUninstall(): UninstallPlan {
  const agentsDir = getUserAgentsDir();
  const legacy = getLegacySystemAgentsDir();
  let legacySymlink: string | null = null;
  try {
    // Only claim it if it's actually a link (symlink on POSIX, junction on Windows —
    // both report isSymbolicLink()); a real directory here is left alone so removeLink
    // (unlinkSync) is always the correct primitive for what we captured.
    if (fs.lstatSync(legacy).isSymbolicLink()) legacySymlink = legacy;
  } catch {
    legacySymlink = null;
  }
  return {
    isInstalled: fs.existsSync(agentsDir),
    agentsDir,
    legacySymlink,
    configs: ALL_AGENT_IDS.map(planConfig),
    homeFiles: planHomeFiles(),
    launchers: planLaunchers(),
    rcFiles: planRcFiles(),
  };
}

/** Execute a plan: restore config dirs, release launchers, strip PATH lines, then move `~/.agents`
 * aside (or delete with `purge`). Restore runs first because backups live in `~/.agents`. */
export function executeUninstall(plan: UninstallPlan, opts: { purge?: boolean; timestamp: number }): UninstallResult {
  const result: UninstallResult = {
    restoredConfigs: [],
    removedDanglingConfigs: [],
    restoredHomeFiles: [],
    releasedLaunchers: [],
    cleanedRcFiles: [],
    agentsDir: { path: plan.agentsDir, disposition: 'absent' },
    legacySymlinkRemoved: false,
    purgeDowngraded: false,
    errors: [],
  };

  // 1. Restore adopted config directories (reads backups inside ~/.agents).
  for (const c of plan.configs) {
    try {
      if (c.kind === 'restore-backup') {
        // Drop the adopted link (no data; the real dir is the backup), then move the backup out of
        // ~/.agents, EXDEV-safe. `unlinkSync` not `rmSync`: EFAULT on a Windows reparse point.
        removeLink(c.realPath);
        moveDirCrossDevice(c.source, c.realPath);
        result.restoredConfigs.push({ agent: c.agent, realPath: c.realPath });
      } else if (c.kind === 'restore-version-home') {
        // importAgent renamed the real dir INTO the version home; copy it back
        // (step 6 disposes the original) while stripping resource symlinks that
        // would dangle once ~/.agents is gone.
        removeLink(c.realPath);
        copyDirStrippingAgentsSymlinks(c.source, c.realPath, plan.agentsDir);
        result.restoredConfigs.push({ agent: c.agent, realPath: c.realPath });
      } else if (c.kind === 'remove-dangling') {
        removeLink(c.realPath);
        result.removedDanglingConfigs.push({ agent: c.agent, realPath: c.realPath });
      }
      // leave-real / leave-foreign / absent: intentionally untouched.
    } catch (err) {
      result.errors.push(`config ${c.agent} (${c.realPath}): ${(err as Error).message}`);
    }
  }

  // 2. Restore owned home-file symlinks as real files (e.g. ~/.claude.json).
  for (const hf of plan.homeFiles) {
    try {
      removeLink(hf.realPath);
      fs.cpSync(hf.source, hf.realPath, { recursive: true });
      result.restoredHomeFiles.push(hf.realPath);
    } catch (err) {
      result.errors.push(`home file ${hf.realPath}: ${(err as Error).message}`);
    }
  }

  // 3. Release adopted launchers (reads records inside ~/.agents).
  const byCli = new Map(ALL_AGENT_IDS.map((a) => [AGENTS[a].cliCommand, a]));
  for (const cli of plan.launchers) {
    const agent = byCli.get(cli);
    if (!agent) continue;
    try {
      releaseAdoptedLauncher(agent);
      result.releasedLaunchers.push(cli);
    } catch (err) {
      result.errors.push(`launcher ${cli}: ${(err as Error).message}`);
    }
  }

  // 3b. Remove the gh overload shim explicitly, so a real gh returns even if the
  // shims dir itself is left in place. (The shim self-heals to real gh regardless,
  // but leaving no orphan is cleaner — PHNX-3501.)
  try {
    removeGhOverloadShim();
  } catch (err) {
    result.errors.push(`gh overload shim: ${(err as Error).message}`);
  }

  // 4. Strip the shim directory from the user's PATH across all rc files.
  const shimsDir = getShimsDir();
  for (const rc of plan.rcFiles) {
    try {
      const content = fs.readFileSync(rc, 'utf-8');
      fs.writeFileSync(rc, stripShimPathLines(content, shimsDir));
      result.cleanedRcFiles.push(rc);
    } catch (err) {
      result.errors.push(`rc file ${rc}: ${(err as Error).message}`);
    }
  }

  // Remove the legacy `~/.agents-system` link (a junction on Windows) via removeLink; rmSync throws
  // EFAULT there.
  if (plan.legacySymlink) {
    try {
      removeLink(plan.legacySymlink);
      result.legacySymlinkRemoved = true;
    } catch (err) {
      result.errors.push(`legacy ${plan.legacySymlink}: ${(err as Error).message}`);
    }
  }

  // 6. Dispose of ~/.agents LAST (its backups fed step 1). If any restore above
  // failed, downgrade a --purge to a recoverable move-aside: a swallowed restore
  // error must never let the hard-delete take the user's only copy with it.
  if (fs.existsSync(plan.agentsDir)) {
    const purge = !!opts.purge && result.errors.length === 0;
    if (opts.purge && !purge) result.purgeDowngraded = true;
    try {
      if (purge) {
        fs.rmSync(plan.agentsDir, { recursive: true, force: true });
        result.agentsDir = { path: plan.agentsDir, disposition: 'purged' };
      } else {
        const movedTo = `${plan.agentsDir}.removed-${opts.timestamp}`;
        fs.renameSync(plan.agentsDir, movedTo);
        result.agentsDir = { path: plan.agentsDir, disposition: 'moved', movedTo };
      }
    } catch (err) {
      result.errors.push(`dispose ${plan.agentsDir}: ${(err as Error).message}`);
    }
  }

  return result;
}
