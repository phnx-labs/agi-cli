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

export type ConfigAction =
  | { agent: AgentId; realPath: string; kind: 'restore-backup'; source: string }
  | { agent: AgentId; realPath: string; kind: 'restore-version-home'; source: string }
  | { agent: AgentId; realPath: string; kind: 'remove-dangling' }
  | { agent: AgentId; realPath: string; kind: 'leave-real' }
  | { agent: AgentId; realPath: string; kind: 'leave-foreign' }
  | { agent: AgentId; realPath: string; kind: 'absent' };

export interface HomeFileAction {
  realPath: string;
  source: string;
}

export interface UninstallPlan {
  isInstalled: boolean;
  agentsDir: string;
  legacySymlink: string | null;
  configs: ConfigAction[];
  homeFiles: HomeFileAction[];
  launchers: string[];
  rcFiles: string[];
}

export interface UninstallResult {
  restoredConfigs: Array<{ agent: AgentId; realPath: string }>;
  removedDanglingConfigs: Array<{ agent: AgentId; realPath: string }>;
  restoredHomeFiles: string[];
  releasedLaunchers: string[];
  cleanedRcFiles: string[];
  agentsDir: { path: string; disposition: 'moved' | 'purged' | 'absent'; movedTo?: string };
  legacySymlinkRemoved: boolean;
  purgeDowngraded: boolean;
  errors: string[];
}

function realHome(): string {
  return process.env.AGENTS_REAL_HOME || os.homedir();
}

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

function symlinkTarget(p: string): string | null {
  try {
    const raw = fs.readlinkSync(p);
    return path.resolve(path.dirname(p), raw);
  } catch {
    return null;
  }
}

function removeLink(p: string): void {
  // unlinkSync removes POSIX links and Windows junctions without following targets; rmSync EFAULTs on reparse points.
  fs.unlinkSync(p);
}

function planConfig(agent: AgentId): ConfigAction {
  // Touch only agents-cli-owned symlinks; real directories and foreign links are user state.
  const realPath = getAgentConfigPath(agent);
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(realPath);
  } catch {
    return { agent, realPath, kind: 'absent' };
  }
  if (!stat.isSymbolicLink()) return { agent, realPath, kind: 'leave-real' };
  if (getConfigSymlinkVersion(agent) === null) return { agent, realPath, kind: 'leave-foreign' };

  const backup = newestBackupDir(agent);
  if (backup) return { agent, realPath, kind: 'restore-backup', source: backup };
  const target = symlinkTarget(realPath);
  if (target && fs.existsSync(target)) {
    return { agent, realPath, kind: 'restore-version-home', source: target };
  }
  return { agent, realPath, kind: 'remove-dangling' };
}

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
      if (target && target.startsWith(userDir + path.sep) && fs.existsSync(target)) {
        out.push({ realPath, source: target });
      }
    }
  }
  return out;
}

function planLaunchers(): string[] {
  const dir = path.join(getHistoryDir(), 'adopted-launchers');
  try {
    return fs.readdirSync(dir).filter((n) => !n.startsWith('.'));
  } catch {
    return [];
  }
}

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

export function planUninstall(): UninstallPlan {
  const agentsDir = getUserAgentsDir();
  const legacy = getLegacySystemAgentsDir();
  let legacySymlink: string | null = null;
  try {
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

  // Restore configs and home files before disposing ~/.agents, where their backups and targets live.
  for (const c of plan.configs) {
    try {
      if (c.kind === 'restore-backup') {
        removeLink(c.realPath);
        moveDirCrossDevice(c.source, c.realPath);
        result.restoredConfigs.push({ agent: c.agent, realPath: c.realPath });
      } else if (c.kind === 'restore-version-home') {
        removeLink(c.realPath);
        copyDirStrippingAgentsSymlinks(c.source, c.realPath, plan.agentsDir);
        result.restoredConfigs.push({ agent: c.agent, realPath: c.realPath });
      } else if (c.kind === 'remove-dangling') {
        removeLink(c.realPath);
        result.removedDanglingConfigs.push({ agent: c.agent, realPath: c.realPath });
      }
    } catch (err) {
      result.errors.push(`config ${c.agent} (${c.realPath}): ${(err as Error).message}`);
    }
  }

  for (const hf of plan.homeFiles) {
    try {
      removeLink(hf.realPath);
      fs.cpSync(hf.source, hf.realPath, { recursive: true });
      result.restoredHomeFiles.push(hf.realPath);
    } catch (err) {
      result.errors.push(`home file ${hf.realPath}: ${(err as Error).message}`);
    }
  }

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

  try {
    removeGhOverloadShim();
  } catch (err) {
    result.errors.push(`gh overload shim: ${(err as Error).message}`);
  }

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

  if (plan.legacySymlink) {
    try {
      removeLink(plan.legacySymlink);
      result.legacySymlinkRemoved = true;
    } catch (err) {
      result.errors.push(`legacy ${plan.legacySymlink}: ${(err as Error).message}`);
    }
  }

  // Disposal defaults to recoverable move-aside; any earlier error downgrades --purge to preserve the only copy.
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
