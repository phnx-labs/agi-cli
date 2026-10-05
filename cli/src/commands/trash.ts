/** `agents trash`: list and restore soft-deleted version dirs. `removeVersion` moves them to
 * ~/.agents/.history/trash/versions/<agent>/<version>/<timestamp>/ instead of deleting; the trash
 * never auto-expires. */
import type { Command } from 'commander';
import chalk from 'chalk';
import * as fs from 'fs';
import * as path from 'path';

import type { AgentId } from '../lib/types.js';
import { resolveAgentName, agentLabel } from '../lib/agents.js';
import { getTrashVersionsDir } from '../lib/state.js';
import { getVersionDir } from '../lib/installations/versions.js';

interface TrashEntry {
  agent: AgentId;
  version: string;
  stamp: string;
  trashPath: string;
}

function listTrashEntries(filterAgent?: AgentId): TrashEntry[] {
  const root = getTrashVersionsDir();
  if (!fs.existsSync(root)) return [];
  const out: TrashEntry[] = [];

  let agentDirs: fs.Dirent[];
  try {
    agentDirs = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }

  for (const agentEntry of agentDirs) {
    if (!agentEntry.isDirectory()) continue;
    const agent = resolveAgentName(agentEntry.name);
    if (!agent) continue;
    if (filterAgent && agent !== filterAgent) continue;
    const agentDir = path.join(root, agentEntry.name);

    let versionDirs: fs.Dirent[];
    try {
      versionDirs = fs.readdirSync(agentDir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const ver of versionDirs) {
      if (!ver.isDirectory()) continue;
      const versionDir = path.join(agentDir, ver.name);

      let stampDirs: fs.Dirent[];
      try {
        stampDirs = fs.readdirSync(versionDir, { withFileTypes: true });
      } catch {
        continue;
      }

      for (const stamp of stampDirs) {
        if (!stamp.isDirectory()) continue;
        out.push({
          agent,
          version: ver.name,
          stamp: stamp.name,
          trashPath: path.join(versionDir, stamp.name),
        });
      }
    }
  }
  return out.sort((a, b) => a.stamp.localeCompare(b.stamp)).reverse();
}

function pickLatest(entries: TrashEntry[], agent: AgentId, version: string): TrashEntry | null {
  const matches = entries.filter((e) => e.agent === agent && e.version === version);
  if (matches.length === 0) return null;
  return matches[0];
}

function parseAgentVersion(target: string): { agent: AgentId; version: string } | null {
  const at = target.indexOf('@');
  if (at < 1 || at === target.length - 1) return null;
  const agent = resolveAgentName(target.slice(0, at));
  if (!agent) return null;
  return { agent, version: target.slice(at + 1) };
}

function dirSizeBytes(dir: string): number {
  let total = 0;
  const stack: string[] = [dir];
  while (stack.length > 0) {
    const cur = stack.pop()!;
    let stat: fs.Stats;
    try { stat = fs.lstatSync(cur); } catch { continue; }
    if (stat.isDirectory()) {
      let entries: string[];
      try { entries = fs.readdirSync(cur); } catch { continue; }
      for (const e of entries) stack.push(path.join(cur, e));
    } else {
      total += stat.size;
    }
  }
  return total;
}

function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

/** Restore a soft-deleted version into ~/.agents/.history/versions/, backing the top-level `agents
 * restore`. Exits non-zero on any failure. */
export function restoreVersion(target: string): void {
  const parsed = parseAgentVersion(target);
  if (!parsed) {
    console.error(chalk.red(`Expected <agent>@<version>, got: ${target}`));
    process.exit(1);
  }
  const { agent, version } = parsed;
  const entries = listTrashEntries(agent);
  const entry = pickLatest(entries, agent, version);
  if (!entry) {
    console.error(chalk.red(`No trashed copy found for ${agent}@${version}`));
    console.error(chalk.gray('Run `agents trash list` to see what exists.'));
    process.exit(1);
  }
  const dest = getVersionDir(agent, version);
  if (fs.existsSync(dest)) {
    console.error(chalk.red(`Cannot restore: ${dest} already exists.`));
    console.error(chalk.gray('Move or remove the existing dir first, then re-run restore.'));
    process.exit(1);
  }
  try {
    fs.mkdirSync(path.dirname(dest), { recursive: true, mode: 0o700 });
    fs.renameSync(entry.trashPath, dest);
  } catch (err) {
    console.error(chalk.red(`Restore failed: ${(err as Error).message}`));
    process.exit(1);
  }
  // Best-effort cleanup of empty stamp/version parents in trash.
  try {
    const verDir = path.dirname(entry.trashPath);
    if (fs.readdirSync(verDir).length === 0) fs.rmdirSync(verDir);
    const agentDir = path.dirname(verDir);
    if (fs.readdirSync(agentDir).length === 0) fs.rmdirSync(agentDir);
  } catch { /* best-effort */ }
  console.log(chalk.green(`Restored ${agentLabel(agent)}@${version} to ${dest}`));
}

/**
 * Register the top-level `agents restore` command — a shorthand for
 * `agents restore` so users can undo a `remove`/`prune` directly.
 */
export function registerRestoreCommand(program: Command): void {
  program
    .command('restore <target>')
    .description('Restore a soft-deleted agent version (e.g. "codex@0.141.0") removed via prune/remove')
    .action((target: string) => restoreVersion(target));
}

export function registerTrashCommands(program: Command): void {
  const trash = program
    .command('trash')
    .description('Inspect and restore soft-deleted agent version directories');

  trash
    .command('list [agent]')
    .description('List soft-deleted version directories (optionally filtered to one agent)')
    .action((agentArg: string | undefined) => {
      let filter: AgentId | undefined;
      if (agentArg) {
        const a = resolveAgentName(agentArg);
        if (!a) {
          console.error(chalk.red(`Unknown agent: ${agentArg}`));
          process.exit(1);
        }
        filter = a;
      }
      const entries = listTrashEntries(filter);
      if (entries.length === 0) {
        console.log(chalk.gray('Trash is empty.'));
        return;
      }
      console.log(chalk.bold(`Soft-deleted versions (${entries.length})`));
      for (const e of entries) {
        const size = humanSize(dirSizeBytes(e.trashPath));
        console.log(
          `  ${agentLabel(e.agent)}@${e.version}  ` +
          chalk.gray(`${e.stamp}  ${size}  ${e.trashPath}`)
        );
      }
      console.log();
      console.log(chalk.gray('Restore with: agents restore <agent>@<version>'));
    });
}
